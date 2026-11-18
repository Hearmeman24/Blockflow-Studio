"""Generation orchestration: validate, create a job, run it in the background.

Public API (no FastAPI imports; callable from routes, MCP or scripts):

- ``validate_generation(payload) -> list[issue]``
- ``submit_generation(payload) -> job snapshot`` (raises ``GenerationError``)
- ``wait_for_job(job_id, timeout=None) -> job snapshot | None``
- ``resume_pending() -> {"failed": [...], "resumed": [...]}``
- ``get_api_key(provider)``, ``configured_providers()``, ``shutdown()``

Keys are read server-side from the settings store, passed only to adapter
calls, and never logged or stored. A job is submitted to the provider exactly
once; polling never resubmits. Module-level settings below can be patched by
tests (all delays to zero).
"""

from __future__ import annotations

import logging
import math
import os
import threading
import time
import traceback
import urllib.request
import uuid
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

from backend import job_store
from backend.byok import ledger, media, references
from backend.byok.errors import ProviderError, redact
from backend.byok.http import USER_AGENT
from backend.byok.providers import PollResult, SubmitResult, get_adapter
from backend.byok.spec import PROVIDER_NAMES, Reference, canonical_reference, to_jsonable

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------ settings

CREDENTIALS: dict[str, str] = {"kie": "kie_api_key", "piapi": "piapi_api_key"}

POLL_INITIAL_S = 3.0
POLL_BACKOFF = 1.5
POLL_MAX_S = 15.0
CANCEL_CHECK_S = 0.5          # granularity of cancel checks while waiting between polls
JOB_TIMEOUT_S = 60 * 60.0     # give up waiting on the provider after this long
MAX_POLL_ERRORS = 6           # consecutive retryable poll failures before the job fails
MAX_WORKERS = 8
DOWNLOAD_TIMEOUT_S = 300.0
DOWNLOAD_MAX_BYTES = 4 * 1024 ** 3
DOWNLOAD_CHUNK = 1024 * 1024
OUTPUT_SUBDIR = "byok"
MAX_CLIENT_REQUEST_ID = 200
MAX_LABEL = 200               # optional run name (MCP jobs; backend/mcp_runs.py)
# Settings → Storage. Same pref and default as backend/asset_uploads.py: an unset
# or unknown value means local_only (fail closed: no third-party host).
STORAGE_MODE_PREF = "asset_storage_mode"
LOCAL_ONLY_CODE = "local_only_storage"

# Injection points (tests replace these).
adapter_factory: Callable[..., Any] = get_adapter
fallback_uploader: Callable[[Path], str] | None = None  # None -> media's tmpfiles default
sleep: Callable[[float], None] = time.sleep
clock: Callable[[], float] = time.time


