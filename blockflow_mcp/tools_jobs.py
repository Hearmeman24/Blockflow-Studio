"""Tool group: generation jobs (/api/jobs). Status, waiting, cancelling, listing."""

import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from blockflow_mcp import references
from blockflow_mcp.client import ToolFailure, checked, get_client, tool

TERMINAL = ("COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT")
STATUSES = ("QUEUED", "RUNNING", *TERMINAL)
# Statuses the backend saves an Artifacts run for (backend/mcp_runs.py).
# tests/test_mcp_status_contract.py keeps these equal to backend/statuses.py.
RUN_RECORDED = ("COMPLETED", "FAILED", "TIMED_OUT")
SOURCES = ("mcp", "pipeline")
POLL_INTERVAL_S = 3.0
DEFAULT_TIMEOUT_S = 600.0
MAX_TIMEOUT_S = 3600.0

# Set when the client is gone (stdin ended, or the process is exiting; see
# server.main). A wait then returns between polls with the jobs still pending.
# Only the waiting stops: no job is cancelled.
STOP = threading.Event()


def _pause(seconds: float) -> None:
    """Sleep between polls, waking at once when STOP is set."""
    STOP.wait(seconds)


# Injection points (tests replace these).
sleep: Callable[[float], None] = _pause
clock: Callable[[], float] = time.monotonic


def _outputs(job: dict[str, Any], roots: list[Path]) -> list[dict[str, Any]]:
    base = get_client().base_url
    out = []
    for o in job.get("outputs") or []:
        local = o.get("local_url")
        entry: dict[str, Any] = {"kind": o.get("kind")}
        if local:
            entry["local"] = local
            entry["open_url"] = base + local
            if local.startswith(references.OUTPUTS_PREFIX):
                rel = local[len(references.OUTPUTS_PREFIX):]
                # Same order the backend serves /outputs in: current folder first.
                for root in roots:
                    path = root / rel
                    if path.is_file() and path.resolve().is_relative_to(root):
                        entry["file_path"] = str(path)
                        break
        if o.get("url"):
            entry["provider_url"] = o["url"]
        out.append(entry)
    return out


def summarize(job: dict[str, Any], *, roots: list[Path] | None = None) -> dict[str, Any]:
    """The parts of a job snapshot a caller needs (no provider request body)."""
    request = job.get("request") or {}
    summary = {
        "job_id": job.get("job_id"),
        "status": job.get("status"),
        # What the backend is doing while the job is active (preparing,
        # submitting, polling, downloading); None once it has finished.
        "phase": job.get("phase"),
        "source": job.get("source"),
        "provider": job.get("provider"),
        "model": job.get("model"),
        "mode": job.get("mode"),
        "message": job.get("message"),
        "progress": job.get("progress"),
        "error": job.get("error"),
        "cost": job.get("cost"),
        "outputs": _outputs(job, roots or []),
        "created_at": job.get("created_at"),
        "completed_at": job.get("completed_at"),
    }
    if request.get("label"):
        summary["label"] = request["label"]
    if isinstance(request.get("params"), dict) and isinstance(request["params"].get("prompt"), str):
        summary["prompt"] = request["params"]["prompt"]
    if job.get("source") == "mcp" and job.get("status") in RUN_RECORDED:
        summary["artifacts_run_id"] = f"run-mcp-{job.get('job_id')}"
    return summary


def fetch_job(job_id: str) -> dict[str, Any]:
    if not isinstance(job_id, str) or not job_id.strip():
        raise ToolFailure("invalid_job_id", "'job_id' is required.")
    status, body = get_client().get(f"/api/jobs/{job_id.strip()}")
    if status == 404:
        raise ToolFailure("not_found", f"No job with id {job_id!r}.")
    return checked(status, body, "Reading the job")["job"]


def _timeout(timeout_s: float | None) -> float:
    if timeout_s is None:
        return DEFAULT_TIMEOUT_S
    try:
        value = float(timeout_s)
    except (TypeError, ValueError):
        raise ToolFailure("invalid_timeout", "'timeout_s' must be a number of seconds.") from None
    if value < 0:
        raise ToolFailure("invalid_timeout", "'timeout_s' must be 0 or more.")
    return min(value, MAX_TIMEOUT_S)


