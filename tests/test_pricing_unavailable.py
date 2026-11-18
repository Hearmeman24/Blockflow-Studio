"""Why there is no estimate: stable codes and plain messages (backend/byok/pricing.py)."""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.byok import price_ledger, pricing, routes  # noqa: E402

BUNDLED = price_ledger.load_bundled()
AFTER = "The actual charge will be shown after the run."


@pytest.fixture(autouse=True)
def bundled_only(monkeypatch):
    monkeypatch.setattr(pricing, "ledger_provider", lambda: (BUNDLED, "bundled"))
    monkeypatch.setattr(pricing, "observed_provider", lambda key: None)


def why(provider, model, mode, params, refs=()):
    estimate, unavailable = pricing.explain_cost(provider, model, mode, params, list(refs))
    assert estimate is None, estimate
    assert unavailable["message"].endswith(AFTER)
    return unavailable


IMG = {"kind": "image", "url": "https://x.test/a.png"}


def test_priced_per_token_comes_from_the_ledger_note():
    for tier in ("flare", "sunburst"):
        u = why("kie", "gpt-image-2.6", "text_to_image", {"prompt": "a lighthouse", "settings": {"tier": tier}})
        assert u["code"] == "priced_per_token"
        assert u["message"].startswith("Kie prices this model per token")
    # Economy has a flat price, so it is estimated
    est, unavailable = pricing.explain_cost("kie", "gpt-image-2.6", "text_to_image",
                                            {"prompt": "a lighthouse", "settings": {"tier": "economy"}}, [])
    assert est["amount"] == 5 and unavailable is None


def test_auto_duration_is_computed_from_the_request():
    u = why("kie", "seedance-2", "text_to_video", {"prompt": "a fox", "duration": -1})
    assert u["code"] == "auto_duration"
    assert "auto" in u["message"]


def test_input_video_billing_unknown():
    refs = [{"kind": "video", "url": "https://x.test/a.mp4", "duration_s": 3}]
    u = why("kie", "kling-4.0-flash", "omni_reference_to_video", {"prompt": "a fox", "duration": 5}, refs)
    assert u["code"] == "input_video_billing_unknown"
    assert u["message"].startswith("Kie lists a rate for input video")
    # without an input video the same model is priced
    assert pricing.explain_cost("kie", "kling-4.0-flash", "omni_reference_to_video",
                                {"prompt": "a fox", "duration": 5}, [IMG])[0]["amount"] == 85


def test_conflicting_sources():
    for settings in ({}, {"less_restriction": True}):
        u = why("piapi", "seedream-5-lite", "text_to_image", {"prompt": "a lighthouse", "settings": settings})
        assert u["code"] == "conflicting_sources"
        assert u["message"].startswith("PiAPI's own pages give two different prices")


def test_no_published_price_when_the_ledger_lacks_a_row(monkeypatch):
    data = price_ledger.ledger_json(BUNDLED)
    data["entries"] = [e for e in data["entries"] if not (e["model"] == "wan/3-0-video" and e["resolution"] == "480p")]
    trimmed = price_ledger.validate_ledger(data)
    monkeypatch.setattr(pricing, "ledger_provider", lambda: (trimmed, "bundled"))
    u = why("kie", "wan-3.0", "text_to_video", {"prompt": "a fox", "duration": 5, "resolution": "480P"})
    assert u["code"] == "no_published_price"
    assert u["message"].startswith("Kie has not published a price for this model or setting.")


def test_not_priceable_request_for_invalid_or_unknown_requests():
    assert why("kie", "no-such-model", "text_to_video", {"prompt": "a fox"})["code"] == "not_priceable_request"
    assert why("kie", "seedance-2", "text_to_video", {"prompt": "a fox", "duration": 99})["code"] == \
        "not_priceable_request"
    # upscale is priced by output size, unknown without the image's dimensions
    u = why("kie", "image-upscaler", "image_to_image", {}, [IMG])
    assert u["code"] == "not_priceable_request" and "size" in u["message"]