def open_url(url: str, timeout: float):
    """Open a provider output URL for streaming. Returns a context manager."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    return urllib.request.urlopen(req, timeout=timeout)  # noqa: S310 - http(s) checked by caller


# ------------------------------------------------------------------ errors


class GenerationError(Exception):
    """A request the service refused. ``kind``: validation | auth | conflict."""

    def __init__(self, kind: str, message: str, issues: Sequence[Mapping[str, Any]] = ()) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.issues = [dict(i) for i in issues]


_HINTS = {
    "auth": "Check the {p} API key in Settings.",
    "insufficient_credits": "Add credits to your {p} account, then run again.",
    "rate_limited": "Wait a minute, then run again.",
    "validation": "Adjust the settings or references, then run again.",
    "content_rejected": "Change the prompt or references, then run again.",
    "unsupported": "Choose another model, mode or provider.",
    "provider_failure": "Try again later; if it keeps failing, check the {p} status page.",
    "timeout": "Try again later.",
    "network": "Check your internet connection, then run again.",
    "malformed_response": "Try again; if it keeps happening, report it.",
}
_AMBIGUOUS_SUBMIT = frozenset({"timeout", "network", "malformed_response"})
GENERIC_FAILURE = ("Something went wrong while running this job. The details are in the BlockFlow "
                   "server log.")

_IMAGE_TYPES = {"image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp",
                "image/gif": ".gif", "image/avif": ".avif", "image/heic": ".heic"}
_VIDEO_TYPES = {"video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
                "video/x-matroska": ".mkv"}
_AUDIO_TYPES = {"audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
                "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/ogg": ".ogg"}
_CTYPE_EXT = {**_IMAGE_TYPES, **_VIDEO_TYPES, **_AUDIO_TYPES}
_URL_EXTS = frozenset(set(_CTYPE_EXT.values()) | {".jpeg", ".m4v"})
_DEFAULT_EXT = {"video": ".mp4", "image": ".png", "audio": ".mp3"}

_REF_FIELDS = ("kind", "url", "local", "role", "duration_s", "size_bytes", "width", "height", "format")


def _pname(provider: str) -> str:
    return PROVIDER_NAMES.get(provider, provider)


def _issue(code: str, field: str, message: str, severity: str = "error") -> dict[str, Any]:
    return {"code": code, "severity": severity, "field": field, "message": message, "limit": None,
            "actual": None}


def _errors(issues: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    return [i for i in issues if i.get("severity") == "error"]


def error_message(kind: str, message: str, provider: str, key: str | None = None) -> str:
    """User-facing message for a ProviderError kind: the safe provider text plus one action."""
    base = redact(message or "", key).strip() or f"{_pname(provider)} could not complete the request."
    hint = _HINTS.get(kind, "").format(p=_pname(provider))
    if hint and hint.lower() not in base.lower():
        base = f"{base.rstrip('.')}. {hint}"
    return base


# ------------------------------------------------------------------ credentials


def get_api_key(provider: str) -> str | None:
    """The stored key for ``provider`` (stripped), or None. Never logged."""
    name = CREDENTIALS.get(provider)
    if name is None:
        return None
    from backend import settings_store

    try:
        value = settings_store.get_credential(name)
    except Exception:  # noqa: BLE001 - an unreadable settings DB means "not configured"
        logger.warning("could not read the %s credential from the settings store", provider)
        return None
    value = value.strip() if isinstance(value, str) else ""
    return value or None


def storage_mode() -> str:
    """``tmpfiles`` only when the user chose it in Settings → Storage; anything
    else (unset, unknown, unreadable) is ``local_only``: local files then only
    ever go to the chosen provider's own upload."""
    from backend import settings_store

    try:
        value = settings_store.get_app_pref(STORAGE_MODE_PREF)
    except Exception:  # noqa: BLE001 - fail closed
        return "local_only"
    return "tmpfiles" if value == "tmpfiles" else "local_only"


def _local_only_refusal(provider: str, path: Path, err: ProviderError, key: str) -> ProviderError:
    p = _pname(provider)
    reason = redact(err.message, key).strip().rstrip(".") or f"{p} did not accept the upload"
    message = (f"{p} would not take {path.name}: {reason}. Storage is set to local only, so BlockFlow did not "
               f"send the file anywhere else. To continue, switch Storage to \"tmpfiles\" in Settings, or use "
               "a provider or plan that accepts this upload.")
    return ProviderError("unsupported", message, provider=provider, retryable=False,
                         provider_code=LOCAL_ONLY_CODE)


def _uploaders(adapter: Any, provider: str, key: str) -> tuple[Callable[[Path, str], str], Callable[[Path], str]]:
    """(provider uploader, fallback uploader) honouring the storage mode."""
    if storage_mode() == "tmpfiles":
        return adapter.upload_file, (fallback_uploader or media.default_fallback_uploader)

    def provider_only(path: Path, api_key: str) -> str:
        try:
            return adapter.upload_file(path, api_key)
        except ProviderError as err:
            if err.kind == "unsupported" and err.provider_code in media.FALLBACK_CODES:
                raise _local_only_refusal(provider, Path(path), err, key) from None
            raise

    def refuse(path: Path) -> str:  # defence in depth: never reached via provider_only
        raise ProviderError("unsupported", "Storage is set to local only; BlockFlow will not upload "
                            f"{Path(path).name} to a temporary file host.", provider=provider,
                            retryable=False, provider_code=LOCAL_ONLY_CODE)

    return provider_only, refuse


