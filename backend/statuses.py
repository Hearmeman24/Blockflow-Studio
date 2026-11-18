"""Status vocabularies shared across the backend, declared once.

Every value is the exact string the app already stores in SQLite, writes to
JSON files and returns from the API; a ``StrEnum`` member *is* that string
(it compares, hashes, formats and JSON-encodes as the plain value), so using
a member instead of the literal changes nothing on disk or on the wire.

The frontend and the MCP server keep their own copies. They are checked
against this module by ``tests/test_status_contract_fixture.py`` (through the
generated ``frontend/src/lib/status/__fixtures__/status-contract.json``) and
``tests/test_mcp_status_contract.py``.

Standard library only, so it imports before anything else is installed.
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum


class JobStatus(StrEnum):
    """A generation job (``generation_jobs.status``, ``/api/jobs``)."""

    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    TIMED_OUT = "TIMED_OUT"


ACTIVE_JOB_STATUSES: frozenset[JobStatus] = frozenset({JobStatus.QUEUED, JobStatus.RUNNING})
TERMINAL_JOB_STATUSES: frozenset[JobStatus] = frozenset(JobStatus) - ACTIVE_JOB_STATUSES

# What the job store allows today: an active job may be updated to any status
# (itself included, for an update that changes other fields); a terminal job
# is final and every update to it is ignored. Declared here; enforced, for
# now, by ``job_store.JobStore.update_job`` / ``request_cancel`` /
# ``recover_after_restart`` on their own.
JOB_TRANSITIONS: Mapping[JobStatus, frozenset[JobStatus]] = {
    status: (frozenset(JobStatus) if status in ACTIVE_JOB_STATUSES else frozenset())
    for status in JobStatus
}


def can_transition(current: object, new: object) -> bool:
    """True when a job in ``current`` may move to ``new`` (values or members).
    Anything that is not a job status is False."""
    try:
        return JobStatus(new) in JOB_TRANSITIONS[JobStatus(current)]
    except ValueError:
        return False


class ErrorKind(StrEnum):
    """``error.kind`` on a failed job. The first ten are what a provider error
    may carry (``backend.byok.errors.ERROR_KINDS``); ``interrupted`` is
    written only by the job store's restart recovery."""

    AUTH = "auth"
    INSUFFICIENT_CREDITS = "insufficient_credits"
    RATE_LIMITED = "rate_limited"
    VALIDATION = "validation"
    CONTENT_REJECTED = "content_rejected"
    UNSUPPORTED = "unsupported"
    PROVIDER_FAILURE = "provider_failure"
    TIMEOUT = "timeout"
    NETWORK = "network"
    MALFORMED_RESPONSE = "malformed_response"
    INTERRUPTED = "interrupted"


JOB_ONLY_ERROR_KINDS: frozenset[ErrorKind] = frozenset({ErrorKind.INTERRUPTED})
PROVIDER_ERROR_KINDS: tuple[ErrorKind, ...] = tuple(k for k in ErrorKind if k not in JOB_ONLY_ERROR_KINDS)


class RunStatus(StrEnum):
    """A saved run (``runs.status``): every block finished, some did, none did."""

    COMPLETED = "completed"
    PARTIAL = "partial"
    FAILED = "failed"


class BlockResultStatus(StrEnum):
    """``status`` of one entry in a saved run's ``block_results``. ``running``
    appears only in runs saved before a cancel was recorded as ``cancelled``."""

    IDLE = "idle"
    RUNNING = "running"
    COMPLETED = "completed"
    ERROR = "error"
    SKIPPED = "skipped"
    CANCELLED = "cancelled"


class UpdateState(StrEnum):
    """The in-app updater (``progress.json`` ``state``)."""

    IDLE = "idle"
    RUNNING = "running"
    RESTARTING = "restarting"
    DONE = "done"
    FAILED = "failed"
    ROLLED_BACK = "rolled_back"


ACTIVE_UPDATE_STATES: frozenset[UpdateState] = frozenset({UpdateState.RUNNING, UpdateState.RESTARTING})
FINISHED_UPDATE_STATES: frozenset[UpdateState] = frozenset(
    {UpdateState.DONE, UpdateState.FAILED, UpdateState.ROLLED_BACK})


class StepStatus(StrEnum):
    """One step of an update (``progress.json`` ``steps[].status``)."""

    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    SKIPPED = "skipped"


class StorageMode(StrEnum):
    """The ``asset_storage_mode`` preference."""

    LOCAL_ONLY = "local_only"
    TMPFILES = "tmpfiles"


class BalanceStatus(StrEnum):
    """One provider's entry in ``/api/providers/balances``."""

    OK = "ok"
    UNAVAILABLE = "unavailable"
    ERROR = "error"
    NOT_CONFIGURED = "not_configured"


class PriceRefreshStatus(StrEnum):
    """The result of refreshing the price ledger (``price_sources.refresh``)."""

    UPDATED = "updated"
    NOT_MODIFIED = "not_modified"
    SKIPPED = "skipped"
    NOT_CONFIGURED = "not_configured"
    DISABLED = "disabled"
    OLDER_THAN_BUNDLED = "older_than_bundled"
    NOT_AVAILABLE = "not_available"
    INVALID = "invalid"
    TOO_LARGE = "too_large"
    ERROR = "error"


class ReferenceCheckStatus(StrEnum):
    """One reference's health (``/api/references/check``)."""

    OK = "ok"
    MISSING_LOCAL = "missing_local"
    UNREACHABLE = "unreachable"
    EXPIRED = "expired"
    MALFORMED = "malformed"
    UNCHECKED = "unchecked"


def _ordered(enum_cls: type[StrEnum], subset: frozenset[StrEnum] | None = None) -> list[str]:
    return [m.value for m in enum_cls if subset is None or m in subset]


def contract() -> dict[str, list[str]]:
    """Every vocabulary as plain lists in declaration order: the content of
    the frontend status-contract fixture."""
    return {
        "job_status": _ordered(JobStatus),
        "job_status_active": _ordered(JobStatus, ACTIVE_JOB_STATUSES),
        "job_status_terminal": _ordered(JobStatus, TERMINAL_JOB_STATUSES),
        "error_kind": _ordered(ErrorKind),
        "run_status": _ordered(RunStatus),
        "block_result_status": _ordered(BlockResultStatus),
        "update_state": _ordered(UpdateState),
        "update_state_active": _ordered(UpdateState, ACTIVE_UPDATE_STATES),
        "update_state_finished": _ordered(UpdateState, FINISHED_UPDATE_STATES),
        "update_step_status": _ordered(StepStatus),
        "storage_mode": _ordered(StorageMode),
        "balance_status": _ordered(BalanceStatus),
        "price_refresh_status": _ordered(PriceRefreshStatus),
        "reference_check_status": _ordered(ReferenceCheckStatus),
    }