def test_a_priced_request_has_no_unavailable():
    est, unavailable = pricing.explain_cost("kie", "wan-3.0", "text_to_video",
                                            {"prompt": "a fox", "duration": 5, "resolution": "1080P"}, [])
    assert est["amount"] == 160 and unavailable is None


def test_estimate_cost_is_unchanged_for_callers():
    assert pricing.estimate_cost("kie", "seedance-2", "text_to_video", {"prompt": "a fox", "duration": -1}, []) is None


def test_inputs_are_not_mutated():
    params = {"prompt": "a fox", "duration": 5, "settings": {"tier": "flare"}}
    before = copy.deepcopy(params)
    pricing.explain_cost("kie", "gpt-image-2.6", "text_to_image", params, [])
    assert params == before


# ------------------------------------------------------------------ notes in the ledger


def test_notes_are_validated():
    data = price_ledger.ledger_json(BUNDLED)
    assert data["not_priceable"], "the bundled ledger carries the not-priceable notes"
    for bad in ({"code": "because"}, {"provider": "fal"}, {"message": ""}, {"source": "http://x"},
                {"variant": "With Video"}, {"extra": 1}):
        broken = copy.deepcopy(data)
        broken["not_priceable"][0].update(bad)
        with pytest.raises(price_ledger.LedgerError):
            price_ledger.validate_ledger(broken)


def test_notes_come_from_the_model_map():
    model_map = json.loads(price_ledger.MODEL_MAP_PATH.read_text())
    assert [dict(n) for n in price_ledger.ledger_json(BUNDLED)["not_priceable"]] == model_map["not_priceable"]


# ------------------------------------------------------------------ generated coverage list


def _gen():
    import importlib.util

    spec = importlib.util.spec_from_file_location("gen_byok_docs", ROOT / "scripts" / "gen_byok_docs.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["gen_byok_docs"] = mod
    spec.loader.exec_module(mod)
    return mod


def test_coverage_list_matches_the_ledger():
    gen = _gen()
    rows = gen.coverage_rows(BUNDLED)
    codes = {code for r in rows for code in r["missing"]}
    # every case either has a price or a reason that comes from the ledger notes or the request
    assert codes <= {"priced_per_token", "input_video_billing_unknown", "conflicting_sources", "no_published_price"}
    assert "not_priceable_request" not in codes, "a coverage probe request is invalid; fix _coverage_cases"
    # every not-priceable note shows up in the list
    text = gen.render_coverage()
    for note in BUNDLED.notes:
        assert f"`{note.code}`" in text
    flare = next(r for r in rows if r["model_id"] == "gpt-image-2.6" and r["variant"] == "tier flare"
                 and r["mode"] == "text_to_image")
    assert flare["priced"] == [] and set(flare["missing"]) == {"priced_per_token"}
    wan = next(r for r in rows if r["model_id"] == "wan-3.0" and r["mode"] == "text_to_video")
    assert wan["missing"] == {} and wan["priced"] == ["480P", "720P", "1080P"]


# ------------------------------------------------------------------ route


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app) as c:
        yield c


def test_route_shape_without_an_estimate(client):
    body = {"provider": "kie", "model": "seedance-2", "mode": "text_to_video", "params": {"duration": -1},
            "references": []}
    res = client.post("/api/generation/estimate", json=body)
    assert res.status_code == 200
    assert res.json() == {"ok": True, "estimate": None, "unavailable": {
        "code": "auto_duration",
        "message": "The length is set to auto, so the cost depends on how long the result is. " + AFTER}}


def test_route_shape_with_an_estimate_is_unchanged(client):
    body = {"provider": "kie", "model": "wan-3.0", "mode": "text_to_video",
            "params": {"duration": 5, "resolution": "1080P"}, "references": []}
    data = client.post("/api/generation/estimate", json=body).json()
    assert set(data) == {"ok", "estimate"}
    assert data["estimate"]["amount"] == 160


def test_route_with_missing_fields(client):
    data = client.post("/api/generation/estimate", json={"params": {}}).json()
    assert data["estimate"] is None and data["unavailable"]["code"] == "not_priceable_request"
