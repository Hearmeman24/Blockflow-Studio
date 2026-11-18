"""Provider-neutral persisted generation job store (backend/job_store.py).

Every test points the store at a fresh SQLite file under tmp_path; a
"restart" is simulated by building a second JobStore on the same file.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import db, job_store  # noqa: E402
from backend.job_store import (  # noqa: E402
    JOB_STATUSES,
    TERMINAL_STATUSES,
    JobNotFoundError,
    JobStore,
)


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "run_history.db"


@pytest.fixture
def store(db_path: Path) -> JobStore:
    return JobStore(db_path)


def _create(store: JobStore, **overrides):
    fields = {
        "source": "pipeline",
        "provider": "kie",
        "model": "veo3",
        "mode": "text_to_video",
        "request": {"prompt": "a cat surfing", "duration": 5},
    }
    fields.update(overrides)
    return store.create_job(**fields)


# ---------------------------------------------------------------- create/get


def test_create_job_returns_full_snapshot_with_defaults(store):
    job = _create(store)
    assert isinstance(job["job_id"], str) and job["job_id"]
    assert job["source"] == "pipeline"
    assert job["provider"] == "kie"
    assert job["model"] == "veo3"
    assert job["mode"] == "text_to_video"
    assert job["status"] == "QUEUED"
    assert job["remote_job_id"] is None
    assert job["remote_status"] is None
    assert job["progress"] is None
    assert job["message"] is None
    assert job["error"] is None
    assert job["outputs"] == []
    assert job["request"] == {"prompt": "a cat surfing", "duration": 5}
    assert job["created_at"] == job["updated_at"]
    assert job["completed_at"] is None
    assert job["cancel_requested"] is False
    assert set(job) == {
        "job_id", "source", "provider", "model", "mode", "status",
        "remote_job_id", "remote_status", "progress", "message", "error",
        "outputs", "request", "created_at", "updated_at", "completed_at",
        "cancel_requested", "cost", "price_check",
    }
    assert job["cost"] is None and job["price_check"] is None


def test_get_job_reads_back_what_was_created(store):
    job = _create(store)
    assert store.get_job(job["job_id"]) == job


def test_get_unknown_job_returns_none(store):
    assert store.get_job("nope") is None


def test_create_with_explicit_id_and_duplicate_is_rejected(store):
    _create(store, job_id="job-1")
    with pytest.raises(ValueError):
        _create(store, job_id="job-1")


@pytest.mark.parametrize("bad_source", ["", "runpod", None, "MCP"])
def test_create_rejects_unknown_source(store, bad_source):
    with pytest.raises(ValueError):
        _create(store, source=bad_source)


def test_create_rejects_missing_provider_or_model(store):
    with pytest.raises(ValueError):
        _create(store, provider="")
    with pytest.raises(ValueError):
        _create(store, model="")


def test_create_rejects_non_json_request(store):
    with pytest.raises(ValueError):
        _create(store, request={"prompt": object()})


def test_create_rejects_non_dict_request(store):
    with pytest.raises(ValueError):
        _create(store, request=["prompt"])


def test_create_tolerates_missing_request(store):
    job = _create(store, request=None)
    assert job["request"] == {}


# ---------------------------------------------------------------- update


def test_update_job_changes_fields_and_bumps_updated_at(store, monkeypatch):
    job = _create(store)
    monkeypatch.setattr(job_store.time, "time", lambda: job["created_at"] + 10)
    updated = store.update_job(
        job["job_id"], status="RUNNING", remote_job_id="task-9",
        remote_status="processing", progress=0.25, message="Rendering",
    )
    assert updated["status"] == "RUNNING"
    assert updated["remote_job_id"] == "task-9"
    assert updated["remote_status"] == "processing"
    assert updated["progress"] == 0.25
    assert updated["message"] == "Rendering"
    assert updated["updated_at"] == job["created_at"] + 10
    assert updated["completed_at"] is None
    assert store.get_job(job["job_id"]) == updated


def test_completion_sets_completed_at_and_outputs(store):
    job = _create(store)
    outputs = [{"kind": "video", "url": "https://cdn.example/v.mp4", "local_url": "/outputs/v.mp4"}]
    done = store.update_job(job["job_id"], status="COMPLETED", outputs=outputs, progress=1)
    assert done["status"] == "COMPLETED"
    assert done["completed_at"] == done["updated_at"]
    assert done["outputs"] == outputs
    assert done["progress"] == 1.0


def test_update_unknown_job_raises(store):
    with pytest.raises(JobNotFoundError):
        store.update_job("missing", status="RUNNING")


@pytest.mark.parametrize("bad", ["running", "DONE", "UNKNOWN", "", None, "COMPLETED_WITH_WARNING"])
def test_update_rejects_invalid_status_and_leaves_job_untouched(store, bad):
    job = _create(store)
    with pytest.raises(ValueError):
        store.update_job(job["job_id"], status=bad)
    assert store.get_job(job["job_id"]) == job


def test_status_vocabulary_is_exactly_the_contract():
    assert JOB_STATUSES == ("QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT")
    assert TERMINAL_STATUSES == frozenset({"COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"})


@pytest.mark.parametrize("field", ["job_id", "source", "created_at", "completed_at", "cancel_requested", "bogus"])
def test_update_rejects_immutable_or_unknown_fields(store, field):
    job = _create(store)
    with pytest.raises(ValueError):
        store.update_job(job["job_id"], **{field: "x"})
    assert store.get_job(job["job_id"]) == job


@pytest.mark.parametrize("bad", [-0.1, 1.5, "half", float("nan"), True])
def test_update_rejects_out_of_range_progress(store, bad):
    job = _create(store)
    with pytest.raises(ValueError):
        store.update_job(job["job_id"], progress=bad)


@pytest.mark.parametrize("bad", [
    "boom",
    {"message": "no kind"},
    {"kind": "provider"},
    {"kind": 3, "message": "x"},
])
def test_update_rejects_malformed_error(store, bad):
    job = _create(store)
    with pytest.raises(ValueError):
        store.update_job(job["job_id"], error=bad)


def test_update_accepts_well_formed_error(store):
    job = _create(store)
    failed = store.update_job(
        job["job_id"], status="FAILED", error={"kind": "provider", "message": "Content policy"},
    )
    assert failed["error"] == {"kind": "provider", "message": "Content policy"}
    assert failed["completed_at"] is not None


@pytest.mark.parametrize("bad", [
    {"kind": "video"},                       # no url
    {"kind": "lora", "url": "https://x/y"},  # unknown kind
    {"kind": "image", "url": ""},
    "https://x/y.png",
])
def test_update_rejects_malformed_outputs(store, bad):
    job = _create(store)
    with pytest.raises(ValueError):
        store.update_job(job["job_id"], outputs=[bad])


def test_large_outputs_list_round_trips(store, db_path):
    job = _create(store)
    outputs = [
        {"kind": "image", "url": f"https://cdn.example/{i}.png", "local_url": f"/outputs/{i}.png"}
        for i in range(2000)
    ]
    store.update_job(job["job_id"], outputs=outputs)
    reread = JobStore(db_path).get_job(job["job_id"])
    assert len(reread["outputs"]) == 2000
    assert reread["outputs"][1999] == outputs[1999]


# ---------------------------------------------------------------- terminal finality


@pytest.mark.parametrize("terminal", sorted(TERMINAL_STATUSES))
def test_updates_after_terminal_are_ignored(store, terminal):
    job = _create(store)
    final = store.update_job(job["job_id"], status=terminal, message="final")
    after = store.update_job(job["job_id"], status="RUNNING", message="late poll", progress=0.5)
    assert after == final
    assert store.get_job(job["job_id"]) == final


def test_terminal_to_other_terminal_is_also_ignored(store):
    job = _create(store)
    store.update_job(job["job_id"], status="CANCELLED")
    after = store.update_job(job["job_id"], status="COMPLETED", outputs=[{"kind": "image", "url": "https://x/a.png"}])
    assert after["status"] == "CANCELLED"
    assert after["outputs"] == []


def test_ignored_terminal_update_publishes_nothing(store):
    job = _create(store)
    store.update_job(job["job_id"], status="COMPLETED")
    seen: list[dict] = []
    unsubscribe = store.subscribe_callback(seen.append)
    try:
        store.update_job(job["job_id"], status="RUNNING")
    finally:
        unsubscribe()
    assert seen == []


# ---------------------------------------------------------------- secrets


def test_flat_secret_keys_are_dropped_before_storage(store, db_path):
    job = _create(store, request={
        "prompt": "hello",
        "api_key": "sk-live-123",
        "Authorization": "Bearer abc",
        "access_token": "tok",
        "client_secret": "s",
        "PASSWORD": "p",
        "duration": 5,
    })
    assert job["request"] == {"prompt": "hello", "duration": 5}
    raw = sqlite3.connect(db_path).execute("SELECT * FROM generation_jobs").fetchall()
    blob = repr(raw)
    for secret in ("sk-live-123", "Bearer abc", "tok\"", "client_secret", "PASSWORD"):
        assert secret not in blob


def test_nested_secret_keys_are_dropped_in_dicts_and_lists(store, db_path):
    job = _create(store, request={
        "prompt": "x",
        "headers": {"X-Api-Key": "k1", "accept": "json"},
        "references": [
            {"url": "https://a/1.png", "upload_token": "t1"},
            {"url": "https://a/2.png", "nested": {"client_secret": "t2", "ok": True}},
        ],
    })
    assert job["request"] == {
        "prompt": "x",
        "headers": {"accept": "json"},
        "references": [
            {"url": "https://a/1.png"},
            {"url": "https://a/2.png", "nested": {"ok": True}},
        ],
    }
    blob = repr(sqlite3.connect(db_path).execute("SELECT * FROM generation_jobs").fetchall())
    assert "k1" not in blob and "t1" not in blob and "t2" not in blob


@pytest.mark.parametrize("name", [
    "api_key", "piapi_api_key", "x-api-key", "X-Api-Key", "Authorization", "access_token",
    "client_secret", "password", "key", "KEY", "kie api key", "refresh-token",
])
def test_secret_name_segments_are_dropped(store, name):
    job = _create(store, request={"prompt": "p", name: "s3cr3t-value"})
    assert job["request"] == {"prompt": "p"}


@pytest.mark.parametrize("name", [
    "keyframe_urls", "keyframes", "max_tokens", "token_count", "secretary",
    "passwords_enabled", "monkey", "keyframe", "tokenizer", "key_frames",
])
def test_names_that_merely_contain_a_secret_word_are_kept(store, name):
    job = _create(store, request={"prompt": "p", name: ["https://a/1.png"]})
    assert job["request"] == {"prompt": "p", name: ["https://a/1.png"]}


def test_nested_keyframes_kept_while_nested_secrets_dropped(store):
    job = _create(store, request={
        "shots": [{"keyframe_urls": ["https://a/k1.png"], "upload_token": "t", "max_tokens": 77}],
        "auth": {"Authorization": "Bearer z", "keyframes": 3},
    })
    assert job["request"] == {
        "shots": [{"keyframe_urls": ["https://a/k1.png"], "max_tokens": 77}],
        "auth": {"keyframes": 3},
    }


@pytest.mark.parametrize("name", [
    "apiKey", "accessToken", "clientSecret", "piapiApiKey", "XApiKey", "Authorization",
    "refreshToken", "userPassword", "KIE_API_KEY",
])
def test_camel_case_secret_names_are_dropped(store, name):
    job = _create(store, request={"prompt": "p", name: "s3cr3t-value", "nested": {name: "x"}})
    assert job["request"] == {"prompt": "p", "nested": {}}


@pytest.mark.parametrize("name", [
    "keyframeUrls", "maxTokens", "tokenCount", "callBackUrl", "keyFrames", "secretaryName",
])
def test_camel_case_innocent_names_are_kept(store, name):
    job = _create(store, request={"prompt": "p", name: "v"})
    assert job["request"] == {"prompt": "p", name: "v"}


def test_strip_secrets_ignores_non_string_keys():
    assert job_store.strip_secrets({1: "a", "token": "b"}) == {1: "a"}


def test_secrets_in_request_updates_are_also_stripped(store):
    job = _create(store)
    updated = store.update_job(job["job_id"], request={"prompt": "y", "token": "zzz"})
    assert updated["request"] == {"prompt": "y"}


def test_caller_request_dict_is_not_mutated(store):
    request = {"prompt": "x", "api_key": "k", "nested": {"token": "t"}}
    _create(store, request=request)
    assert request == {"prompt": "x", "api_key": "k", "nested": {"token": "t"}}


# ---------------------------------------------------------------- unicode


def test_unicode_prompt_and_message_round_trip(store, db_path):
    prompt = "猫がサーフィン 🏄‍♀️ — «naïve» ​ ✨ עברית"
    job = _create(store, request={"prompt": prompt})
    store.update_job(job["job_id"], message="Готово ✅", status="RUNNING")
    reread = JobStore(db_path).get_job(job["job_id"])
    assert reread["request"]["prompt"] == prompt
    assert reread["message"] == "Готово ✅"


# ---------------------------------------------------------------- list/filter


def test_list_jobs_newest_first_with_filters_and_limit(store, monkeypatch):
    clock = iter(range(1000, 2000))
    monkeypatch.setattr(job_store.time, "time", lambda: float(next(clock)))
    a = _create(store, source="pipeline")
    b = _create(store, source="mcp")
    c = _create(store, source="mcp")
    store.update_job(b["job_id"], status="COMPLETED")

    ids = [j["job_id"] for j in store.list_jobs()]
    assert ids == [c["job_id"], b["job_id"], a["job_id"]]
    assert [j["job_id"] for j in store.list_jobs(source="mcp")] == [c["job_id"], b["job_id"]]
    assert [j["job_id"] for j in store.list_jobs(status="COMPLETED")] == [b["job_id"]]
    assert [j["job_id"] for j in store.list_jobs(source="pipeline", status="COMPLETED")] == []
    assert [j["job_id"] for j in store.list_jobs(limit=2)] == [c["job_id"], b["job_id"]]


def test_list_jobs_orders_same_timestamp_by_insertion(store, monkeypatch):
    monkeypatch.setattr(job_store.time, "time", lambda: 5.0)
    first = _create(store)
    second = _create(store)
    assert [j["job_id"] for j in store.list_jobs()] == [second["job_id"], first["job_id"]]


def test_list_jobs_rejects_bad_filters(store):
    with pytest.raises(ValueError):
        store.list_jobs(status="DONE")
    with pytest.raises(ValueError):
        store.list_jobs(source="runpod")
    with pytest.raises(ValueError):
        store.list_jobs(limit=0)


def test_list_jobs_clamps_huge_limit(store):
    for _ in range(3):
        _create(store)
    assert len(store.list_jobs(limit=10**9)) == 3


# ---------------------------------------------------------------- cancel


def test_request_cancel_on_active_job_cancels_it(store):
    job = _create(store)
    store.update_job(job["job_id"], status="RUNNING", remote_job_id="r1")
    assert store.is_cancel_requested(job["job_id"]) is False
    snap = store.request_cancel(job["job_id"])
    assert snap["status"] == "CANCELLED"
    assert snap["cancel_requested"] is True
    assert snap["completed_at"] is not None
    assert store.is_cancel_requested(job["job_id"]) is True
    # A worker that polls after cancel cannot resurrect it.
    assert store.update_job(job["job_id"], status="COMPLETED")["status"] == "CANCELLED"


def test_request_cancel_on_terminal_job_is_idempotent_noop(store):
    job = _create(store)
    done = store.update_job(job["job_id"], status="COMPLETED")
    assert store.request_cancel(job["job_id"]) == done
    assert store.request_cancel(job["job_id"]) == done
    assert store.is_cancel_requested(job["job_id"]) is False


def test_request_cancel_twice_on_active_job_is_stable(store):
    job = _create(store)
    first = store.request_cancel(job["job_id"])
    assert store.request_cancel(job["job_id"]) == first


def test_request_cancel_unknown_job_raises(store):
    with pytest.raises(JobNotFoundError):
        store.request_cancel("ghost")
    assert store.is_cancel_requested("ghost") is False


# ---------------------------------------------------------------- annotate


@pytest.mark.parametrize("status", sorted(TERMINAL_STATUSES))
def test_annotate_updates_message_on_terminal_job_and_persists(store, db_path, status):
    job = _create(store)
    store.update_job(job["job_id"], status="RUNNING", remote_job_id="r1")
    if status == "CANCELLED":
        before = store.request_cancel(job["job_id"])
    else:
        before = store.update_job(job["job_id"], status=status)
    snap = store.annotate(job["job_id"], message="Provider may still bill — 請注意")
    assert snap["message"] == "Provider may still bill — 請注意"
    assert snap["status"] == status
    assert snap["completed_at"] == before["completed_at"]
    assert {k: v for k, v in snap.items() if k not in ("message", "updated_at")} == \
        {k: v for k, v in before.items() if k not in ("message", "updated_at")}
    assert JobStore(db_path).get_job(job["job_id"])["message"] == "Provider may still bill — 請注意"


def test_annotate_records_remote_job_id_on_cancelled_job(store):
    job = _create(store)
    store.request_cancel(job["job_id"])
    snap = store.annotate(job["job_id"], remote_job_id="task-late", message="Cancelled late")
    assert snap["remote_job_id"] == "task-late" and snap["status"] == "CANCELLED"
    assert snap["message"] == "Cancelled late"


def test_annotate_works_on_active_job(store):
    job = _create(store)
    snap = store.annotate(job["job_id"], message="hello")
    assert snap["status"] == "QUEUED" and snap["message"] == "hello"


def test_annotate_refuses_to_replace_a_different_remote_job_id(store):
    job = _create(store)
    store.update_job(job["job_id"], status="RUNNING", remote_job_id="r1")
    with pytest.raises(ValueError):
        store.annotate(job["job_id"], remote_job_id="r2")
    assert store.get_job(job["job_id"])["remote_job_id"] == "r1"
    assert store.annotate(job["job_id"], remote_job_id="r1")["remote_job_id"] == "r1"


def test_annotate_publishes_changes_and_skips_no_ops(store):
    job = _create(store)
    events = []
    store.subscribe_callback(events.append)
    store.annotate(job["job_id"], message="one")
    store.annotate(job["job_id"], message="one")
    store.annotate(job["job_id"])
    assert [e["job"]["message"] for e in events] == ["one"]


@pytest.mark.parametrize("fields", [{"message": 5}, {"remote_job_id": ""}, {"remote_job_id": 7}])
def test_annotate_validates_values(store, fields):
    job = _create(store)
    with pytest.raises(ValueError):
        store.annotate(job["job_id"], **fields)


def test_annotate_unknown_job_raises(store):
    with pytest.raises(JobNotFoundError):
        store.annotate("ghost", message="x")


# ---------------------------------------------------------------- persistence / restart


def test_jobs_survive_a_simulated_restart(store, db_path):
    job = _create(store, source="mcp")
    store.update_job(job["job_id"], status="COMPLETED", outputs=[{"kind": "image", "url": "https://x/1.png"}])
    reborn = JobStore(db_path)
    assert reborn.get_job(job["job_id"]) == store.get_job(job["job_id"])
    assert [j["job_id"] for j in reborn.list_jobs(source="mcp")] == [job["job_id"]]


def test_table_creation_is_idempotent_and_leaves_other_tables_alone(db_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", db_path)
    db.init_db()
    JobStore(db_path)
    JobStore(db_path)
    tables = {r[0] for r in sqlite3.connect(db_path).execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"generation_jobs", "runs"} <= tables


def test_recover_after_restart_both_branches(store, db_path):
    queued_local = _create(store)
    running_local = _create(store)
    store.update_job(running_local["job_id"], status="RUNNING")
    queued_remote = _create(store)
    store.update_job(queued_remote["job_id"], remote_job_id="task-q")
    running_remote = _create(store)
    store.update_job(running_remote["job_id"], status="RUNNING", remote_job_id="task-r", progress=0.4)
    finished = _create(store)
    store.update_job(finished["job_id"], status="COMPLETED")

    reborn = JobStore(db_path)
    summary = reborn.recover_after_restart()
    assert sorted(summary["failed"]) == sorted([queued_local["job_id"], running_local["job_id"]])
    assert sorted(summary["resumable"]) == sorted([queued_remote["job_id"], running_remote["job_id"]])

    for jid in (queued_local["job_id"], running_local["job_id"]):
        snap = reborn.get_job(jid)
        assert snap["status"] == "FAILED"
        assert snap["error"]["kind"] == "interrupted"
        assert "restart" in snap["error"]["message"].lower()
        assert snap["completed_at"] is not None

    resumable = {j["job_id"]: j for j in reborn.list_resumable()}
    assert set(resumable) == {queued_remote["job_id"], running_remote["job_id"]}
    assert resumable[running_remote["job_id"]]["status"] == "RUNNING"
    assert resumable[running_remote["job_id"]]["progress"] == 0.4
    assert reborn.get_job(finished["job_id"])["status"] == "COMPLETED"


def test_recover_after_restart_is_idempotent(store, db_path):
    _create(store)
    JobStore(db_path).recover_after_restart()
    again = JobStore(db_path).recover_after_restart()
    assert again == {"failed": [], "resumable": []}


# ---------------------------------------------------------------- concurrency


def test_concurrent_updates_from_many_threads_are_consistent(store):
    jobs = [_create(store) for _ in range(8)]
    errors: list[BaseException] = []
    barrier = threading.Barrier(16)

    def worker(job_id: str, offset: int) -> None:
        try:
            barrier.wait()
            for i in range(25):
                store.update_job(job_id, status="RUNNING", progress=(i + offset) / 100, message=f"t{offset}-{i}")
        except BaseException as exc:  # pragma: no cover - surfaced below
            errors.append(exc)

    threads = [
        threading.Thread(target=worker, args=(j["job_id"], off))
        for j in jobs for off in (0, 50)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    for j in jobs:
        snap = store.get_job(j["job_id"])
        assert snap["status"] == "RUNNING"
        assert snap["message"] in {"t0-24", "t50-24"}


def test_concurrent_cancel_and_complete_ends_in_exactly_one_terminal_state(store):
    for _ in range(20):
        job = _create(store)
        store.update_job(job["job_id"], status="RUNNING")
        barrier = threading.Barrier(2)

        def cancel(jid=job["job_id"]):
            barrier.wait()
            store.request_cancel(jid)

        def complete(jid=job["job_id"]):
            barrier.wait()
            store.update_job(jid, status="COMPLETED")

        ts = [threading.Thread(target=cancel), threading.Thread(target=complete)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        final = store.get_job(job["job_id"])
        assert final["status"] in {"CANCELLED", "COMPLETED"}
        assert final["cancel_requested"] is (final["status"] == "CANCELLED")


# ---------------------------------------------------------------- pub/sub


def test_callback_subscribers_receive_snapshots_for_every_change(store):
    seen: list[dict] = []
    unsubscribe = store.subscribe_callback(seen.append)
    job = _create(store)
    store.update_job(job["job_id"], status="RUNNING")
    store.request_cancel(job["job_id"])
    unsubscribe()
    store.update_job(_create(store)["job_id"], status="RUNNING")

    assert [e["type"] for e in seen] == ["job", "job", "job"]
    assert [e["job"]["status"] for e in seen] == ["QUEUED", "RUNNING", "CANCELLED"]
    assert all(e["job"]["job_id"] == job["job_id"] for e in seen)


def test_a_failing_callback_does_not_break_updates_or_other_subscribers(store):
    seen: list[dict] = []

    def boom(_event):
        raise RuntimeError("subscriber bug")

    u1 = store.subscribe_callback(boom)
    u2 = store.subscribe_callback(seen.append)
    job = _create(store)
    assert store.get_job(job["job_id"])["status"] == "QUEUED"
    assert len(seen) == 1
    u1()
    u2()


def test_asyncio_subscriber_receives_events_published_from_worker_threads(store):
    async def scenario():
        sub = store.subscribe()
        try:
            job = await asyncio.to_thread(_create, store)
            t = threading.Thread(target=store.update_job, args=(job["job_id"],), kwargs={"status": "RUNNING"})
            t.start()
            t.join()
            first = await asyncio.wait_for(sub.get(), timeout=2)
            second = await asyncio.wait_for(sub.get(), timeout=2)
            return job, first, second, store.subscriber_count()
        finally:
            store.unsubscribe(sub)

    job, first, second, count_during = asyncio.run(scenario())
    assert first == {"type": "job", "job": job}
    assert second["type"] == "job"
    assert second["job"] == store.get_job(job["job_id"])
    assert second["job"]["status"] == "RUNNING"
    assert count_during == 1
    assert store.subscriber_count() == 0


def test_slow_asyncio_subscriber_drops_oldest_rather_than_blocking(store):
    async def scenario():
        sub = store.subscribe(maxsize=2)
        try:
            job = _create(store)
            for i in range(5):
                store.update_job(job["job_id"], message=f"m{i}")
            await asyncio.sleep(0)  # let call_soon_threadsafe callbacks drain
            msgs = []
            while not sub.empty():
                msgs.append(sub.get_nowait()["job"]["message"])
            return msgs
        finally:
            store.unsubscribe(sub)

    assert asyncio.run(scenario()) == ["m3", "m4"]


def test_unsubscribe_is_idempotent(store):
    async def scenario():
        sub = store.subscribe()
        store.unsubscribe(sub)
        store.unsubscribe(sub)
        return store.subscriber_count()

    assert asyncio.run(scenario()) == 0


# ---------------------------------------------------------------- default store


def test_default_store_follows_db_path(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "a.db")
    a = job_store.get_store()
    assert a.db_path == tmp_path / "a.db"
    assert job_store.get_store() is a
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "b.db")
    assert job_store.get_store().db_path == tmp_path / "b.db"


# ---------------------------------------------------------------- cost


def test_cost_is_stored_with_the_terminal_update(store):
    job = _create(store)
    cost = {"amount": 205, "unit": "credits", "usd_equivalent": 1.025}
    done = store.update_job(job["job_id"], status="COMPLETED", cost=cost)
    assert done["cost"] == {"amount": 205.0, "unit": "credits", "usd_equivalent": 1.025}
    assert store.get_job(job["job_id"])["cost"] == done["cost"]
    assert store.list_jobs()[0]["cost"] == done["cost"]


def test_cost_without_usd_value_is_kept(store):
    job = _create(store)
    done = store.update_job(job["job_id"], status="FAILED", error={"kind": "x", "message": "y"},
                            cost={"amount": 0, "unit": "points", "usd_equivalent": None})
    assert done["cost"] == {"amount": 0.0, "unit": "points", "usd_equivalent": None}


@pytest.mark.parametrize("bad", [
    "205", 5, {"unit": "credits"}, {"amount": "x", "unit": "credits"}, {"amount": True, "unit": "credits"},
    {"amount": float("nan"), "unit": "credits"}, {"amount": 1, "unit": ""}, {"amount": 1, "unit": 3},
    {"amount": 1, "unit": "credits", "usd_equivalent": "1"}, {"amount": -1, "unit": "credits"},
])
def test_malformed_cost_is_rejected_and_nothing_is_written(store, bad):
    job = _create(store)
    with pytest.raises(ValueError):
        store.update_job(job["job_id"], status="COMPLETED", cost=bad)
    assert store.get_job(job["job_id"])["status"] == "QUEUED"


def test_cost_is_in_published_events(store):
    job = _create(store)
    events = []
    store.subscribe_callback(events.append)
    store.update_job(job["job_id"], status="COMPLETED", cost={"amount": 1, "unit": "credits", "usd_equivalent": None})
    assert events[-1]["job"]["cost"] == {"amount": 1.0, "unit": "credits", "usd_equivalent": None}


def test_rows_written_before_cost_existed_read_back_with_null_cost(db_path):
    """A database created before the `cost` field: the snapshot JSON simply
    lacks it. Reads must fill it in, and updates must still work."""
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "CREATE TABLE generation_jobs (job_id TEXT PRIMARY KEY, source TEXT NOT NULL, status TEXT NOT NULL,"
        " remote_job_id TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL, data TEXT NOT NULL)"
    )
    old = {"job_id": "old-1", "source": "pipeline", "provider": "kie", "model": "wan-3.0",
           "mode": "text_to_video", "status": "RUNNING", "remote_job_id": "r1", "remote_status": None,
           "progress": None, "message": None, "error": None, "outputs": [], "request": {},
           "created_at": 1.0, "updated_at": 1.0, "completed_at": None, "cancel_requested": False}
    done = dict(old, job_id="old-2", status="COMPLETED", completed_at=2.0)
    for job in (old, done):
        conn.execute("INSERT INTO generation_jobs VALUES (?, ?, ?, ?, ?, ?, ?)",
                     (job["job_id"], job["source"], job["status"], job["remote_job_id"], job["created_at"],
                      job["updated_at"], json.dumps(job)))
    conn.commit()
    conn.close()

    store = JobStore(db_path)
    assert store.get_job("old-1")["cost"] is None
    assert store.get_job("old-1")["price_check"] is None
    assert {j["job_id"]: j["cost"] for j in store.list_jobs()} == {"old-1": None, "old-2": None}
    assert [j["cost"] for j in store.list_resumable()] == [None]
    updated = store.update_job("old-1", status="COMPLETED",
                               cost={"amount": 3, "unit": "credits", "usd_equivalent": 0.015})
    assert updated["cost"]["amount"] == 3.0
    assert store.request_cancel("old-2")["cost"] is None


# ---------------------------------------------------------------- restart during submit


def test_restart_while_the_submit_was_in_flight_warns_about_a_possible_charge(store, db_path):
    """A job that stored its provider request but has no remote id may have
    been accepted and billed: it still fails as `interrupted`, but its message
    says so instead of claiming the provider never accepted it."""
    sending = _create(store)
    store.update_job(sending["job_id"], status="RUNNING", message="Sending to Kie",
                     request={"params": {"prompt": "x"},
                              "provider_request": {"method": "POST", "url": "https://api.kie.ai/x", "body": {}}})
    preparing = _create(store)
    store.update_job(preparing["job_id"], status="RUNNING", message="Preparing references")

    summary = JobStore(db_path).recover_after_restart()
    assert sorted(summary["failed"]) == sorted([sending["job_id"], preparing["job_id"]])

    sent = store.get_job(sending["job_id"])
    assert sent["status"] == "FAILED" and sent["error"]["kind"] == "interrupted"
    assert sent["error"]["message"] == job_store.INTERRUPTED_DURING_SUBMIT_MESSAGE == sent["message"]
    text = sent["message"].lower()
    assert "may have accepted" in text and "charged" in text and "dashboard" in text
    assert "before the provider accepted" not in text

    early = store.get_job(preparing["job_id"])
    assert early["status"] == "FAILED" and early["error"]["kind"] == "interrupted"
    assert early["error"]["message"] == job_store.INTERRUPTED_MESSAGE == early["message"]


# ---------------------------------------------------------------- annotate: cost


def test_annotate_records_a_cost_on_a_terminal_job_only_when_it_has_none(store):
    job = _create(store)
    store.request_cancel(job["job_id"])
    cost = {"amount": 12.0, "unit": "credits", "usd_equivalent": 0.06}
    snap = store.annotate(job["job_id"], message="late", cost=cost)
    assert snap["cost"] == cost and snap["status"] == "CANCELLED" and snap["outputs"] == []
    again = store.annotate(job["job_id"], cost={"amount": 99.0, "unit": "credits", "usd_equivalent": None})
    assert again["cost"] == cost
    with pytest.raises(ValueError):
        store.annotate(job["job_id"], cost={"amount": -1, "unit": "credits"})


# ---------------------------------------------------------------- cancel: one source


@pytest.mark.parametrize("status,expected", [("QUEUED", False), ("RUNNING", False), ("COMPLETED", False),
                                             ("FAILED", False), ("TIMED_OUT", False), ("CANCELLED", True)])
def test_is_cancel_requested_follows_the_status(store, status, expected):
    job = _create(store)
    store.update_job(job["job_id"], status=status)
    assert store.is_cancel_requested(job["job_id"]) is expected


def test_request_cancel_still_stores_the_flag(store):
    job = _create(store)
    snap = store.request_cancel(job["job_id"])
    assert snap["cancel_requested"] is True and snap["status"] == "CANCELLED"
    assert store.is_cancel_requested(job["job_id"]) is True
    assert store.is_cancel_requested("no-such-job") is False


# ---------------------------------------------------------------- paging past one list


def test_iter_jobs_pages_through_every_matching_job_newest_first(store):
    created = [_create(store, source="mcp" if n % 2 else "pipeline") for n in range(7)]
    for job in created[:3]:
        store.update_job(job["job_id"], status="COMPLETED")
    every = [j["job_id"] for j in store.iter_jobs(page_size=2)]
    assert every == [j["job_id"] for j in reversed(created)]
    mcp = [j["job_id"] for j in store.iter_jobs(source="mcp", page_size=1)]
    assert mcp == [j["job_id"] for j in reversed(created) if j["source"] == "mcp"]
    done = [j["job_id"] for j in store.iter_jobs(statuses=["COMPLETED"], page_size=2)]
    assert done == [j["job_id"] for j in reversed(created[:3])]
    with pytest.raises(ValueError):
        list(store.iter_jobs(statuses=["BOGUS"]))
    with pytest.raises(ValueError):
        list(store.iter_jobs(page_size=0))


def test_iter_jobs_keeps_order_for_jobs_created_in_the_same_instant(store, monkeypatch):
    monkeypatch.setattr(job_store.time, "time", lambda: 1000.0)
    created = [_create(store) for _ in range(5)]
    assert [j["job_id"] for j in store.iter_jobs(page_size=2)] == [j["job_id"] for j in reversed(created)]


def test_find_active_by_client_request_id_is_not_bounded_by_the_list_limit(store, monkeypatch):
    monkeypatch.setattr(job_store, "MAX_LIST_LIMIT", 2)
    target = _create(store, request={"client_request_id": "cid-1"})
    for n in range(4):
        _create(store, request={"client_request_id": f"cid-other-{n}"})
    assert store.find_active_by_client_request_id("cid-1")["job_id"] == target["job_id"]
    store.update_job(target["job_id"], status="FAILED")
    assert store.find_active_by_client_request_id("cid-1") is None
    assert store.find_active_by_client_request_id("never") is None