def configured_providers() -> set[str]:
    return {p for p in CREDENTIALS if get_api_key(p)}


def missing_key_message(provider: str) -> str:
    return f"No {_pname(provider)} API key is saved. Add your {_pname(provider)} key in Settings, then run again."


# ------------------------------------------------------------------ payload parsing


class _Plan:
    """A validated request, ready to run. Holds no secret."""

    def __init__(self, provider: str, model: str, mode: str, params: dict[str, Any], refs: list[Reference],
                 raw_refs: list[dict[str, Any]], source: str, client_request_id: str | None,
                 warnings: list[dict[str, Any]], label: str | None = None) -> None:
        self.provider, self.model, self.mode = provider, model, mode
        self.params, self.refs, self.raw_refs = params, refs, raw_refs
        self.source, self.client_request_id, self.warnings = source, client_request_id, warnings
        self.label = label

    def request_record(self) -> dict[str, Any]:
        record = {"params": self.params, "references": self.raw_refs, "client_request_id": self.client_request_id,
                  "warnings": self.warnings}
        if self.label:
            record["label"] = self.label
        return record


def _coerce_reference(i: int, raw: Any, issues: list[dict[str, Any]]) -> tuple[Reference, dict[str, Any]]:
    field = f"references[{i}]"
    if not isinstance(raw, Mapping):
        issues.append(_issue("invalid_reference", field, "Each reference must be an object."))
        return Reference(kind="", url=""), {}
    raw = canonical_reference(raw)  # a legacy "voice" is audio; a name is never kept or sent
    kept = {k: raw[k] for k in _REF_FIELDS if k in raw}
    local, url = raw.get("local"), raw.get("url")
    chosen: str | None = None
    missing: str | None = None

    for name, value in (("local", local), ("url", url)):
        if chosen is not None or value is None:
            continue
        if not isinstance(value, str) or not value.strip():
            issues.append(_issue("invalid_reference", f"{field}.{name}", f"'{name}' must be a non-empty string."))
            continue
        if name == "url" and not references.is_local_value(value):
            if references.is_http_url(value) or references.is_asset_ref(value):
                chosen = value.strip()
            else:
                issues.append(_issue("invalid_reference_url", f"{field}.url",
                                     "The reference URL must be an http:// or https:// address."))
            continue
        try:
            path = references.resolve_local(value)
        except references.UnsafePathError as exc:
            issues.append(_issue("reference_path_unsafe", f"{field}.{name}", str(exc)))
            continue
        if path.is_file():
            chosen = value.strip()
        else:
            missing = path.name

    if chosen is None and missing is not None:
        issues.append(_issue("reference_missing_local", f"{field}.local",
                             f"The local file {missing} no longer exists. Re-add the file."))
    ref = Reference(kind=raw.get("kind"), url=chosen or "", role=raw.get("role") or "reference",
                    duration_s=raw.get("duration_s"), size_bytes=raw.get("size_bytes"),
                    width=raw.get("width"), height=raw.get("height"), format=raw.get("format"))
    return ref, kept


