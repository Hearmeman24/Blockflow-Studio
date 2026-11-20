"""HTTP surface: backend/byok/routes.py on a bare FastAPI app."""

from __future__ import annotations

import io
import json
import logging
import sys
import threading
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import (  # noqa: E402
    db,
    job_store,
    output_folder,  # noqa: E402
    settings_store,
)
from backend.byok import references, routes, service  # noqa: E402
from backend.byok.errors import ProviderError  # noqa: E402
from backend.byok.http import HttpResponse, RetryPolicy  # noqa: E402
from backend.byok.providers import get_adapter  # noqa: E402

KIE_KEY = "kie-ROUTE-SECRET-1234567890"
PI_KEY = "pi-ROUTE-SECRET-0987654321"
FAST = RetryPolicy(max_attempts=1, base_delay_s=0, sleep=lambda s: None)


class FakeTransport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "headers": dict(headers), "body": body})
        item = self.responses.pop(0)
        if isinstance(item, BaseException):
            raise item
        if isinstance(item, HttpResponse):
            return item
        return HttpResponse(200, json.dumps(item).encode())


class GatedTransport:
    """Accepts one createTask, then answers every poll with "generating" once
    ``gate`` is set (so a test can act while the job is RUNNING)."""

    def __init__(self, task):
        self.task = task
        self.calls = []
        self.polled = threading.Event()
        self.gate = threading.Event()

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url})
        if url.endswith("/createTask"):
            return HttpResponse(200, json.dumps({"code": 200, "msg": "success", "data": {"taskId": self.task}}).encode())
        self.polled.set()
        self.gate.wait(10)
        return HttpResponse(200, json.dumps({"code": 200, "data": {"state": "generating"}}).encode())


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
    out = tmp_path / "output"
    out.mkdir()
    monkeypatch.setattr(output_folder, "_state", output_folder.pinned_state(out))
    for name in ("POLL_INITIAL_S", "POLL_MAX_S", "CANCEL_CHECK_S"):
        monkeypatch.setattr(service, name, 0)
    monkeypatch.setattr(service, "sleep", lambda s: None)
    monkeypatch.setattr(service, "open_url", lambda url, timeout: _Resp(b"VIDEO", "video/mp4"))
    transports: dict[str, FakeTransport] = {}

    def factory(provider, **kw):
        return get_adapter(provider, transport=transports[provider], retry=FAST)

    monkeypatch.setattr(service, "adapter_factory", factory)
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app) as client:
        yield client, transports, out
    service.shutdown()


def _kie_success(task="t-1", url="https://cdn.test/v.mp4"):
    return ({"code": 200, "msg": "success", "data": {"taskId": task}},
            {"code": 200, "data": {"state": "success", "resultJson": json.dumps({"resultUrls": [url]})}})


VIDEO = {"provider": "kie", "model": "wan-3.0", "mode": "text_to_video", "params": {"prompt": "a fox 🦊"}}


# ------------------------------------------------------------------ catalog


def test_catalog_carries_fast_for_every_model(env):
    client, _, _ = env
    models = client.get("/api/providers/catalog").json()["models"]
    assert all(isinstance(m["fast"], bool) for m in models)
    assert {m["id"] for m in models if m["fast"]} == {"wan-3.0-prime"}


def test_catalog_reflects_configured_keys(env):
    client, _, _ = env
    body = client.get("/api/providers/catalog").json()
    assert body["providers"]["kie"]["configured"] is False
    assert body["providers"]["piapi"]["configured"] is False

    settings_store.set_credential("kie_api_key", KIE_KEY)
    settings_store.set_credential("piapi_api_key", "   ")
    body = client.get("/api/providers/catalog").json()
    assert body["providers"]["kie"]["configured"] is True
    assert body["providers"]["piapi"]["configured"] is False
    wan = next(m for m in body["models"] if m["id"] == "wan-3.0")
    assert wan["available"] is True
    assert KIE_KEY not in json.dumps(body)


# ------------------------------------------------------------------ validate-key


