from __future__ import annotations

import json
import re
import sqlite3
import threading
from collections.abc import Iterable
from datetime import datetime, timezone
from typing import Any

from backend import config

DB_PATH = config.RUN_HISTORY_DB_PATH
_lock = threading.Lock()


def _canon(dt: datetime) -> str:
    """Canonical UTC-Z millisecond ISO string; runs are text-sorted on this."""
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def normalize_created_at(raw: Any) -> str:
    """Normalize a run's created_at to canonical UTC-Z millis, clamped to now.

    The Artifacts list sorts created_at lexicographically, so a future or
    non-canonical value floats an artifact to the top. Parse ISO (Z/offset/
    naive→UTC) or epoch (s/ms); fall back to now on garbage; never allow the
    future.
    """
    now = datetime.now(timezone.utc)
    dt: datetime | None = None
    if isinstance(raw, (int, float)):
        try:
            secs = raw / 1000 if raw > 1e11 else raw   # ms vs s heuristic
            dt = datetime.fromtimestamp(secs, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            dt = None
    elif isinstance(raw, str):
        s = raw.strip()
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            if dt.tzinfo is None:                      # naive → assume UTC
                dt = dt.replace(tzinfo=timezone.utc)
        except ValueError:
            try:                                       # numeric string epoch
                num = float(s)
                secs = num / 1000 if num > 1e11 else num
                dt = datetime.fromtimestamp(secs, tz=timezone.utc)
            except (ValueError, OverflowError, OSError):
                dt = None
    if dt is None or dt > now:
        dt = now
    return _canon(dt)


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _lock:
        conn = _get_conn()
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                status TEXT NOT NULL,
                duration_ms INTEGER,
                flow_snapshot TEXT NOT NULL,
                block_results TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        # Migration: add favorited column if missing
        cols = [row[1] for row in conn.execute("PRAGMA table_info(runs)").fetchall()]
        if "favorited" not in cols:
            conn.execute("ALTER TABLE runs ADD COLUMN favorited INTEGER NOT NULL DEFAULT 0")
            conn.commit()

        # Databases from older builds may also hold a legacy `jobs` table. It is
        # superseded by `generation_jobs` (backend/job_store.py), left in place
        # and never read. The same goes for the `sets` / `set_items` tables of
        # the removed Sets feature: kept in old databases, never created or read.
        conn.commit()
        conn.close()
    print(f"[run-history] database ready at {DB_PATH}")


def save_run(run: dict[str, Any]) -> None:
    with _lock:
        conn = _get_conn()
        conn.execute(
            """
            INSERT OR REPLACE INTO runs (id, name, status, duration_ms, flow_snapshot, block_results, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run["id"],
                run["name"],
                run["status"],
                run.get("duration_ms"),
                json.dumps(run["flow_snapshot"], ensure_ascii=True),
                json.dumps(run["block_results"], ensure_ascii=True),
                normalize_created_at(run.get("created_at")),
            ),
        )
        conn.commit()
        conn.close()


_PRIMARY_KIND_PRIORITY = ("video", "image", "prompt")


def _primary_media_kind(block_results: list[dict[str, Any]]) -> str:
    """Mirror frontend findPrimaryArtifact, then bucket into video/image/other."""
    for kind in _PRIMARY_KIND_PRIORITY:
        for br in reversed(block_results):
            for out in (br.get("outputs") or {}).values():
                if out.get("kind") != kind:
                    continue
                if kind in ("video", "image"):
                    return kind
                return "other"
    return "other"


# Block types whose saved config holds prompt text, and the keys that hold it.
# Generation blocks keep `prompt`; the Prompt Writer keeps the user's idea and
# its (possibly edited) result.
_PROMPT_CONFIG_KEYS = ("prompt",)
_PROMPT_WRITER_TYPE = "promptWriter"
_PROMPT_WRITER_KEYS = ("user_prompt", "output")
_MAX_SNAPSHOT_DEPTH = 64


def _snapshot_prompts(flow_snapshot: Any) -> list[str]:
    """Prompt strings in a saved flow, depth-first through `branches`.
    Anything malformed is skipped, never raised on."""
    found: list[str] = []

    def walk(chain: Any, depth: int) -> None:
        if depth > _MAX_SNAPSHOT_DEPTH or not isinstance(chain, list):
            return
        for block in chain:
            if not isinstance(block, dict):
                continue
            config = block.get("config")
            if isinstance(config, dict):
                keys = _PROMPT_CONFIG_KEYS + (_PROMPT_WRITER_KEYS if block.get("type") == _PROMPT_WRITER_TYPE else ())
                for key in keys:
                    value = config.get(key)
                    if isinstance(value, str) and value:
                        found.append(value)
            branches = block.get("branches")
            if isinstance(branches, list):
                for branch in branches:
                    walk(branch, depth + 1)

    if isinstance(flow_snapshot, dict):
        walk(flow_snapshot.get("blocks"), 0)
    return found


def _result_prompts(block_results: Any) -> list[str]:
    """Prompts in block results: legacy `metadata` outputs (`prompt` field) and
    the text output of a Prompt Writer block."""
    found: list[str] = []
    if not isinstance(block_results, list):
        return found
    for br in block_results:
        if not isinstance(br, dict) or not isinstance(br.get("outputs"), dict):
            continue
        writer = br.get("block_type") == _PROMPT_WRITER_TYPE
        for out in br["outputs"].values():
            if not isinstance(out, dict):
                continue
            value = out.get("value")
            if out.get("kind") == "metadata":
                for m in value if isinstance(value, list) else [value]:
                    if isinstance(m, dict) and isinstance(m.get("prompt"), str):
                        found.append(m["prompt"])
            elif writer and out.get("kind") == "text" and isinstance(value, str):
                found.append(value)
    return found


def run_prompts(run: dict[str, Any]) -> list[str]:
    """Every prompt of a stored run (see `_run_matches_prompt`), results first."""
    return _result_prompts(run.get("block_results")) + _snapshot_prompts(run.get("flow_snapshot"))


def _run_matches_prompt(block_results: list[dict[str, Any]], needle: str, flow_snapshot: Any = None) -> bool:
    """True if the needle (case-insensitive) is in a prompt of the run: a
    generation block's or Prompt Writer's prompt in the saved flow, a Prompt
    Writer result, or a legacy metadata `prompt`. Model, provider and other
    text are not searched."""
    needle = needle.lower()
    return any(needle in p.lower() for p in _result_prompts(block_results) + _snapshot_prompts(flow_snapshot))


_CHARACTER_FILE_RE = re.compile(r"^/outputs/characters/(char_[0-9a-f]{32})/[^/]+$")
_CHARACTER_ID_RE = re.compile(r"^char_[0-9a-f]{32}$")


def _run_character_ids(run: dict[str, Any]) -> set[str]:
    """Ids of the characters a run was made with: the characters whose folder
    (`/outputs/characters/<id>/<file>`) holds a reference in the outputs of a
    block result. Pipeline runs emit them from the Load Character block, MCP
    runs from their loader block. The saved config in `flow_snapshot` is not
    read: it also lists files that were selected but not sent."""
    found: set[str] = set()
    results = run.get("block_results")
    if not isinstance(results, list):
        return found
    for br in results:
        outputs = br.get("outputs") if isinstance(br, dict) else None
        if not isinstance(outputs, dict):
            continue
        for out in outputs.values():
            value = out.get("value") if isinstance(out, dict) else None
            for ref in value if isinstance(value, list) else [value]:
                local = ref.get("local") if isinstance(ref, dict) else None
                match = _CHARACTER_FILE_RE.match(local) if isinstance(local, str) else None
                if match:
                    found.add(match.group(1))
    return found


# A filter value: one string, several, or None for "no filter".
RunFilter = str | Iterable[str] | None


def _filter_set(value: RunFilter) -> frozenset[str] | None:
    """One value or several as a set; None (no filter) when empty."""
    if value is None:
        return None
    items = [value] if isinstance(value, str) else list(value)
    out = frozenset(v for v in items if v)
    return out or None


def _character_filter(value: RunFilter) -> frozenset[str] | None:
    """Character ids to filter by; malformed ids are ignored."""
    valid = frozenset(v for v in _filter_set(value) or () if _CHARACTER_ID_RE.match(v))
    return valid or None


def list_runs(
    limit: int = 50,
    offset: int = 0,
    favorited_only: bool = False,
    media_kind: RunFilter = None,
    prompt_query: str | None = None,
    hide_partial: bool = False,
    source: RunFilter = None,
    character: RunFilter = None,
) -> list[dict[str, Any]]:
    media_kind = _filter_set(media_kind)
    source = _filter_set(source)
    character = _character_filter(character)
    if not media_kind and not prompt_query and not hide_partial and not source and not character:
        conn = _get_conn()
        if favorited_only:
            rows = conn.execute(
                "SELECT * FROM runs WHERE favorited = 1 ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM runs ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        conn.close()
        return [_row_to_dict(r) for r in rows]

    filtered = _filtered_runs(favorited_only, media_kind, prompt_query, hide_partial, source, character)
    return filtered[offset : offset + limit]


def count_runs(
    favorited_only: bool = False,
    media_kind: RunFilter = None,
    prompt_query: str | None = None,
    hide_partial: bool = False,
    source: RunFilter = None,
    character: RunFilter = None,
) -> int:
    media_kind = _filter_set(media_kind)
    source = _filter_set(source)
    character = _character_filter(character)
    if not media_kind and not prompt_query and not hide_partial and not source and not character:
        conn = _get_conn()
        if favorited_only:
            row = conn.execute("SELECT COUNT(*) AS count FROM runs WHERE favorited = 1").fetchone()
        else:
            row = conn.execute("SELECT COUNT(*) AS count FROM runs").fetchone()
        conn.close()
        return int(row["count"]) if row else 0

    return len(_filtered_runs(favorited_only, media_kind, prompt_query, hide_partial, source, character))


# MCP-generated runs use this id prefix.
_MCP_RUN_PREFIX = "run-mcp-"

# Statuses of runs where a block failed; `hide_partial` looks at these only.
_UNFINISHED_STATUSES = frozenset({"partial", "failed"})
_GENERATED_KINDS = frozenset({"image", "video", "audio"})
_MAX_VALUE_DEPTH = 16


def _is_generated_ref(value: Any, depth: int = 0) -> bool:
    """True if a port value holds a ref that a generation job made: a dict with
    `meta.job_id` (mirrors the frontend `readGenerationMeta`). Lists are
    searched, as a port holds one ref or several (nested by an iterator)."""
    if isinstance(value, list):
        return depth < _MAX_VALUE_DEPTH and any(_is_generated_ref(v, depth + 1) for v in value)
    meta = value.get("meta") if isinstance(value, dict) else None
    job_id = meta.get("job_id") if isinstance(meta, dict) else None
    return isinstance(job_id, str) and bool(job_id)


def _has_generated_output(block_results: Any) -> bool:
    """True if a block result holds an image, video or audio made by a
    generation job. Loader files, plain URLs and locally edited files (Video
    FX, Video Stitcher) carry no job and do not count. Malformed results count
    as none."""
    if not isinstance(block_results, list):
        return False
    for br in block_results:
        outputs = br.get("outputs") if isinstance(br, dict) else None
        if not isinstance(outputs, dict):
            continue
        for out in outputs.values():
            if isinstance(out, dict) and out.get("kind") in _GENERATED_KINDS and _is_generated_ref(out.get("value")):
                return True
    return False


def _hidden_as_partial(run: dict[str, Any]) -> bool:
    """What `hide_partial` hides: a partial or failed run with nothing generated
    to show. A run whose generation finished stays listed when a later block
    (a viewer, an edit, a second generation) failed: its output was paid for."""
    if str(run.get("status", "")).lower() not in _UNFINISHED_STATUSES:
        return False
    return not _has_generated_output(run.get("block_results"))


def _filtered_runs(
    favorited_only: bool,
    media_kind: frozenset[str] | None,
    prompt_query: str | None,
    hide_partial: bool,
    source: frozenset[str] | None = None,
    character: frozenset[str] | None = None,
) -> list[dict[str, Any]]:
    """Load candidate rows and apply Python-side filters. Returns newest-first."""
    conn = _get_conn()
    if favorited_only:
        rows = conn.execute(
            "SELECT * FROM runs WHERE favorited = 1 ORDER BY created_at DESC"
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM runs ORDER BY created_at DESC").fetchall()
    conn.close()

    out: list[dict[str, Any]] = []
    for r in rows:
        d = _row_to_dict(r)
        is_mcp = str(d.get("id", "")).startswith(_MCP_RUN_PREFIX)
        if source and ("mcp" if is_mcp else "pipeline") not in source:
            continue
        if hide_partial and _hidden_as_partial(d):
            continue
        br = d.get("block_results") or []
        if media_kind and _primary_media_kind(br) not in media_kind:
            continue
        if prompt_query and not _run_matches_prompt(br, prompt_query, d.get("flow_snapshot")):
            continue
        if character and not (_run_character_ids(d) & character):
            continue
        out.append(d)
    return out


def get_run(run_id: str) -> dict[str, Any] | None:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    conn.close()
    return _row_to_dict(row) if row else None


def delete_run(run_id: str) -> bool:
    with _lock:
        conn = _get_conn()
        cursor = conn.execute("DELETE FROM runs WHERE id = ?", (run_id,))
        conn.commit()
        deleted = cursor.rowcount > 0
        conn.close()
    return deleted


def toggle_run_favorited(run_id: str) -> bool | None:
    """Toggle the favorited flag on a run. Returns new value, or None if not found."""
    with _lock:
        conn = _get_conn()
        row = conn.execute("SELECT favorited FROM runs WHERE id = ?", (run_id,)).fetchone()
        if not row:
            conn.close()
            return None
        new_val = 0 if row["favorited"] else 1
        conn.execute("UPDATE runs SET favorited = ? WHERE id = ?", (new_val, run_id))
        conn.commit()
        conn.close()
    return bool(new_val)


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    d = dict(row)
    d["flow_snapshot"] = json.loads(d["flow_snapshot"])
    d["block_results"] = json.loads(d["block_results"])
    d["favorited"] = bool(d.get("favorited", 0))
    return d


def prune_runs_older_than(retention_days: int) -> int:
    """Delete non-favorited runs older than `retention_days` days.

    Returns the number of rows deleted. A negative `retention_days` value
    is treated as invalid input and is a no-op (defensive against config
    bugs silently wiping user data).
    """
    from datetime import datetime, timedelta, timezone

    if retention_days < 0:
        return 0

    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    cutoff_iso = cutoff.isoformat()

    with _lock:
        conn = _get_conn()
        cursor = conn.execute(
            "DELETE FROM runs WHERE favorited = 0 AND created_at < ?",
            (cutoff_iso,),
        )
        deleted = cursor.rowcount
        conn.commit()
        conn.close()
    return int(deleted)