def _parse(payload: Any) -> tuple[_Plan | None, list[dict[str, Any]]]:
    if not isinstance(payload, Mapping):
        return None, [_issue("invalid_payload", "", "The request body must be a JSON object.")]
    issues: list[dict[str, Any]] = []
    if job_store.strip_secrets(dict(payload)) != dict(payload):
        issues.append(_issue("key_in_request", "", "API keys are never accepted in a request. "
                                                   "Save the key in Settings instead."))
    fields: dict[str, str] = {}
    for name in ("provider", "model", "mode"):
        value = payload.get(name)
        if not isinstance(value, str) or not value.strip():
            issues.append(_issue("missing_field", name, f"'{name}' is required."))
        else:
            fields[name] = value.strip()
    params = payload.get("params") if payload.get("params") is not None else {}
    if not isinstance(params, Mapping):
        issues.append(_issue("invalid_parameter", "params", "'params' must be an object."))
        params = {}
    raw_refs = payload.get("references") if payload.get("references") is not None else []
    if not isinstance(raw_refs, list):
        issues.append(_issue("invalid_reference", "references", "'references' must be a list."))
        raw_refs = []
    source = payload.get("source") or "pipeline"
    if source not in job_store.JOB_SOURCES:
        issues.append(_issue("invalid_source", "source",
                             f"'source' must be one of: {', '.join(job_store.JOB_SOURCES)}."))
    cid = payload.get("client_request_id")
    if cid is not None and (not isinstance(cid, str) or not cid.strip() or len(cid) > MAX_CLIENT_REQUEST_ID):
        issues.append(_issue("invalid_client_request_id", "client_request_id",
                             f"'client_request_id' must be a non-empty string of at most "
                             f"{MAX_CLIENT_REQUEST_ID} characters."))
    label = payload.get("label")
    if label is not None and (not isinstance(label, str) or not label.strip() or len(label) > MAX_LABEL):
        issues.append(_issue("invalid_label", "label",
                             f"'label' must be a non-empty string of at most {MAX_LABEL} characters."))
    if job_store.strip_secrets(dict(params)) != dict(params) and not any(
            i["code"] == "key_in_request" for i in issues):
        issues.append(_issue("key_in_request", "params", "API keys are never accepted in a request. "
                                                         "Save the key in Settings instead."))
    if issues:
        return None, issues

    refs: list[Reference] = []
    kept: list[dict[str, Any]] = []
    for i, raw in enumerate(raw_refs):
        ref, raw_kept = _coerce_reference(i, raw, issues)
        refs.append(ref)
        kept.append(raw_kept)
    ledger_issues = [to_jsonable(i) for i in ledger.validate_request(
        fields["provider"], fields["model"], fields["mode"], dict(params), refs)]
    issues.extend(ledger_issues)
    plan = _Plan(fields["provider"], fields["model"], fields["mode"], dict(params), refs, kept, source,
                 cid.strip() if isinstance(cid, str) else None,
                 [i for i in issues if i["severity"] == "warning"],
                 label.strip() if isinstance(label, str) else None)
    return plan, issues


def validate_generation(payload: Any) -> list[dict[str, Any]]:
    """Every issue (errors and warnings) for ``payload``. No job, no provider call."""
    return _parse(payload)[1]


# ------------------------------------------------------------------ worker state

_state_lock = threading.Lock()
_submit_lock = threading.Lock()
_executor: ThreadPoolExecutor | None = None
_futures: dict[str, Future] = {}
_attached: set[str] = set()


def _pool() -> ThreadPoolExecutor:
    global _executor
    with _state_lock:
        if _executor is None:
            _executor = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="byok-job")
        return _executor


def _dispatch(job_id: str, fn: Callable[[], None]) -> bool:
    with _state_lock:
        if job_id in _attached:
            return False
        _attached.add(job_id)

    def run() -> None:
        try:
            fn()
        finally:
            with _state_lock:
                _attached.discard(job_id)

    future = _pool().submit(run)
    with _state_lock:
        _futures[job_id] = future
    return True


def wait_for_job(job_id: str, timeout: float | None = None) -> dict[str, Any] | None:
    """Block until this process's worker for ``job_id`` stops (or ``timeout``)."""
    with _state_lock:
        future = _futures.get(job_id)
    if future is not None:
        try:
            future.result(timeout=timeout)
        except FutureTimeout:
            pass
    return job_store.get_store().get_job(job_id)


def shutdown(wait: bool = True) -> None:
    global _executor
    with _state_lock:
        pool, _executor = _executor, None
    if pool is not None:
        pool.shutdown(wait=wait)
    with _state_lock:
        _futures.clear()
        _attached.clear()


# ------------------------------------------------------------------ submit


