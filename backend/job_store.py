"""Provider-neutral, persisted generation job store.

One row per generation job in the `generation_jobs` table of the app's SQLite
database (`db.DB_PATH`). The full job snapshot is stored as JSON in `data`;
the columns beside it exist only for filtering and ordering.

Rules enforced here, not by callers:
  - `status` is exactly one of JOB_STATUSES.
  - Terminal states are final. An update to a COMPLETED / FAILED / CANCELLED /
    TIMED_OUT job is ignored and returns the unchanged snapshot, so a worker
    that polls once more after a user cancel cannot resurrect the job.
  - Secrets never reach disk: any `request` key (at any depth) whose name,
    split on camelCase and lowercased with `-`/spaces as `_`, ends in a `key`, `token`, `secret`,
    `authorization` or `password` segment is dropped before storage.

`cost` is the provider-reported charge for a finished task
(`{amount, unit, usd_equivalent}` or null). Rows written before the field
existed are read back with `cost: null`.

Change events (`{"type": "job", "job": <snapshot>}`) are published on every
create / applied update / cancel / recovery, from whatever thread made the
change. Asyncio consumers use `subscribe()` (a per-consumer asyncio.Queue fed
through its loop's call_soon_threadsafe); thread consumers use
`subscribe_callback()`.
"""

from __future__ import annotations

import asyncio
import copy
import json
import math
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Iterable

from backend import db

TABLE = "generation_jobs"

JOB_STATUSES: tuple[str, ...] = ("QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT")
TERMINAL_STATUSES: frozenset[str] = frozenset({"COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"})
ACTIVE_STATUSES: frozenset[str] = frozenset({"QUEUED", "RUNNING"})
JOB_SOURCES: tuple[str, ...] = ("pipeline", "mcp")
OUTPUT_KINDS: frozenset[str] = frozenset({"image", "video", "audio"})

DEFAULT_LIST_LIMIT = 50
MAX_LIST_LIMIT = 500
DEFAULT_QUEUE_SIZE = 200

INTERRUPTED_MESSAGE = (
    "BlockFlow restarted before the provider accepted this job, so it cannot be "
    "resumed. Run it again."
)

# Matched against a normalised name (lowercase, `-` and spaces -> `_`): the
# LAST segment must be a secret word, so `api_key` / `x-api-key` /
# `Authorization` go while `keyframe_urls` / `max_tokens` / `secretary` stay.
_SECRET_KEY_RE = re.compile(r"(^|_)(key|token|secret|authorization|password)$")
_NAME_SEPARATORS_RE = re.compile(r"[-\s]")
_CAMEL_ACRONYM_RE = re.compile(r"([A-Z]+)([A-Z][a-z])")  # XApiKey -> X_ApiKey
_CAMEL_WORD_RE = re.compile(r"([a-z0-9])([A-Z])")         # apiKey -> api_Key


def _is_secret_name(name: str) -> bool:
    name = _CAMEL_WORD_RE.sub(r"\1_\2", _CAMEL_ACRONYM_RE.sub(r"\1_\2", name))
    return bool(_SECRET_KEY_RE.search(_NAME_SEPARATORS_RE.sub("_", name.lower())))

# Fields a caller may change through update_job. Everything else is either
# immutable (job_id, source, created_at) or managed by the store
# (updated_at, completed_at, cancel_requested).
_UPDATABLE_FIELDS = frozenset({
    "status", "provider", "model", "mode", "remote_job_id", "remote_status",
    "progress", "message", "error", "outputs", "request", "cost", "price_check",
})

Event = dict[str, Any]


class JobNotFoundError(KeyError):
    """Raised when an operation names a job id the store does not hold."""


# ------------------------------------------------------------------ validation


def strip_secrets(value: Any) -> Any:
    """Return a deep copy of `value` with every secret-named dict key removed."""
    if isinstance(value, dict):
        return {
            k: strip_secrets(v)
            for k, v in value.items()
            if not (isinstance(k, str) and _is_secret_name(k))
        }
    if isinstance(value, (list, tuple)):
        return [strip_secrets(v) for v in value]
    return value


def _clean_request(request: Any) -> dict[str, Any]:
    if request is None:
        return {}
    if not isinstance(request, dict):
        raise ValueError("request must be a JSON object")
    cleaned = strip_secrets(request)
    try:
        json.dumps(cleaned, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"request is not JSON-serialisable: {exc}") from exc
    return cleaned