def wait_for(job_ids: list[str], timeout_s: float) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """Poll until every job is terminal, the timeout passes or STOP is set.
    (jobs by id, still-pending ids)."""
    deadline = clock() + timeout_s
    jobs: dict[str, dict[str, Any]] = {}
    while True:
        for job_id in job_ids:
            if job_id not in jobs or jobs[job_id].get("status") not in TERMINAL:
                jobs[job_id] = fetch_job(job_id)
        pending = [j for j in job_ids if jobs[j].get("status") not in TERMINAL]
        if not pending or clock() >= deadline or STOP.is_set():
            return jobs, pending
        sleep(min(POLL_INTERVAL_S, max(0.0, deadline - clock())))
        if STOP.is_set():
            return jobs, pending


@tool(read_only=True)
def job_status(job_id: str) -> dict[str, Any]:
    """The current state of one generation job: status (QUEUED, RUNNING,
    COMPLETED, FAILED, CANCELLED, TIMED_OUT), `phase` while it is active
    (preparing, submitting, polling, downloading), progress, message, error, the
    provider's actual cost, and outputs (`local` /outputs path, `file_path` on
    this computer, `open_url`, and the expiring `provider_url`)."""
    roots = references.output_folders(get_client())
    return {"ok": True, "job": summarize(fetch_job(job_id), roots=roots)}


@tool(read_only=True)
def wait_for_jobs(job_ids: list[str], timeout_s: float = DEFAULT_TIMEOUT_S) -> dict[str, Any]:
    """Wait until every listed job has finished (or `timeout_s`, default 600,
    max 3600, passes) and return each job's status, outputs, cost and error.
    Waiting never cancels anything: jobs still running are listed in `pending`;
    call again to keep waiting."""
    if not isinstance(job_ids, list) or not job_ids or not all(isinstance(j, str) and j.strip() for j in job_ids):
        raise ToolFailure("invalid_job_ids", "'job_ids' must be a non-empty list of job ids.")
    ids = list(dict.fromkeys(j.strip() for j in job_ids))
    jobs, pending = wait_for(ids, _timeout(timeout_s))
    roots = references.output_folders(get_client())
    return {"ok": True, "jobs": [summarize(jobs[j], roots=roots) for j in ids], "pending": pending,
            "timed_out": bool(pending)}


@tool(read_only=False)
def cancel_job(job_id: str) -> dict[str, Any]:
    """Cancel a queued or running job. BlockFlow stops following it and will not
    download the result. If the provider already accepted the task it may still
    finish it and bill your account: most providers offer no cancel. A job that
    has already finished is returned unchanged."""
    if not isinstance(job_id, str) or not job_id.strip():
        raise ToolFailure("invalid_job_id", "'job_id' is required.")
    status, body = get_client().post(f"/api/jobs/{job_id.strip()}/cancel")
    if status == 404:
        raise ToolFailure("not_found", f"No job with id {job_id!r}.")
    job = checked(status, body, "Cancelling the job")["job"]
    note = ("The provider may still finish and bill this task; BlockFlow will not download it."
            if job.get("remote_job_id") else "The request had not reached the provider, so nothing was billed.")
    return {"ok": True, "job": summarize(job), "note": note}


@tool(read_only=True)
def list_jobs(status: str = "", source: str = "", limit: int = 20) -> dict[str, Any]:
    """Recent generation jobs, newest first. Filter by `status` (QUEUED,
    RUNNING, COMPLETED, FAILED, CANCELLED, TIMED_OUT) and `source` (`mcp` for
    jobs started through this server, `pipeline` for the app). `limit` 1-500."""
    status = (status or "").strip().upper()
    source = (source or "").strip().lower()
    if status and status not in STATUSES:
        raise ToolFailure("invalid_status", f"'status' must be one of {', '.join(STATUSES)}.")
    if source and source not in SOURCES:
        raise ToolFailure("invalid_source", f"'source' must be one of {', '.join(SOURCES)}.")
    limit = max(1, min(int(limit), 500))
    code, body = get_client().get("/api/jobs", params={"status": status, "source": source, "limit": limit})
    jobs = checked(code, body, "Listing jobs").get("jobs") or []
    return {"ok": True, "jobs": [summarize(j) for j in jobs], "count": len(jobs)}


TOOLS = [job_status, wait_for_jobs, cancel_job, list_jobs]