def _find_active(store: job_store.JobStore, client_request_id: str) -> dict[str, Any] | None:
    for status in ("QUEUED", "RUNNING"):
        for job in store.list_jobs(status=status, limit=job_store.MAX_LIST_LIMIT):
            if (job.get("request") or {}).get("client_request_id") == client_request_id:
                return job
    return None


def submit_generation(payload: Any) -> dict[str, Any]:
    """Validate, persist a QUEUED job, and start it in the background."""
    plan, issues = _parse(payload)
    errors = _errors(issues)
    if plan is None or errors:
        raise GenerationError("validation", "; ".join(str(i["message"]) for i in errors) or "Invalid request.",
                              issues)
    if not get_api_key(plan.provider):
        raise GenerationError("auth", missing_key_message(plan.provider))

    store = job_store.get_store()
    with _submit_lock:
        if plan.client_request_id:
            existing = _find_active(store, plan.client_request_id)
            if existing is not None:
                same = (existing.get("provider"), existing.get("model"), existing.get("mode")) == (
                    plan.provider, plan.model, plan.mode)
                if not same:
                    raise GenerationError("conflict", "This client_request_id is already used by another "
                                                      "running job. Use a new id for a different request.")
                return existing
        try:
            job = store.create_job(source=plan.source, provider=plan.provider, model=plan.model, mode=plan.mode,
                                   request=plan.request_record(), message="Queued")
        except ValueError as exc:
            raise GenerationError("validation", f"The request could not be stored: {exc}",
                                  [_issue("invalid_payload", "", str(exc))]) from None
        job_id = job["job_id"]
        _dispatch(job_id, lambda: _run_new(job_id, plan))
    return job


# ------------------------------------------------------------------ worker


class _Stop(Exception):
    """The job reached a terminal state (usually a user cancel); stop quietly."""


def _annotate_cancelled(store: job_store.JobStore, job_id: str, message: str,
                        remote_job_id: str | None = None) -> None:
    """Explain a cancel on a job that is already CANCELLED (and keep the
    provider task id if the cancel landed while the submit was in flight)."""
    try:
        job = store.get_job(job_id)
        if job is None or job.get("status") != "CANCELLED":
            return
        if job.get("remote_job_id"):
            remote_job_id = None
        store.annotate(job_id, message=message, remote_job_id=remote_job_id)
    except (job_store.JobNotFoundError, ValueError):
        pass


def _cancel_before_submit(store: job_store.JobStore, job_id: str, provider: str) -> None:
    _annotate_cancelled(store, job_id, f"Cancelled. The request was not sent to {_pname(provider)}, so nothing "
                                       "was billed.")


def _cancel_after_submit(store: job_store.JobStore, job_id: str, provider: str, remote_job_id: str) -> None:
    p = _pname(provider)
    _annotate_cancelled(store, job_id,
                        f"Cancelled. {p} may still finish task {remote_job_id} and bill it: {p} offers no "
                        "cancel for this model. BlockFlow will not download the result.", remote_job_id)


def _update(store: job_store.JobStore, job_id: str, **fields: Any) -> dict[str, Any]:
    job = store.update_job(job_id, **fields)
    if job["status"] in job_store.TERMINAL_STATUSES and job["status"] != fields.get("status"):
        raise _Stop
    return job


def _fail(store: job_store.JobStore, job_id: str, kind: str, message: str,
          cost: dict[str, Any] | None = None) -> None:
    fields: dict[str, Any] = {"cost": cost} if cost is not None else {}
    store.update_job(job_id, status="FAILED", error={"kind": kind, "message": message}, message=message,
                     **fields)


def _price_check(store: job_store.JobStore, job_id: str, cost: dict[str, Any] | None) -> dict[str, Any] | None:
    """Learn the unit price from a completed job's charge and compare it with
    the ledger (backend/byok/learned_prices.py). Never fails the job."""
    if cost is None:
        return None
    try:
        from backend.byok import learned_prices

        job = store.get_job(job_id) or {}
        request = job.get("request") or {}
        return learned_prices.learn(job.get("provider", ""), job.get("model", ""), job.get("mode") or "",
                                    request.get("params"), request.get("references"), cost)
    except Exception as exc:  # noqa: BLE001
        logger.warning("byok job %s: price check failed (%s)", job_id, type(exc).__name__)
        return None