def _check_status(status: Any) -> str:
    if status not in JOB_STATUSES:
        raise ValueError(f"invalid job status {status!r}; expected one of {', '.join(JOB_STATUSES)}")
    return status


def _check_source(source: Any) -> str:
    if source not in JOB_SOURCES:
        raise ValueError(f"invalid job source {source!r}; expected one of {', '.join(JOB_SOURCES)}")
    return source


def _check_text(name: str, value: Any, *, required: bool) -> str | None:
    if value is None and not required:
        return None
    if not isinstance(value, str) or (required and not value.strip()):
        raise ValueError(f"{name} must be a non-empty string" if required else f"{name} must be a string")
    return value


def _check_progress(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("progress must be a number between 0 and 1, or null")
    value = float(value)
    if math.isnan(value) or not 0.0 <= value <= 1.0:
        raise ValueError("progress must be between 0 and 1")
    return value


def _check_error(value: Any) -> dict[str, str] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("error must be an object {kind, message} or null")
    kind, message = value.get("kind"), value.get("message")
    if not isinstance(kind, str) or not kind or not isinstance(message, str):
        raise ValueError("error needs a string `kind` and a string `message`")
    return {"kind": kind, "message": message}


def _check_outputs(value: Any) -> list[dict[str, str]]:
    if value is None:
        return []
    if not isinstance(value, (list, tuple)):
        raise ValueError("outputs must be a list")
    cleaned: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("each output must be an object {kind, url, local_url?}")
        kind, url, local_url = item.get("kind"), item.get("url"), item.get("local_url")
        if kind not in OUTPUT_KINDS:
            raise ValueError(f"output kind must be one of {sorted(OUTPUT_KINDS)}, got {kind!r}")
        if not isinstance(url, str) or not url:
            raise ValueError("output url must be a non-empty string")
        out = {"kind": kind, "url": url}
        if local_url is not None:
            if not isinstance(local_url, str):
                raise ValueError("output local_url must be a string")
            out["local_url"] = local_url
        cleaned.append(out)
    return cleaned


def _check_cost(value: Any) -> dict[str, Any] | None:
    """The provider-reported charge: ``{amount, unit, usd_equivalent}`` or None.
    ``amount`` is a finite number >= 0 in the provider's own ``unit``;
    ``usd_equivalent`` is a finite number or None (conversion not documented)."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("cost must be an object {amount, unit, usd_equivalent} or null")

    def number(name: str, v: Any, optional: bool) -> float | None:
        if v is None and optional:
            return None
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)) or v < 0:
            raise ValueError(f"cost.{name} must be a finite number >= 0")
        return float(v)

    unit = value.get("unit")
    if not isinstance(unit, str) or not unit.strip():
        raise ValueError("cost.unit must be a non-empty string")
    return {"amount": number("amount", value.get("amount"), False), "unit": unit,
            "usd_equivalent": number("usd_equivalent", value.get("usd_equivalent"), True)}


_PRICE_CHECK_FIELDS = {"expected", "actual", "source", "differs", "checked_at", "report_url"}


def _check_price_check(value: Any) -> dict[str, Any] | None:
    """``{expected, actual, source, differs, checked_at, report_url}`` or None
    (see backend/byok/learned_prices.py)."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != _PRICE_CHECK_FIELDS:
        raise ValueError(f"price_check must be an object with exactly {', '.join(sorted(_PRICE_CHECK_FIELDS))}")
    for side in ("expected", "actual"):
        part = value[side]
        amount = part.get("amount") if isinstance(part, dict) else None
        if (not isinstance(part, dict) or set(part) != {"amount", "unit"} or isinstance(amount, bool)
                or not isinstance(amount, (int, float)) or not math.isfinite(float(amount))
                or not isinstance(part.get("unit"), str)):
            raise ValueError(f"price_check.{side} must be {{amount, unit}}")
    if value["source"] not in ("ledger", "bundled") or not isinstance(value["differs"], bool):
        raise ValueError("price_check.source must be ledger|bundled and differs a boolean")
    if not isinstance(value["checked_at"], str):
        raise ValueError("price_check.checked_at must be a string")
    url = value["report_url"]
    if url is not None and (not isinstance(url, str) or not url.startswith("https://github.com/")):
        raise ValueError("price_check.report_url must be null or a github.com link")
    return copy.deepcopy(value)


def _normalise(job: dict[str, Any]) -> dict[str, Any]:
    """Fill fields added after a row was written (rows are JSON snapshots, so
    the "migration" for older databases happens on read)."""
    job.setdefault("cost", None)
    job.setdefault("price_check", None)
    return job


_VALIDATORS: dict[str, Callable[[Any], Any]] = {
    "status": _check_status,
    "provider": lambda v: _check_text("provider", v, required=True),
    "model": lambda v: _check_text("model", v, required=True),
    "mode": lambda v: _check_text("mode", v, required=False),
    "remote_job_id": lambda v: _check_text("remote_job_id", v, required=False),
    "remote_status": lambda v: _check_text("remote_status", v, required=False),
    "message": lambda v: _check_text("message", v, required=False),
    "progress": _check_progress,
    "error": _check_error,
    "outputs": _check_outputs,
    "request": _clean_request,
    "cost": _check_cost,
    "price_check": _check_price_check,
}


def _offer(queue: asyncio.Queue, event: Event) -> None:
    """Put without blocking; a full queue drops its oldest event first."""
    while True:
        try:
            queue.put_nowait(event)
            return
        except asyncio.QueueFull:
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:  # pragma: no cover - maxsize 0 is unbounded
                return


# ------------------------------------------------------------------ store


class JobStore:
    """Thread-safe job store bound to one SQLite file."""

    def __init__(self, db_path: Path | str) -> None:
        self.db_path = Path(db_path)
        self._lock = threading.RLock()
        self._async_subs: dict[asyncio.Queue, asyncio.AbstractEventLoop] = {}
        self._callbacks: dict[int, Callable[[Event], None]] = {}
        self._next_callback_id = 0
        self._subs_lock = threading.Lock()
        self._init_table()

    # -------------------------------------------------------------- sqlite

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=10, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_table(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            conn = self._connect()
            try:
                conn.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS {TABLE} (
                        job_id TEXT PRIMARY KEY,
                        source TEXT NOT NULL,
                        status TEXT NOT NULL,
                        remote_job_id TEXT,
                        created_at REAL NOT NULL,
                        updated_at REAL NOT NULL,
                        data TEXT NOT NULL
                    )
                    """
                )
                conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{TABLE}_created ON {TABLE} (created_at)")
                conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{TABLE}_status ON {TABLE} (status)")
                conn.commit()
            finally:
                conn.close()

    @staticmethod
    def _write(conn: sqlite3.Connection, job: dict[str, Any], *, insert: bool) -> None:
        row = (
            job["source"], job["status"], job["remote_job_id"], job["created_at"],
            job["updated_at"], json.dumps(job, ensure_ascii=False, allow_nan=False), job["job_id"],
        )
        if insert:
            conn.execute(
                f"INSERT INTO {TABLE} (source, status, remote_job_id, created_at, updated_at, data, job_id)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                row,
            )
        else:
            conn.execute(
                f"UPDATE {TABLE} SET source = ?, status = ?, remote_job_id = ?, created_at = ?,"
                " updated_at = ?, data = ? WHERE job_id = ?",
                row,
            )

    @staticmethod
    def _read(conn: sqlite3.Connection, job_id: str) -> dict[str, Any] | None:
        row = conn.execute(f"SELECT data FROM {TABLE} WHERE job_id = ?", (job_id,)).fetchone()
        return _normalise(json.loads(row["data"])) if row else None

    def _mutate(self, job_id: str, change: Callable[[dict[str, Any]], bool]) -> dict[str, Any]:
        """Read-modify-write one job under the lock. `change` edits the job in
        place and returns True if it should be saved and published."""
        with self._lock:
            conn = self._connect()
            try:
                conn.execute("BEGIN IMMEDIATE")
                job = self._read(conn, job_id)
                if job is None:
                    conn.rollback()
                    raise JobNotFoundError(job_id)
                if not change(job):
                    conn.rollback()
                    return job
                job["updated_at"] = time.time()
                if job["status"] in TERMINAL_STATUSES and job.get("completed_at") is None:
                    job["completed_at"] = job["updated_at"]
                self._write(conn, job, insert=False)
                conn.commit()
            finally:
                conn.close()
            self._publish(job)
            return job

    # -------------------------------------------------------------- public API

    def create_job(
        self,
        *,
        source: str,
        provider: str,
        model: str,
        mode: str | None = None,
        request: dict[str, Any] | None = None,
        job_id: str | None = None,
        status: str = "QUEUED",
        remote_job_id: str | None = None,
        message: str | None = None,
    ) -> dict[str, Any]:
        """Persist a new job and publish it. Raises ValueError on bad input or
        a duplicate `job_id`."""
        _check_source(source)
        if _check_status(status) not in ACTIVE_STATUSES:
            raise ValueError("a new job must start QUEUED or RUNNING")
        now = time.time()
        job: dict[str, Any] = {
            "job_id": _check_text("job_id", job_id, required=True) if job_id is not None else uuid.uuid4().hex,
            "source": source,
            "provider": _VALIDATORS["provider"](provider),
            "model": _VALIDATORS["model"](model),
            "mode": _VALIDATORS["mode"](mode),
            "status": status,
            "remote_job_id": _VALIDATORS["remote_job_id"](remote_job_id),
            "remote_status": None,
            "progress": None,
            "message": _VALIDATORS["message"](message),
            "error": None,
            "outputs": [],
            "request": _clean_request(request),
            "created_at": now,
            "updated_at": now,
            "completed_at": None,
            "cancel_requested": False,
            "cost": None,
            "price_check": None,
        }
        with self._lock:
            conn = self._connect()
            try:
                self._write(conn, job, insert=True)
                conn.commit()
            except sqlite3.IntegrityError as exc:
                raise ValueError(f"job {job['job_id']!r} already exists") from exc
            finally:
                conn.close()
            self._publish(job)
        return copy.deepcopy(job)

    def update_job(self, job_id: str, /, **fields: Any) -> dict[str, Any]:
        """Apply `fields` and return the new snapshot.

        Raises JobNotFoundError for an unknown id and ValueError for an unknown
        / immutable field or an invalid value (nothing is written then). If the
        job is already terminal the update is ignored and the unchanged
        snapshot is returned; nothing is published.
        """
        unknown = set(fields) - _UPDATABLE_FIELDS
        if unknown:
            raise ValueError(f"cannot update field(s): {', '.join(sorted(unknown))}")
        cleaned = {name: _VALIDATORS[name](value) for name, value in fields.items()}

        def change(job: dict[str, Any]) -> bool:
            if job["status"] in TERMINAL_STATUSES:
                return False
            job.update(cleaned)
            return True

        return self._mutate(job_id, change)

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            conn = self._connect()
            try:
                return self._read(conn, job_id)
            finally:
                conn.close()

    def list_jobs(
        self,
        *,
        source: str | None = None,
        status: str | None = None,
        limit: int = DEFAULT_LIST_LIMIT,
    ) -> list[dict[str, Any]]:
        """Jobs newest first (by created_at, then insertion order)."""
        clauses, params = [], []
        if source is not None:
            clauses.append("source = ?")
            params.append(_check_source(source))
        if status is not None:
            clauses.append("status = ?")
            params.append(_check_status(status))
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
            raise ValueError("limit must be a positive integer")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(min(limit, MAX_LIST_LIMIT))
        return self._select(
            f"SELECT data FROM {TABLE} {where} ORDER BY created_at DESC, rowid DESC LIMIT ?", params,
        )

    def request_cancel(self, job_id: str) -> dict[str, Any]:
        """Flag the job as cancel-requested and move an active job to CANCELLED.

        A terminal job is left untouched (idempotent). The provider worker is
        expected to notice `is_cancel_requested` and cancel the remote task.
        """
        def change(job: dict[str, Any]) -> bool:
            if job["status"] in TERMINAL_STATUSES:
                return False
            job["cancel_requested"] = True
            job["status"] = "CANCELLED"
            job["message"] = "Cancelled"
            return True

        return self._mutate(job_id, change)

    def annotate(
        self,
        job_id: str,
        *,
        message: str | None = None,
        remote_job_id: str | None = None,
    ) -> dict[str, Any]:
        """Set `message` and/or record `remote_job_id` on a job in ANY state,
        terminal included (e.g. explain a cancel, or keep the provider task id
        when a cancel lands while the submit is in flight). Status, outputs and
        timestamps other than updated_at are untouched. `None` leaves a field
        as is; an existing, different remote_job_id is never replaced
        (ValueError). Publishes only when something changed."""
        if message is not None:
            _check_text("message", message, required=False)
        if remote_job_id is not None:
            _check_text("remote_job_id", remote_job_id, required=True)
        current = self.get_job(job_id)
        if current is None:
            raise JobNotFoundError(job_id)
        if remote_job_id is not None and current.get("remote_job_id") not in (None, "", remote_job_id):
            raise ValueError("job already has a different remote_job_id")

        def change(job: dict[str, Any]) -> bool:
            changed = False
            if remote_job_id is not None and job.get("remote_job_id") != remote_job_id:
                if job.get("remote_job_id"):
                    return False  # set concurrently by someone else; keep theirs
                job["remote_job_id"] = remote_job_id
                changed = True
            if message is not None and job.get("message") != message:
                job["message"] = message
                changed = True
            return changed

        return self._mutate(job_id, change)

    def is_cancel_requested(self, job_id: str) -> bool:
        job = self.get_job(job_id)
        return bool(job and job.get("cancel_requested"))

    def list_resumable(self) -> list[dict[str, Any]]:
        """Active jobs the provider already accepted (they have a remote_job_id);
        a polling worker can re-attach to these after a restart."""
        return self._select(
            f"SELECT data FROM {TABLE} WHERE status IN ('QUEUED', 'RUNNING')"
            " AND remote_job_id IS NOT NULL AND remote_job_id != ''"
            " ORDER BY created_at ASC, rowid ASC",
            [],
        )

    def recover_after_restart(self) -> dict[str, list[str]]:
        """Fail active jobs that never reached the provider; report the rest.

        Returns {"failed": [job_id...], "resumable": [job_id...]}.
        """
        stranded = self._select(
            f"SELECT data FROM {TABLE} WHERE status IN ('QUEUED', 'RUNNING')"
            " AND (remote_job_id IS NULL OR remote_job_id = '')",
            [],
        )
        failed: list[str] = []
        for job in stranded:
            def change(j: dict[str, Any]) -> bool:
                if j["status"] in TERMINAL_STATUSES or j.get("remote_job_id"):
                    return False
                j["status"] = "FAILED"
                j["error"] = {"kind": "interrupted", "message": INTERRUPTED_MESSAGE}
                j["message"] = INTERRUPTED_MESSAGE
                return True

            if self._mutate(job["job_id"], change)["status"] == "FAILED":
                failed.append(job["job_id"])
        return {"failed": failed, "resumable": [j["job_id"] for j in self.list_resumable()]}

    def _select(self, sql: str, params: Iterable[Any]) -> list[dict[str, Any]]:
        with self._lock:
            conn = self._connect()
            try:
                return [_normalise(json.loads(r["data"])) for r in conn.execute(sql, list(params)).fetchall()]
            finally:
                conn.close()

    # -------------------------------------------------------------- pub/sub

    def subscribe(self, maxsize: int = DEFAULT_QUEUE_SIZE) -> asyncio.Queue:
        """Register an asyncio consumer on the running loop. Must be called
        from inside that loop; pair with `unsubscribe`."""
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        with self._subs_lock:
            self._async_subs[queue] = loop
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        with self._subs_lock:
            self._async_subs.pop(queue, None)

    def subscribe_callback(self, callback: Callable[[Event], None]) -> Callable[[], None]:
        """Register a synchronous consumer, called on the publishing thread.
        Keep it fast and non-blocking. Returns an unsubscribe function."""
        with self._subs_lock:
            cid = self._next_callback_id
            self._next_callback_id += 1
            self._callbacks[cid] = callback

        def unsubscribe() -> None:
            with self._subs_lock:
                self._callbacks.pop(cid, None)

        return unsubscribe

    def subscriber_count(self) -> int:
        with self._subs_lock:
            return len(self._async_subs) + len(self._callbacks)

    def _publish(self, job: dict[str, Any]) -> None:
        # Called with self._lock held so events for one job keep their order.
        with self._subs_lock:
            async_subs = list(self._async_subs.items())
            callbacks = list(self._callbacks.values())
        for queue, loop in async_subs:
            try:
                loop.call_soon_threadsafe(_offer, queue, {"type": "job", "job": copy.deepcopy(job)})
            except RuntimeError:  # loop closed: the consumer is gone
                self.unsubscribe(queue)
        for callback in callbacks:
            try:
                callback({"type": "job", "job": copy.deepcopy(job)})
            except Exception as exc:
                print(f"[job-store] subscriber callback failed: {exc}", flush=True)


# ------------------------------------------------------------------ default store

_default_store: JobStore | None = None
_default_lock = threading.Lock()


def get_store() -> JobStore:
    """The process-wide store on the app database (`db.DB_PATH`). Rebuilt if
    the path changes, which lets tests point it at tmp_path."""
    global _default_store
    path = Path(db.DB_PATH)
    with _default_lock:
        if _default_store is None or _default_store.db_path != path:
            _default_store = JobStore(path)
        return _default_store
