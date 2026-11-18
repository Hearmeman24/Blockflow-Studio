"""Shared status vocabularies (backend/statuses.py).

Every value is pinned to the exact string the app stores and returns today:
the enums only name these strings, they never change them. The job
transition table is checked against what the job store actually does.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend import asset_uploads, db, job_store, statuses  # noqa: E402
from backend.app_update import engine  # noqa: E402
from backend.byok import errors, references  # noqa: E402
from backend.statuses import (  # noqa: E402
    ACTIVE_JOB_STATUSES,
    JOB_TRANSITIONS,
    TERMINAL_JOB_STATUSES,
    BalanceStatus,
    BlockResultStatus,
    ErrorKind,
    JobStatus,
    PriceRefreshStatus,
    ReferenceCheckStatus,
    RunStatus,
    StepStatus,
    StorageMode,
    UpdateState,
    can_transition,
)


def _values(enum_cls) -> tuple[str, ...]:
    return tuple(member.value for member in enum_cls)


# ------------------------------------------------------------ values pinned


def test_job_status_values_are_todays_strings_in_order():
    assert _values(JobStatus) == ("QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT")
    assert ACTIVE_JOB_STATUSES == frozenset({"QUEUED", "RUNNING"})
    assert TERMINAL_JOB_STATUSES == frozenset({"COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"})
    assert ACTIVE_JOB_STATUSES | TERMINAL_JOB_STATUSES == frozenset(JobStatus)
    assert not ACTIVE_JOB_STATUSES & TERMINAL_JOB_STATUSES


def test_job_store_exports_keep_their_names_contents_and_plain_strings():
    assert job_store.JOB_STATUSES == ("QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT")
    assert job_store.TERMINAL_STATUSES == frozenset({"COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"})
    assert job_store.ACTIVE_STATUSES == frozenset({"QUEUED", "RUNNING"})
    for name in ("JOB_STATUSES", "TERMINAL_STATUSES", "ACTIVE_STATUSES"):
        assert all(type(s) is str for s in getattr(job_store, name)), name
    assert job_store.JOB_STATUSES == _values(JobStatus)


def test_error_kinds_keep_todays_provider_kinds_and_add_interrupted_separately():
    provider_kinds = ("auth", "insufficient_credits", "rate_limited", "validation", "content_rejected",
                      "unsupported", "provider_failure", "timeout", "network", "malformed_response")
    assert errors.ERROR_KINDS == provider_kinds
    assert all(type(k) is str for k in errors.ERROR_KINDS)
    assert _values(ErrorKind) == (*provider_kinds, "interrupted")
    assert tuple(statuses.PROVIDER_ERROR_KINDS) == provider_kinds
    assert statuses.JOB_ONLY_ERROR_KINDS == frozenset({"interrupted"})
    # A provider error still cannot carry the job-store-only kind.
    with pytest.raises(ValueError):
        errors.ProviderError("interrupted", "x")


def test_run_and_block_result_statuses():
    assert _values(RunStatus) == ("completed", "partial", "failed")
    assert _values(BlockResultStatus) == ("idle", "running", "completed", "error", "skipped", "cancelled")
    assert db._UNFINISHED_STATUSES == frozenset({"partial", "failed"})


def test_update_states_and_step_statuses():
    assert _values(UpdateState) == ("idle", "running", "restarting", "done", "failed", "rolled_back")
    assert _values(StepStatus) == ("pending", "running", "done", "failed", "skipped")
    assert engine.ACTIVE_STATES == frozenset({"running", "restarting"})
    assert engine.FINISHED_STATES == frozenset({"done", "failed", "rolled_back"})
    assert engine._idle()["state"] == "idle"
    assert json.dumps(engine._idle()["state"]) == '"idle"'


def test_storage_balance_price_refresh_and_reference_statuses():
    assert _values(StorageMode) == ("local_only", "tmpfiles")
    assert asset_uploads.ASSET_STORAGE_MODES == {"local_only", "tmpfiles"}
    assert asset_uploads.DEFAULT_ASSET_STORAGE_MODE == "local_only"
    assert _values(BalanceStatus) == ("ok", "unavailable", "error", "not_configured")
    assert _values(PriceRefreshStatus) == ("updated", "not_modified", "skipped", "not_configured", "disabled",
                                           "older_than_bundled", "not_available", "invalid", "too_large", "error")
    assert _values(ReferenceCheckStatus) == ("ok", "missing_local", "unreachable", "expired", "malformed",
                                             "unchecked")
    assert references.STATUSES == ("ok", "missing_local", "unreachable", "expired", "malformed", "unchecked")
    assert all(type(s) is str for s in references.STATUSES)


def test_statuses_module_is_standard_library_only():
    source = (ROOT / "backend" / "statuses.py").read_text(encoding="utf-8")
    imports = [line.split()[1] for line in source.splitlines() if line.startswith(("import ", "from "))]
    assert set(imports) <= {"__future__", "enum", "collections.abc", "typing"}, imports


# ------------------------------------------------------------ transitions


def test_job_transitions_describe_todays_rules():
    assert set(JOB_TRANSITIONS) == set(JobStatus)
    for status in ACTIVE_JOB_STATUSES:
        assert JOB_TRANSITIONS[status] == frozenset(JobStatus)
    for status in TERMINAL_JOB_STATUSES:
        assert JOB_TRANSITIONS[status] == frozenset()


def test_can_transition_accepts_plain_strings_and_rejects_unknown_values():
    assert can_transition("QUEUED", "RUNNING")
    assert can_transition(JobStatus.RUNNING, JobStatus.COMPLETED)
    assert can_transition("RUNNING", "RUNNING")
    assert not can_transition("COMPLETED", "RUNNING")
    assert not can_transition("CANCELLED", "CANCELLED")
    assert not can_transition("queued", "RUNNING")
    assert not can_transition("RUNNING", "DONE")
    assert not can_transition(None, "RUNNING")


def _job_in(store: job_store.JobStore, status: str) -> dict:
    start = status if status in ACTIVE_JOB_STATUSES else "QUEUED"
    job = store.create_job(source="pipeline", provider="kie", model="veo3", status=start)
    if status != start:
        job = store.update_job(job["job_id"], status=status)
    assert job["status"] == status
    return job


@pytest.mark.parametrize("to", _values(JobStatus))
@pytest.mark.parametrize("frm", _values(JobStatus))
def test_job_transitions_match_what_the_store_does(tmp_path, frm, to):
    store = job_store.JobStore(tmp_path / "jobs.db")
    job = _job_in(store, frm)
    after = store.update_job(job["job_id"], status=to, message="moved")
    applied = after["status"] == to and after["message"] == "moved"
    assert applied == can_transition(frm, to)


# ------------------------------------------------------------ serialisation


def test_enum_members_serialise_as_plain_strings():
    assert json.dumps({"status": JobStatus.TIMED_OUT}) == '{"status": "TIMED_OUT"}'
    assert json.dumps([RunStatus.PARTIAL, StepStatus.SKIPPED]) == '["partial", "skipped"]'
    assert f"{JobStatus.FAILED}" == "FAILED"
    assert str(UpdateState.ROLLED_BACK) == "rolled_back"
    assert "Update " + UpdateState.DONE == "Update done"
    assert JobStatus.COMPLETED == "COMPLETED" and hash(JobStatus.COMPLETED) == hash("COMPLETED")


def test_enum_members_bind_in_sqlite_as_text():
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE t (status TEXT)")
    conn.execute("INSERT INTO t VALUES (?)", (JobStatus.CANCELLED,))
    value, kind = conn.execute("SELECT status, typeof(status) FROM t").fetchone()
    assert (value, kind) == ("CANCELLED", "text") and type(value) is str
    assert conn.execute("SELECT COUNT(*) FROM t WHERE status = ?", (JobStatus.CANCELLED,)).fetchone() == (1,)


def test_job_round_trip_through_the_store_stores_plain_strings(tmp_path):
    path = tmp_path / "jobs.db"
    store = job_store.JobStore(path)
    job = store.create_job(source="pipeline", provider="kie", model="veo3", status=JobStatus.RUNNING)
    store.update_job(job["job_id"], status=JobStatus.FAILED,
                     error={"kind": ErrorKind.TIMEOUT, "message": "late"})
    again = job_store.JobStore(path).get_job(job["job_id"])
    assert again["status"] == "FAILED" and type(again["status"]) is str
    assert again["error"] == {"kind": "timeout", "message": "late"}
    assert [j["job_id"] for j in store.list_jobs(status=JobStatus.FAILED)] == [job["job_id"]]
    conn = sqlite3.connect(path)
    status, data = conn.execute(f"SELECT status, data FROM {job_store.TABLE}").fetchone()
    assert status == "FAILED" and json.loads(data)["status"] == "FAILED"
    assert '"status": "FAILED"' in data


def test_recovery_still_writes_the_interrupted_kind(tmp_path):
    path = tmp_path / "jobs.db"
    store = job_store.JobStore(path)
    job = store.create_job(source="pipeline", provider="kie", model="veo3")
    result = job_store.JobStore(path).recover_after_restart()
    assert result["failed"] == [job["job_id"]]
    raw = sqlite3.connect(path).execute(f"SELECT data FROM {job_store.TABLE}").fetchone()[0]
    assert json.loads(raw)["error"]["kind"] == "interrupted"
    assert json.loads(raw)["status"] == "FAILED"


# ------------------------------------------------------------ job phase


def test_job_phase_vocabulary_is_declared_in_order_and_in_the_contract():
    assert _values(statuses.JobPhase) == ("preparing", "submitting", "polling", "downloading")
    assert statuses.contract()["job_phase"] == ["preparing", "submitting", "polling", "downloading"]


@pytest.mark.parametrize("verdict", [True, False])
def test_the_store_enforces_the_declared_transition_table(tmp_path, monkeypatch, verdict):
    """update_job, request_cancel and recover_after_restart ask can_transition,
    so the declared table is what is enforced."""
    store = job_store.JobStore(tmp_path / "jobs.db")
    asked: list[tuple[str, str]] = []

    def fake(current, new):
        asked.append((str(current), str(new)))
        return verdict

    monkeypatch.setattr(job_store, "can_transition", fake)
    a = store.create_job(source="pipeline", provider="kie", model="veo3")
    after = store.update_job(a["job_id"], status="RUNNING", message="moved")
    assert (after["status"] == "RUNNING") is verdict
    b = store.create_job(source="pipeline", provider="kie", model="veo3")
    assert (store.request_cancel(b["job_id"])["status"] == "CANCELLED") is verdict
    c = store.create_job(source="pipeline", provider="kie", model="veo3")
    assert (c["job_id"] in job_store.JobStore(tmp_path / "jobs.db").recover_after_restart()["failed"]) is verdict
    assert ("QUEUED", "RUNNING") in asked and ("QUEUED", "CANCELLED") in asked and ("QUEUED", "FAILED") in asked