def _cost(result: PollResult) -> dict[str, Any] | None:
    """The provider-reported charge for a finished task, as stored on the job."""
    return result.cost.as_dict() if result.cost is not None else None


def _resolve_for_upload(value: str) -> Path:
    try:
        return references.resolve_local(value)
    except references.UnsafePathError as exc:
        raise ProviderError("validation", str(exc), retryable=False) from None


def _run_new(job_id: str, plan: _Plan) -> None:
    store = job_store.get_store()
    key = get_api_key(plan.provider)
    remote_job_id: str | None = None
    try:
        if not key:
            _fail(store, job_id, "auth", missing_key_message(plan.provider))
            return
        if store.is_cancel_requested(job_id):
            raise _Stop
        _update(store, job_id, status="RUNNING", message="Preparing references")
        adapter = adapter_factory(plan.provider)
        uploader, fallback = _uploaders(adapter, plan.provider, key)
        refs = media.prepare_references(plan.refs, plan.provider, key, uploader=uploader,
                                        fallback_uploader=fallback, resolve_local=_resolve_for_upload)
        request = adapter.build_request(plan.model, plan.mode, plan.params, refs)
        record = {**plan.request_record(),
                  "provider_request": {"method": request.method, "url": request.url, "body": dict(request.body)}}
        _update(store, job_id, request=record, message=f"Sending to {_pname(plan.provider)}")
        if store.is_cancel_requested(job_id):
            raise _Stop
        try:
            result: SubmitResult = adapter.submit(request, key)
        except ProviderError as err:
            message = error_message(err.kind, err.message, plan.provider, key)
            if err.kind in _AMBIGUOUS_SUBMIT:
                p = _pname(plan.provider)
                message += (f" {p} may have accepted the request anyway; check your {p} dashboard before "
                            "running it again so you are not billed twice.")
            logger.info("byok job %s: submit failed (%s): %s", job_id, err.kind, redact(err.message, key))
            _fail(store, job_id, err.kind, message)
            return
        remote_job_id = result.remote_job_id
        try:
            _update(store, job_id, remote_job_id=remote_job_id, remote_status="submitted",
                    message=f"Waiting for {_pname(plan.provider)}")
        except _Stop:
            _cancel_after_submit(store, job_id, plan.provider, remote_job_id)
            return
        expected = ledger.get_model(plan.model).output
        _follow(store, job_id, adapter, key, plan.provider, remote_job_id, expected, clock() + JOB_TIMEOUT_S,
                result.initial)
    except _Stop:
        job = store.get_job(job_id) or {}
        if job.get("status") == "CANCELLED":
            if remote_job_id or job.get("remote_job_id"):
                _cancel_after_submit(store, job_id, plan.provider, remote_job_id or job["remote_job_id"])
            else:
                _cancel_before_submit(store, job_id, plan.provider)
    except ProviderError as err:
        logger.info("byok job %s failed (%s): %s", job_id, err.kind, redact(err.message, key))
        message = (redact(err.message, key) if err.provider_code == LOCAL_ONLY_CODE  # already actionable
                   else error_message(err.kind, err.message, plan.provider, key))
        _fail(store, job_id, err.kind, message)
    except Exception:  # noqa: BLE001 - never leave a job RUNNING
        logger.error("byok job %s crashed: %s", job_id, redact(traceback.format_exc(), key))
        _fail(store, job_id, "provider_failure", GENERIC_FAILURE)


def _wait(store: job_store.JobStore, job_id: str, seconds: float) -> None:
    """Sleep in short slices; raise _Stop as soon as a cancel is seen."""
    remaining = max(0.0, float(seconds))
    while True:
        if store.is_cancel_requested(job_id):
            raise _Stop
        if remaining <= 0:
            return
        step = min(remaining, CANCEL_CHECK_S) if CANCEL_CHECK_S > 0 else remaining
        sleep(step)
        remaining -= step


