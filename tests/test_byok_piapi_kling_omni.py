"""PiAPI does not run Kling 4.0 (or Kling 4.0 Flash) in Omni Reference to Video.

A real submit on 2026-11-18 (kling-4.0, one image and one video reference,
720p, 5 s) was refused by PiAPI with "Kling 4.0 Omni generation is not
available yet." Both models went through the same ``omni_video_generation``
task type, differing only in ``version``, so neither is offered there now.
Kie's Kling 4.0 Omni Reference to Video and PiAPI's Kling text and image to
video are unchanged.

A saved flow or an MCP caller can still name the combination: every entry
point refuses it before any HTTP request is sent.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import db, job_store, output_folder, settings_store  # noqa: E402
from backend.byok import catalog, ledger, pricing, routes, service  # noqa: E402
from backend.byok.errors import ProviderError  # noqa: E402
from backend.byok.http import RetryPolicy  # noqa: E402
from backend.byok.providers import get_adapter  # noqa: E402
from backend.byok.spec import Reference  # noqa: E402
from backend.byok.validation import validate_request  # noqa: E402

OMNI = "omni_reference_to_video"
MODELS = ("kling-4.0", "kling-4.0-flash")
PI_KEY = "pi-KLING-OMNI-SECRET-0987654321"
KIE_KEY = "kie-KLING-OMNI-SECRET-1234567890"
REFS = [{"kind": "image", "url": "https://cdn.test/a.png"},
        {"kind": "video", "url": "https://cdn.test/b.mp4", "duration_s": 5}]
PARAMS = {"prompt": "@image_1 walks into @video_1", "duration": 5, "resolution": "720p"}
FAST = RetryPolicy(max_attempts=1, base_delay_s=0, sleep=lambda s: None)


class RecordingTransport:
    """Records every request; answering one is a test failure."""

    def __init__(self):
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url})
        raise AssertionError(f"no request may be sent, got {method} {url}")


def _body(model):
    return {"provider": "piapi", "model": model, "mode": OMNI, "params": PARAMS, "references": REFS}


# ------------------------------------------------------------------ ledger


@pytest.mark.parametrize("model_id", MODELS)
def test_piapi_kling_omni_is_not_supported(model_id):
    spec = ledger.get_mode_spec("piapi", model_id, OMNI)
    assert spec is not None and spec.supported is False
    assert "PiAPI" in spec.unavailable_reason and "Kie" in spec.unavailable_reason
    assert spec.ids is None and spec.media == () and spec.settings == ()


@pytest.mark.parametrize("model_id", MODELS)
@pytest.mark.parametrize("mode", ["text_to_video", "image_to_video"])
def test_piapi_kling_text_and_image_to_video_are_still_offered(model_id, mode):
    spec = ledger.get_mode_spec("piapi", model_id, mode)
    assert spec.supported is True and spec.ids.task_type == "video_generation"


@pytest.mark.parametrize("model_id", MODELS)
def test_kie_kling_omni_is_still_offered(model_id):
    spec = ledger.get_mode_spec("kie", model_id, OMNI)
    assert spec.supported is True and spec.ids.model.endswith("reference-to-video")


def test_no_piapi_offering_uses_the_omni_task_type():
    used = {(o.provider, s.ids.model, s.ids.task_type)
            for m in catalog.CATALOG for o in m.offerings for s in o.modes if s.supported and s.ids}
    assert ("piapi", "kling", "omni_video_generation") not in used


def test_the_refusal_is_recorded_with_the_provider_message_and_date():
    entries = [u for u in catalog.UNVERIFIED
               if u.provider == "piapi" and u.field == OMNI and "kling-4.0" in u.model]
    assert len(entries) == 1
    (entry,) = entries
    assert "kling-4.0-flash" in entry.model
    assert "2026-11-18" in entry.detail
    assert "Kling 4.0 Omni generation is not available yet." in entry.detail
    assert "omni_video_generation" in entry.detail
    payload = ledger.catalog_payload(set())
    assert {"provider": "piapi", "model": entry.model, "field": OMNI, "detail": entry.detail} in payload["unverified"]


# ------------------------------------------------------------------ validation, adapter, estimate


@pytest.mark.parametrize("model_id", MODELS)
def test_validation_refuses_with_mode_unsupported(model_id):
    issues = validate_request("piapi", model_id, OMNI, PARAMS, REFS)
    assert [i.code for i in issues] == ["mode_unsupported"]
    assert "Omni Reference to Video" in issues[0].message and "Kie" in issues[0].message


@pytest.mark.parametrize("model_id", MODELS)
def test_adapter_refuses_before_sending(model_id):
    transport = RecordingTransport()
    adapter = get_adapter("piapi", transport=transport, retry=FAST)
    with pytest.raises(ProviderError) as exc:
        adapter.build_request(model_id, OMNI, PARAMS, [Reference("image", "https://cdn.test/a.png")])
    assert exc.value.kind == "unsupported" and exc.value.provider_code == "mode_unsupported"
    assert transport.calls == []


@pytest.mark.parametrize("model_id", MODELS)
def test_estimate_is_unavailable(model_id):
    assert pricing.estimate_cost("piapi", model_id, OMNI, PARAMS, references=REFS) is None


# ------------------------------------------------------------------ HTTP surface (what a saved flow and MCP call)


@pytest.fixture
def env(tmp_path, monkeypatch):
    db_path = tmp_path / "run_history.db"
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    out = tmp_path / "output"
    out.mkdir()
    monkeypatch.setattr(output_folder, "_state", output_folder.pinned_state(out))
    transports = {"kie": RecordingTransport(), "piapi": RecordingTransport()}
    monkeypatch.setattr(service, "adapter_factory",
                        lambda provider, **kw: get_adapter(provider, transport=transports[provider], retry=FAST))
    settings_store.set_credential("piapi_api_key", PI_KEY)
    settings_store.set_credential("kie_api_key", KIE_KEY)
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app) as client:
        yield client, transports
    service.shutdown()


def test_catalog_route_does_not_offer_it_and_keeps_kie(env):
    client, transports = env
    body = client.get("/api/providers/catalog").json()
    for model_id in MODELS:
        model = next(m for m in body["models"] if m["id"] == model_id)
        piapi = model["providers"]["piapi"]
        assert piapi["available"] is True  # PiAPI still offers the model in its other modes
        omni = piapi["modes"][OMNI]
        assert omni["supported"] is False and omni["available"] is False
        assert "PiAPI" in omni["unavailable_reason"]
        assert piapi["modes"]["text_to_video"]["available"] is True
        assert piapi["modes"]["image_to_video"]["available"] is True
        kie = model["providers"]["kie"]["modes"][OMNI]
        assert kie["supported"] is True and kie["available"] is True
    assert PI_KEY not in json.dumps(body) and KIE_KEY not in json.dumps(body)
    assert transports["piapi"].calls == [] and transports["kie"].calls == []


@pytest.mark.parametrize("model_id", MODELS)
def test_validate_estimate_and_submit_routes_refuse_without_a_request(env, model_id):
    client, transports = env
    checked = client.post("/api/generation/validate", json=_body(model_id)).json()
    assert checked["ok"] is False
    assert [i["code"] for i in checked["issues"] if i["severity"] == "error"] == ["mode_unsupported"]

    estimate = client.post("/api/generation/estimate", json=_body(model_id))
    assert estimate.status_code == 200 and estimate.json()["estimate"] is None

    submitted = client.post("/api/generation/submit", json=_body(model_id))
    assert submitted.status_code == 422
    data = submitted.json()
    assert data["ok"] is False and data["kind"] == "validation"
    assert [i["code"] for i in data["issues"]] == ["mode_unsupported"]
    assert "Omni Reference to Video" in data["error"]
    assert job_store.get_store().list_jobs() == []
    assert transports["piapi"].calls == [] and transports["kie"].calls == []