def test_validate_key_uses_stored_key_and_never_echoes_it(env):
    client, transports, _ = env
    settings_store.set_credential("kie_api_key", KIE_KEY)
    transports["kie"] = FakeTransport({"code": 200, "msg": "success", "data": 123.5})
    r = client.post("/api/providers/kie/validate-key")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "valid": True, "message": "Kie API key is valid.", "balance": 123.5,
                        "balance_unit": "credits"}
    assert transports["kie"].calls[0]["headers"]["Authorization"] == f"Bearer {KIE_KEY}"
    assert KIE_KEY not in r.text


def test_validate_key_rejected(env):
    client, transports, _ = env
    settings_store.set_credential("piapi_api_key", PI_KEY)
    transports["piapi"] = FakeTransport(HttpResponse(401, json.dumps({"code": 401, "message": "bad"}).encode()))
    body = client.post("/api/providers/piapi/validate-key").json()
    assert body["ok"] is True and body["valid"] is False
    assert body["message"]
    assert PI_KEY not in json.dumps(body)


def test_validate_key_without_stored_key(env):
    client, transports, _ = env
    transports["kie"] = FakeTransport()
    body = client.post("/api/providers/kie/validate-key").json()
    assert body["ok"] is True and body["valid"] is False
    assert "Settings" in body["message"]
    assert transports["kie"].calls == []


def test_validate_key_ignores_key_in_body(env):
    client, transports, _ = env
    transports["kie"] = FakeTransport()
    body = client.post("/api/providers/kie/validate-key", json={"api_key": "sk-body-key-123"}).json()
    assert body["valid"] is False
    assert transports["kie"].calls == []


def test_validate_key_network_failure(env):
    client, transports, _ = env
    settings_store.set_credential("kie_api_key", KIE_KEY)
    transports["kie"] = FakeTransport(ProviderError("network", f"down {KIE_KEY}", retryable=False))
    r = client.post("/api/providers/kie/validate-key")
    body = r.json()
    assert r.status_code == 502
    assert body["ok"] is False and body["valid"] is None and body["kind"] == "network"
    assert KIE_KEY not in r.text


def test_validate_key_unknown_provider_is_404(env):
    client, _, _ = env
    r = client.post("/api/providers/openai/validate-key")
    assert r.status_code == 404
    assert r.json()["ok"] is False


# ------------------------------------------------------------------ generation/validate


def test_generation_validate_ok_and_issues(env):
    client, transports, _ = env
    transports["kie"] = FakeTransport()
    ok = client.post("/api/generation/validate", json=VIDEO).json()
    assert ok["ok"] is True and [i for i in ok["issues"] if i["severity"] == "error"] == []

    bad = client.post("/api/generation/validate", json={**VIDEO, "params": {"prompt": ""}}).json()
    assert bad["ok"] is False
    assert "prompt_required" in [i["code"] for i in bad["issues"]]
    assert job_store.get_store().list_jobs() == []
    assert transports["kie"].calls == []


def test_generation_validate_malformed_json(env):
    client, _, _ = env
    r = client.post("/api/generation/validate", content=b"{not json", headers={"Content-Type": "application/json"})
    assert r.status_code == 422
    assert r.json()["ok"] is False and r.json()["issues"][0]["code"] == "invalid_payload"


# ------------------------------------------------------------------ generation/submit