def _progress(value: Any) -> float | None:
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    if not math.isfinite(value):
        return None
    if value > 1.0:
        value /= 100.0
    return min(1.0, max(0.0, value))


def _follow(store: job_store.JobStore, job_id: str, adapter: Any, key: str, provider: str, remote_job_id: str,
            expected_kind: str, deadline: float, initial: PollResult | None = None) -> None:
    """Poll until terminal, cancelled or timed out. Never resubmits."""
    p = _pname(provider)
    try:
        interval = POLL_INITIAL_S
        errors = 0
        last: tuple[Any, Any] | None = None
        result = initial
        while True:
            if result is None:
                _wait(store, job_id, 0)
                try:
                    result = adapter.poll(remote_job_id, key, expected_kind)
                    errors = 0
                except ProviderError as err:
                    errors += 1
                    if not err.retryable or errors >= MAX_POLL_ERRORS:
                        logger.info("byok job %s: poll failed (%s): %s", job_id, err.kind, redact(err.message, key))
                        _fail(store, job_id, err.kind, error_message(err.kind, err.message, provider, key))
                        return
                    result = None
            if result is not None:
                if result.status == "COMPLETED":
                    _complete(store, job_id, provider, result, expected_kind, key)
                    return
                if result.status == "FAILED":
                    info = result.error
                    kind = info.kind if info else "provider_failure"
                    text = info.message if info else f"{p} could not generate this result."
                    _fail(store, job_id, kind, error_message(kind, text, provider, key), _cost(result))
                    return
                state = (result.remote_status, _progress(result.progress))
                if state != last:
                    last = state
                    waiting = "Queued at" if result.status == "QUEUED" else "Generating on"
                    _update(store, job_id, remote_status=result.remote_status or None, progress=state[1],
                            message=f"{waiting} {p}")
            if clock() >= deadline:
                minutes = max(1, round(JOB_TIMEOUT_S / 60))
                message = (f"Gave up waiting after {minutes} minutes. {p} may still finish task {remote_job_id} "
                           f"and bill it; check your {p} dashboard.")
                store.update_job(job_id, status="TIMED_OUT", error={"kind": "timeout", "message": message},
                                 message=message)
                return
            _wait(store, job_id, interval)
            interval = min(POLL_MAX_S, interval * POLL_BACKOFF) if interval > 0 else 0
            result = None
    except _Stop:
        _cancel_after_submit(store, job_id, provider, remote_job_id)


# ------------------------------------------------------------------ outputs


def output_dir() -> Path:
    return references.output_root() / OUTPUT_SUBDIR


def _extension(content_type: str | None, url: str, kind: str) -> str:
    ctype = (content_type or "").split(";", 1)[0].strip().lower()
    if ctype in _CTYPE_EXT:
        return _CTYPE_EXT[ctype]
    suffix = Path(urlsplit(url).path).suffix.lower()
    if suffix in _URL_EXTS:
        return ".jpg" if suffix == ".jpeg" else suffix
    return _DEFAULT_EXT.get(kind, ".bin")


def _reserve(dest: Path, stem: str, ext: str) -> Path:
    for n in range(1000):
        candidate = dest / (f"{stem}{ext}" if n == 0 else f"{stem}-{n}{ext}")
        try:
            fd = os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            continue
        os.close(fd)
        return candidate
    raise OSError("could not find a free output file name")


