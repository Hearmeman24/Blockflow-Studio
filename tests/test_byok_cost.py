"""Actual cost of a job: adapter normalisation, persistence and the service.

Payloads are built from the saved provider docs' examples
(kie market__common__get-task-detail.md, piapi gemini-api_nano-banana-2.md).
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import (  # noqa: E402
    db,
    job_store,
    output_folder,  # noqa: E402
    settings_store,
)
from backend.byok import service  # noqa: E402
from backend.byok.http import HttpResponse, RetryPolicy  # noqa: E402
from backend.byok.providers import get_adapter  # noqa: E402
from backend.byok.providers.base import Cost  # noqa: E402
from backend.byok.providers.kie import credits_cost  # noqa: E402
from backend.byok.providers.piapi import POINTS_PER_USD, usage_cost  # noqa: E402

KIE_KEY = "kie-COST-SECRET-1234567890"
PI_KEY = "pi-COST-SECRET-0987654321"
FAST = RetryPolicy(max_attempts=1, base_delay_s=0, sleep=lambda s: None)


class FakeTransport:
    def __init__(self, *responses):
        self.responses = list(responses)

    def __call__(self, method, url, headers, body, timeout):
        item = self.responses.pop(0)
        if isinstance(item, HttpResponse):
            return item
        return HttpResponse(200, json.dumps(item).encode())


def kie_record(state="success", **extra):
    data = {"taskId": "task_kie_1", "model": "wan/3-0-video", "state": state, "param": "{}",
            "resultJson": json.dumps({"resultUrls": ["https://cdn.test/v.mp4"]}) if state == "success" else "",
            "failCode": "" if state == "success" else "501", "failMsg": "" if state == "success" else "boom",
            "costTime": 15, "completeTime": 1698765432000, "createTime": 1698765400000, "progress": 100}
    data.update(extra)
    return {"code": 200, "msg": "success", "data": data}


def piapi_task(status="completed", usage=None, meta_extra=None):
    meta = {"created_at": "2026-03-16T08:26:33.495Z", "started_at": "2026-03-16T08:26:35.000Z",
            "ended_at": "2026-03-16T08:27:25.090Z", "is_using_private_pool": False}
    if usage is not None:
        meta["usage"] = usage
    meta.update(meta_extra or {})
    task = {"task_id": "qgycnfg4", "model": "seedance", "task_type": "seedance-2", "status": status,
            "output": {"video": "https://img.theapi.app/v.mp4"} if status == "completed" else None,
            "meta": meta, "error": {"code": 0, "raw_message": "", "message": "", "detail": None}}
    if status == "failed":
        task["error"] = {"code": 10000, "raw_message": "x", "message": "generation failed", "detail": None}
    return {"code": 200, "data": task, "message": "success"}


# ------------------------------------------------------------------ Kie normalisation


def test_kie_completed_task_reports_credits_consumed():
    adapter = get_adapter("kie", transport=FakeTransport(kie_record(creditsConsumed=50)), retry=FAST)
    result = adapter.poll("task_kie_1", KIE_KEY, "video")
    assert result.cost == Cost(50.0, "credits", 0.25)


def test_kie_failed_task_reports_zero_credits():
    adapter = get_adapter("kie", transport=FakeTransport(kie_record("fail", creditsConsumed=0)), retry=FAST)
    result = adapter.poll("task_kie_1", KIE_KEY, "video")
    assert result.status == "FAILED"
    assert result.cost == Cost(0.0, "credits", 0.0)


def test_kie_running_task_has_no_cost_yet():
    adapter = get_adapter("kie", transport=FakeTransport(kie_record("generating", creditsConsumed=12)),
                          retry=FAST)
    assert adapter.poll("task_kie_1", KIE_KEY, "video").cost is None


@pytest.mark.parametrize("value", [None, "", "abc", True, -3, [], {"n": 1}, float("inf")])
def test_kie_missing_or_garbage_credits_are_no_cost(value):
    assert credits_cost(value) is None


def test_kie_decimal_and_string_credits():
    assert credits_cost(1.23) == Cost(1.23, "credits", 0.00615)
    assert credits_cost("205") == Cost(205.0, "credits", 1.025)


# ------------------------------------------------------------------ PiAPI normalisation


def test_piapi_completed_usage_is_points_with_usd():
    usage = {"type": "point", "frozen": 0, "consume": 600000}
    adapter = get_adapter("piapi", transport=FakeTransport(piapi_task(usage=usage)), retry=FAST)
    result = adapter.poll("qgycnfg4", PI_KEY, "video")
    assert result.cost == Cost(600000.0, "points", 0.06)


def test_points_conversion_matches_every_doc_example():
    assert POINTS_PER_USD == 10_000_000
    # nano-banana-2 1K $0.06, nano-banana-2.1 1K $0.03, hailuo 6 s 768p $0.23
    for consume, usd, kind in ((600000, 0.06, "point"), (300000, 0.03, "point"), (2300000, 0.23, "llm")):
        cost = usage_cost({"meta": {"usage": {"type": kind, "frozen": 0, "consume": consume}}}, "COMPLETED")
        assert cost.usd_equivalent == pytest.approx(usd)


def test_piapi_unknown_usage_type_keeps_raw_points_without_usd():
    cost = usage_cost({"meta": {"usage": {"type": "quota", "frozen": 0, "consume": 1234}}}, "COMPLETED")
    assert cost == Cost(1234.0, "points", None)


def test_piapi_still_frozen_is_not_a_cost():
    task = {"meta": {"usage": {"type": "point", "frozen": 600000, "consume": 0}}}
    assert usage_cost(task, "COMPLETED") is None
    assert usage_cost(task, "FAILED") is None


def test_piapi_failed_and_refunded_is_a_zero_cost():
    usage = {"type": "point", "frozen": 0, "consume": 0}
    adapter = get_adapter("piapi", transport=FakeTransport(piapi_task("failed", usage=usage)), retry=FAST)
    result = adapter.poll("qgycnfg4", PI_KEY, "video")
    assert result.status == "FAILED"
    assert result.cost == Cost(0.0, "points", 0.0)


@pytest.mark.parametrize("meta", [None, "x", {}, {"usage": None}, {"usage": "point"},
                                  {"usage": {"type": "point", "consume": "lots"}},
                                  {"usage": {"type": "point", "frozen": 0, "consume": -5}},
                                  {"usage": {"type": "point", "frozen": 0, "consume": True}}])
def test_piapi_missing_or_garbage_usage_is_no_cost(meta):
    assert usage_cost({"meta": meta}, "COMPLETED") is None


def test_piapi_completed_task_without_meta_still_completes():
    body = piapi_task()
    del body["data"]["meta"]
    adapter = get_adapter("piapi", transport=FakeTransport(body), retry=FAST)
    result = adapter.poll("qgycnfg4", PI_KEY, "video")
    assert result.status == "COMPLETED" and result.cost is None


# ------------------------------------------------------------------ service stores the cost


class _Resp(io.BytesIO):
    status = 200

    def __init__(self, data, ctype):
        super().__init__(data)
        self.headers = {"Content-Type": ctype}


@pytest.fixture
def env(tmp_path, monkeypatch):
    db_path = tmp_path / "run_history.db"
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    settings_store.set_credential("kie_api_key", KIE_KEY)
    settings_store.set_credential("piapi_api_key", PI_KEY)
    out = tmp_path / "output"
    out.mkdir()
    monkeypatch.setattr(output_folder, "_state", output_folder.pinned_state(out))
    for name in ("POLL_INITIAL_S", "POLL_MAX_S", "CANCEL_CHECK_S"):
        monkeypatch.setattr(service, name, 0)
    monkeypatch.setattr(service, "sleep", lambda s: None)
    monkeypatch.setattr(service, "open_url", lambda url, timeout: _Resp(b"VIDEO", "video/mp4"))
    transports: dict[str, FakeTransport] = {}
    monkeypatch.setattr(service, "adapter_factory",
                        lambda p, **kw: get_adapter(p, transport=transports[p], retry=FAST))
    yield transports
    service.shutdown()


KIE_VIDEO = {"provider": "kie", "model": "wan-3.0", "mode": "text_to_video", "params": {"prompt": "a fox"}}
PI_VIDEO = {"provider": "piapi", "model": "seedance-2", "mode": "text_to_video", "params": {"prompt": "a fox"}}


def _run(payload):
    job = service.submit_generation(payload)
    return service.wait_for_job(job["job_id"], timeout=10)


def test_completed_kie_job_persists_cost(env):
    env["kie"] = FakeTransport({"code": 200, "msg": "success", "data": {"taskId": "t1"}},
                               kie_record(creditsConsumed=160))
    job = _run(KIE_VIDEO)
    assert job["status"] == "COMPLETED"
    assert job["cost"] == {"amount": 160.0, "unit": "credits", "usd_equivalent": 0.8}
    assert job_store.get_store().get_job(job["job_id"])["cost"] == job["cost"]


def test_failed_kie_job_persists_reported_charge(env):
    env["kie"] = FakeTransport({"code": 200, "msg": "success", "data": {"taskId": "t1"}},
                               kie_record("fail", creditsConsumed=0))
    job = _run(KIE_VIDEO)
    assert job["status"] == "FAILED"
    assert job["cost"] == {"amount": 0.0, "unit": "credits", "usd_equivalent": 0.0}


def test_completed_piapi_job_persists_points_cost(env):
    env["piapi"] = FakeTransport({"code": 200, "data": {"task_id": "p1", "status": "pending"}},
                                 piapi_task(usage={"type": "point", "frozen": 0, "consume": 1000000}))
    job = _run(PI_VIDEO)
    assert job["status"] == "COMPLETED"
    assert job["cost"] == {"amount": 1000000.0, "unit": "points", "usd_equivalent": 0.1}


def test_job_without_reported_cost_keeps_cost_null(env):
    env["kie"] = FakeTransport({"code": 200, "msg": "success", "data": {"taskId": "t1"}}, kie_record())
    job = _run(KIE_VIDEO)
    assert job["status"] == "COMPLETED"
    assert job["cost"] is None