def test_submit_happy_path(env):
    client, transports, out = env
    settings_store.set_credential("kie_api_key", KIE_KEY)
    transports["kie"] = FakeTransport(*_kie_success())
    r = client.post("/api/generation/submit", json={**VIDEO, "client_request_id": "c-1"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["job"]["provider"] == "kie"
    final = service.wait_for_job(body["job"]["job_id"], timeout=10)
    assert final["status"] == "COMPLETED"
    local = final["outputs"][0]["local_url"]
    assert (out / "byok" / local.rsplit("/", 1)[1]).read_bytes() == b"VIDEO"
    # job is visible through the existing job store
    assert job_store.get_store().get_job(final["job_id"])["outputs"] == final["outputs"]
    assert KIE_KEY not in r.text


def test_submit_validation_failure_is_422_with_issues(env):
    client, transports, _ = env
    settings_store.set_credential("kie_api_key", KIE_KEY)
    transports["kie"] = FakeTransport()
    r = client.post("/api/generation/submit", json={**VIDEO, "params": {"prompt": ""}})
    assert r.status_code == 422
    body = r.json()
    assert body["ok"] is False and body["error"] and body["kind"] == "validation"
    assert "prompt_required" in [i["code"] for i in body["issues"]]
    assert job_store.get_store().list_jobs() == []


def test_submit_missing_key_is_400_auth(env):
    client, transports, _ = env
    transports["kie"] = FakeTransport()
    r = client.post("/api/generation/submit", json=VIDEO)
    assert r.status_code == 400
    body = r.json()
    assert body["ok"] is False and body["kind"] == "auth" and "Settings" in body["error"]
    assert job_store.get_store().list_jobs() == []


@pytest.mark.parametrize("content", [b"{oops", b"[1, 2]", b'"text"', b""])
def test_submit_malformed_body_is_422(env, content):
    client, _, _ = env
    r = client.post("/api/generation/submit", content=content, headers={"Content-Type": "application/json"})
    assert r.status_code == 422
    assert r.json()["ok"] is False


def test_submit_duplicate_client_request_id_returns_same_job(env):
    client, transports, _ = env
    settings_store.set_credential("kie_api_key", KIE_KEY)
    transports["kie"] = gated = GatedTransport("t-d")
    a = client.post("/api/generation/submit", json={**VIDEO, "client_request_id": "dup"}).json()["job"]
    assert gated.polled.wait(10)
    b = client.post("/api/generation/submit", json={**VIDEO, "client_request_id": "dup"}).json()["job"]
    assert a["job_id"] == b["job_id"]
    job_store.get_store().request_cancel(a["job_id"])
    gated.gate.set()
    service.wait_for_job(a["job_id"], timeout=10)
    creates = [c for c in transports["kie"].calls if c["url"].endswith("/createTask")]
    assert len(creates) == 1


def test_submit_reports_the_job_phase(env):
    client, transports, _ = env
    settings_store.set_credential("kie_api_key", KIE_KEY)
    transports["kie"] = gated = GatedTransport("t-ph")
    a = client.post("/api/generation/submit", json={**VIDEO, "client_request_id": "ph"}).json()["job"]
    try:
        assert a.get("phase") in ("preparing", "submitting", "polling")
        assert gated.polled.wait(10)
        b = client.post("/api/generation/submit", json={**VIDEO, "client_request_id": "ph"}).json()["job"]
        assert b["job_id"] == a["job_id"] and b.get("phase") == "polling"
    finally:
        job_store.get_store().request_cancel(a["job_id"])
        gated.gate.set()
    final = service.wait_for_job(a["job_id"], timeout=10)
    assert final["status"] == "CANCELLED" and "phase" not in final


def test_submit_conflicting_client_request_id_is_409(env):
    client, transports, _ = env
    settings_store.set_credential("kie_api_key", KIE_KEY)
    transports["kie"] = gated = GatedTransport("t-c")
    a = client.post("/api/generation/submit", json={**VIDEO, "client_request_id": "cx"}).json()["job"]
    assert gated.polled.wait(10)
    r = client.post("/api/generation/submit", json={**VIDEO, "model": "wan-3.0-prime", "client_request_id": "cx"})
    assert r.status_code == 409 and r.json()["kind"] == "conflict"
    job_store.get_store().request_cancel(a["job_id"])
    gated.gate.set()
    service.wait_for_job(a["job_id"], timeout=10)


def test_key_never_in_responses_or_logs(env, caplog):
    caplog.set_level(logging.DEBUG)
    client, transports, _ = env
    settings_store.set_credential("kie_api_key", KIE_KEY)
    transports["kie"] = FakeTransport(HttpResponse(401, json.dumps({"code": 401, "msg": f"bad {KIE_KEY}"}).encode()))
    r = client.post("/api/generation/submit", json=VIDEO)
    final = service.wait_for_job(r.json()["job"]["job_id"], timeout=10)
    assert final["status"] == "FAILED" and final["error"]["kind"] == "auth"
    for text in (r.text, json.dumps(final), caplog.text,
                 client.get("/api/providers/catalog").text):
        assert KIE_KEY not in text


# ------------------------------------------------------------------ check-references


def test_check_references_route(env, monkeypatch):
    client, _, out = env
    (out / "a.png").write_bytes(b"x")
    calls = []

    def probe(method, url, headers, body, timeout):
        calls.append((method, url))
        return HttpResponse(410 if "gone" in url else 200, b"")

    monkeypatch.setattr(references, "probe_transport", probe)
    r = client.post("/api/generation/check-references", json={"references": [
        {"kind": "image", "local": "/outputs/a.png"},
        {"kind": "image", "url": "https://cdn.test/gone.png"},
        {"kind": "image", "url": "https://cdn.test/ok.png"},
        {"kind": "image", "local": "/outputs/../../etc/passwd"},
        {"kind": "image", "local": "/outputs/missing.png"},
        {"kind": "image", "url": "asset://lib-42"},
    ]})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert [x["status"] for x in body["results"]] == ["ok", "expired", "ok", "malformed", "missing_local",
                                                      "unchecked"]
    assert [x["index"] for x in body["results"]] == [0, 1, 2, 3, 4, 5]
    assert not any("asset://" in url for _, url in calls)


# ------------------------------------------------------------------ real app wiring


def test_real_app_serves_catalog_and_validate(env):
    from backend import main

    paths = {getattr(r, "path", None) for r in main.app.routes}
    assert {"/api/providers/catalog", "/api/providers/{provider}/validate-key", "/api/generation/validate",
            "/api/generation/submit", "/api/generation/check-references"} <= paths
    settings_store.set_credential("kie_api_key", KIE_KEY)
    with TestClient(main.app) as client:
        catalog = client.get("/api/providers/catalog")
        assert catalog.status_code == 200
        assert catalog.json()["providers"]["kie"]["configured"] is True
        assert catalog.json()["providers"]["piapi"]["configured"] is False
        assert KIE_KEY not in catalog.text
        bad = client.post("/api/generation/validate", json={**VIDEO, "params": {"prompt": ""}})
        assert bad.status_code == 200 and bad.json()["ok"] is False
        assert "prompt_required" in [i["code"] for i in bad.json()["issues"]]
        good = client.post("/api/generation/validate", json=VIDEO).json()
        assert good["ok"] is True
    assert job_store.get_store().list_jobs() == []


def test_startup_resume_fails_stranded_and_resumes_accepted_jobs(env, capsys):
    from backend import main

    _, transports, _ = env
    settings_store.set_credential("kie_api_key", KIE_KEY)
    transports["kie"] = FakeTransport({"code": 200, "data": {
        "state": "success", "resultJson": json.dumps({"resultUrls": ["https://cdn.test/r.mp4"]})}})
    store = job_store.get_store()
    stranded = store.create_job(source="pipeline", provider="kie", model="wan-3.0", mode="text_to_video")
    accepted = store.create_job(source="pipeline", provider="kie", model="wan-3.0", mode="text_to_video")
    store.update_job(accepted["job_id"], status="RUNNING", remote_job_id="task-7")

    summary = main._resume_generation_jobs_on_startup()

    assert summary == {"failed": [stranded["job_id"]], "resumed": [accepted["job_id"]]}
    assert store.get_job(stranded["job_id"])["error"]["kind"] == "interrupted"
    final = service.wait_for_job(accepted["job_id"], timeout=10)
    assert final["status"] == "COMPLETED"
    assert [c["method"] for c in transports["kie"].calls] == ["GET"]  # polled, never resubmitted
    out = capsys.readouterr().out
    assert "1 interrupted" in out and "1 resumed" in out


def test_startup_resume_never_raises(env, monkeypatch, capsys):
    from backend import main

    def broken():
        raise RuntimeError("disk gone")

    monkeypatch.setattr(service, "resume_pending", broken)
    assert main._resume_generation_jobs_on_startup() is None
    assert "disk gone" in capsys.readouterr().out


def test_old_recovery_hook_is_gone():
    from backend import main

    assert not hasattr(main, "_recover_generation_jobs_on_startup")


@pytest.mark.parametrize("payload", [{"references": "nope"}, {}, [1]])
def test_check_references_malformed_body(env, payload):
    client, _, _ = env
    r = client.post("/api/generation/check-references", json=payload)
    assert r.status_code == 422
    assert r.json()["ok"] is False