def download_output(url: str, kind: str, stem: str) -> str:
    """Stream ``url`` into the byok output folder. Returns the ``/outputs/...`` URL."""
    if not references.is_http_url(url):
        raise ValueError("output URL is not http(s)")
    dest = output_dir()
    dest.mkdir(parents=True, exist_ok=True)
    part = dest / f"{stem}.{uuid.uuid4().hex[:8]}.part"
    try:
        with open_url(url, DOWNLOAD_TIMEOUT_S) as resp:
            status = getattr(resp, "status", 200) or 200
            if status >= 400:
                raise OSError(f"HTTP {status}")
            headers = getattr(resp, "headers", None) or {}
            ext = _extension(headers.get("Content-Type"), url, kind)
            total = 0
            with open(part, "wb") as fh:
                while True:
                    chunk = resp.read(DOWNLOAD_CHUNK)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > DOWNLOAD_MAX_BYTES:
                        raise OSError("output is larger than the download limit")
                    fh.write(chunk)
        final = _reserve(dest, stem, ext)
        os.replace(part, final)
    finally:
        part.unlink(missing_ok=True)
    return f"/outputs/{OUTPUT_SUBDIR}/{quote(final.name)}"


def _complete(store: job_store.JobStore, job_id: str, provider: str, result: PollResult, expected_kind: str,
              key: str) -> None:
    outputs: list[dict[str, str]] = []
    failures = 0
    for index, out in enumerate(result.outputs, start=1):
        kind = out.kind if out.kind in job_store.OUTPUT_KINDS else expected_kind
        entry = {"kind": kind, "url": out.url}
        try:
            entry["local_url"] = download_output(out.url, kind, f"{job_id}_{index}")
        except Exception as exc:  # noqa: BLE001 - keep the remote URL
            failures += 1
            logger.warning("byok job %s: could not save output %d from %s: %s", job_id, index,
                           references.display_url(out.url), redact(f"{type(exc).__name__}: {exc}", key))
        outputs.append(entry)
    if failures:
        message = (f"Done, but {failures} of {len(outputs)} output(s) could not be saved locally. The "
                   f"{_pname(provider)} links expire, so save them soon.")
    else:
        message = "Done"
    cost = _cost(result)
    store.update_job(job_id, status="COMPLETED", outputs=outputs, progress=1.0,
                     remote_status=result.remote_status or None, error=None, message=message,
                     cost=cost, price_check=_price_check(store, job_id, cost))


# ------------------------------------------------------------------ resume


def resume_pending() -> dict[str, list[str]]:
    """After a restart: fail jobs that never reached a provider, and re-attach
    polling (never resubmitting) to jobs that have a remote task id."""
    store = job_store.get_store()
    summary = store.recover_after_restart()
    resumed: list[str] = []
    for job in store.list_resumable():
        job_id, provider, remote_job_id = job["job_id"], job["provider"], job["remote_job_id"]
        with _state_lock:
            if job_id in _attached:
                continue
        if not get_api_key(provider):
            message = (f"{missing_key_message(provider)} {_pname(provider)} task {remote_job_id} may still be "
                       "running; its result is on your provider dashboard.")
            _fail(store, job_id, "auth", message)
            continue
        if _dispatch(job_id, lambda j=job: _run_resumed(j)):
            resumed.append(job_id)
    return {"failed": list(summary.get("failed", [])), "resumed": resumed}


def _run_resumed(job: dict[str, Any]) -> None:
    store = job_store.get_store()
    job_id, provider = job["job_id"], job["provider"]
    key = get_api_key(provider)
    try:
        if not key:
            _fail(store, job_id, "auth", missing_key_message(provider))
            return
        adapter = adapter_factory(provider)
        try:
            expected = ledger.get_model(job["model"]).output
        except KeyError:
            expected = "image"
        elapsed = max(0.0, time.time() - float(job.get("created_at") or time.time()))
        deadline = clock() + max(0.0, JOB_TIMEOUT_S - elapsed)
        _update(store, job_id, status="RUNNING", message=f"Reconnected to {_pname(provider)}")
        _follow(store, job_id, adapter, key, provider, job["remote_job_id"], expected, deadline)
    except _Stop:
        _cancel_after_submit(store, job_id, provider, job["remote_job_id"])
    except ProviderError as err:
        _fail(store, job_id, err.kind, error_message(err.kind, err.message, provider, key))
    except Exception:  # noqa: BLE001
        logger.error("byok job %s crashed while resuming: %s", job_id, redact(traceback.format_exc(), key))
        _fail(store, job_id, "provider_failure", GENERIC_FAILURE)
