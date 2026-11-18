"""Pre-run estimates from the stored price table (backend/byok/pricing.py)."""

from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.byok import price_ledger, pricing, routes, service  # noqa: E402
from backend.byok.spec import Reference  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def est(provider, model, mode, params=None, refs=None):
    return pricing.estimate_cost(provider, model, mode, params or {}, refs or [])


# ------------------------------------------------------------------ the table
#
# These tests price against the 2026-11-15 snapshot ledger (the table that
# used to live in pricing.py), so every estimate below is a regression check
# that loading prices from the ledger changed nothing. Learned prices are off.

SNAPSHOT = price_ledger.load_file(ROOT / "tests" / "fixtures" / "pricing" / "snapshot-2026-11-15.json")


@pytest.fixture(autouse=True)
def snapshot_ledger(monkeypatch):
    monkeypatch.setattr(pricing, "ledger_provider", lambda: (SNAPSHOT, "bundled"))
    monkeypatch.setattr(pricing, "observed_provider", lambda key: None)


def test_every_entry_has_unit_source_and_date():
    assert SNAPSHOT.entries, "the table must not be empty"
    for entry in SNAPSHOT.entries:
        assert entry.unit in price_ledger.UNITS, entry
        assert entry.amount > 0, entry
        assert SNAPSHOT.sources[entry.source]["url"].startswith("https://"), entry
        assert entry.as_of == "2026-11-15", entry
        assert entry.provider in ("kie", "piapi"), entry


def test_table_keys_are_unique():
    keys = [e.key for e in SNAPSHOT.entries]
    assert len(keys) == len(set(keys))


def test_units_match_provider():
    for entry in SNAPSHOT.entries:
        if entry.provider == "kie":
            assert entry.unit.startswith("credits_"), entry
        else:
            assert entry.unit.startswith("usd_"), entry


def test_estimates_name_their_price_layer():
    e = est("kie", "wan-3.0", "text_to_video", {"prompt": "x", "duration": 5, "resolution": "1080P"})
    assert e["price_source"] == "bundled"
    assert e["price_updated_at"] == SNAPSHOT.generated_at


def test_the_bundled_ledger_prices_more_than_the_snapshot(monkeypatch):
    monkeypatch.setattr(pricing, "ledger_provider", lambda: (price_ledger.load_bundled(), "bundled"))
    e = est("kie", "seedance-2", "omni_reference_to_video", {"prompt": "x", "duration": 5, "resolution": "720p"},
            [{"kind": "video", "url": "https://x.test/a.mp4", "duration_s": 3}])
    assert e["amount"] == pytest.approx(25 * 8)
    assert est("kie", "seedance-2-mini", "text_to_video", {"prompt": "x", "duration": 5,
                                                           "resolution": "720p"})["amount"] == pytest.approx(41)
    assert est("kie", "wan-3.0", "text_to_video", {"prompt": "x", "duration": 5,
                                                   "resolution": "1080P"})["amount"] == pytest.approx(160)


# ------------------------------------------------------------------ Kie video


def test_kie_seedance_duration_times_resolution_rate():
    e = est("kie", "seedance-2", "text_to_video", {"prompt": "x", "duration": 5, "resolution": "720p"})
    assert e["amount"] == pytest.approx(205)
    assert e["unit"] == "credits"
    assert e["usd_equivalent"] == pytest.approx(1.025)
    assert e["confidence"] == "listed"
    assert "5 s" in e["basis"] and "41 credits/s" in e["basis"] and "720p" in e["basis"]
    assert e["as_of"] == "2026-11-15"
    assert "seedance-2-0.txt" in e["source"]


def test_kie_default_duration_and_resolution_come_from_the_ledger():
    # seedance-2 defaults: 5 s at 720p
    assert est("kie", "seedance-2", "text_to_video", {"prompt": "x"})["amount"] == pytest.approx(205)


def test_kie_auto_duration_cannot_be_priced():
    assert est("kie", "seedance-2", "text_to_video", {"prompt": "x", "duration": -1}) is None


def test_kie_wan_uppercase_resolution():
    e = est("kie", "wan-3.0", "text_to_video", {"prompt": "x", "duration": 5, "resolution": "1080P"})
    assert e["amount"] == pytest.approx(160)
    assert e["usd_equivalent"] == pytest.approx(0.80)


def test_kie_wan_input_video_seconds_are_billed():
    refs = [{"kind": "video", "url": "https://x.test/a.mp4", "duration_s": 4}]
    e = est("kie", "wan-3.0", "omni_reference_to_video",
            {"prompt": "x", "duration": 5, "resolution": "720P"}, refs)
    assert e["amount"] == pytest.approx(16 * 9)
    assert e["confidence"] == "listed"


def test_kie_seedance_25_input_video_uses_reduced_rate():
    refs = [{"kind": "video", "url": "https://x.test/a.mp4", "duration_s": 3},
            {"kind": "video", "url": "https://x.test/b.mp4", "duration_s": 2}]
    e = est("kie", "seedance-2.5", "omni_reference_to_video",
            {"prompt": "x", "duration": 10, "resolution": "720p"}, refs)
    assert e["amount"] == pytest.approx(38 * 15)
    assert "input video" in e["basis"]


def test_kie_unknown_input_video_length_is_a_partial_lower_bound():
    refs = [{"kind": "video", "url": "https://x.test/a.mp4"}]
    e = est("kie", "seedance-2.5", "omni_reference_to_video",
            {"prompt": "x", "duration": 10, "resolution": "720p"}, refs)
    assert e["confidence"] == "partial"
    assert e["amount"] == pytest.approx(38 * 10)
    assert "at least" in e["basis"]


def test_kie_seedance_2_input_video_rate_missing_at_720p_is_not_guessed():
    refs = [{"kind": "video", "url": "https://x.test/a.mp4", "duration_s": 3}]
    assert est("kie", "seedance-2", "omni_reference_to_video",
               {"prompt": "x", "duration": 5, "resolution": "720p"}, refs) is None
    e = est("kie", "seedance-2", "omni_reference_to_video",
            {"prompt": "x", "duration": 5, "resolution": "480p"}, refs)
    assert e["amount"] == pytest.approx(11.5 * 8)


def test_kie_kling_reference_video_billing_rule():
    # rate x (output x 2) when the input is no longer than the output
    short = [{"kind": "video", "url": "https://x.test/a.mp4", "duration_s": 3}]
    e = est("kie", "kling-4.0", "omni_reference_to_video",
            {"prompt": "x", "duration": 5, "resolution": "1080p"}, short)
    assert e["amount"] == pytest.approx(25.5 * 10)
    # rate x (input + output) when it is longer
    long = [{"kind": "video", "url": "https://x.test/a.mp4", "duration_s": 8}]
    e = est("kie", "kling-4.0", "omni_reference_to_video",
            {"prompt": "x", "duration": 5, "resolution": "1080p"}, long)
    assert e["amount"] == pytest.approx(25.5 * 13)


def test_kie_kling_keyframe_and_text():
    e = est("kie", "kling-4.0", "image_to_video", {"prompt": "x", "duration": 10, "resolution": "1080p"},
            [{"kind": "image", "url": "https://x.test/a.png", "role": "first_frame"}])
    assert e["amount"] == pytest.approx(425)
    assert e["usd_equivalent"] == pytest.approx(2.125)


def test_kie_kling_flash_with_video_input_is_not_priced():
    refs = [{"kind": "video", "url": "https://x.test/a.mp4", "duration_s": 3}]
    assert est("kie", "kling-4.0-flash", "omni_reference_to_video", {"prompt": "x", "duration": 5}, refs) is None
    assert est("kie", "kling-4.0-flash", "text_to_video", {"prompt": "x", "duration": 5})["amount"] == 85


# ------------------------------------------------------------------ Kie images


def test_kie_seedream_pro_quality_selects_size_and_extra_images_cost():
    e = est("kie", "seedream-5-pro", "text_to_image", {"prompt": "x", "settings": {"quality": "high"}})
    assert e["amount"] == pytest.approx(14)
    imgs = [{"kind": "image", "url": f"https://x.test/{i}.png"} for i in range(3)]
    e = est("kie", "seedream-5-pro", "image_to_image", {"prompt": "x"}, imgs)
    assert e["amount"] == pytest.approx(7 + 2 * 0.5)
    assert "image" in e["basis"]


def test_kie_minimax_edit_reference_images_each_cost():
    imgs = [{"kind": "image", "url": f"https://x.test/{i}.png"} for i in range(2)]
    e = est("kie", "minimax-h3-image", "image_to_image", {"prompt": "x", "resolution": "4K"}, imgs)
    assert e["amount"] == pytest.approx(5.5 + 2 * 0.5)
    assert "kie.ai/pricing" in e["source"]


def test_kie_upscale_tier_needs_dimensions():
    assert est("kie", "image-upscaler", "image_to_image", {}, [{"kind": "image", "url": "https://x.test/a.png"}]) is None
    e = est("kie", "image-upscaler", "image_to_image", {"settings": {"upscale_factor": "2"}},
            [{"kind": "image", "url": "https://x.test/a.png", "width": 1024, "height": 1024}])
    assert e["amount"] == pytest.approx(1.5)  # 2048x2048 = 4.19 MP -> 2K tier
    e = est("kie", "image-upscaler", "image_to_image", {"settings": {"upscale_factor": "4"}},
            [{"kind": "image", "url": "https://x.test/a.png", "width": 1024, "height": 1024}])
    assert e["amount"] == pytest.approx(4)


@pytest.mark.parametrize("model,mode", [("gpt-image-2.6", "text_to_image"), ("seedream-5-flash", "text_to_image"),
                                        ("seedance-2-mini", "text_to_video")])
def test_kie_unlisted_models_have_no_estimate(model, mode):
    assert est("kie", model, mode, {"prompt": "x"}) is None


# ------------------------------------------------------------------ PiAPI


def test_piapi_seedance_listed_rate():
    e = est("piapi", "seedance-2", "text_to_video", {"prompt": "x", "duration": 5, "resolution": "720p"})
    assert e["amount"] == pytest.approx(1.0)
    assert e["unit"] == "usd"
    assert e["usd_equivalent"] == pytest.approx(1.0)
    assert "$0.20/s" in e["basis"]
    assert "piapi.ai/docs/seedance-api/seedance-2" in e["source"]


def test_piapi_less_restriction_uses_marked_up_rate():
    for setting in ("less_restriction", "real_people"):
        e = est("piapi", "seedance-2", "text_to_video",
                {"prompt": "x", "duration": 5, "resolution": "720p", "settings": {setting: True}})
        assert e["amount"] == pytest.approx(1.1)
        assert "less-restriction" in e["basis"]


def test_piapi_seedance_input_video_is_billed_at_half_rate():
    refs = [{"kind": "video", "url": "https://x.test/a.mp4", "duration_s": 4}]
    e = est("piapi", "seedance-2.5", "omni_reference_to_video",
            {"prompt": "x", "duration": 10, "resolution": "1080p"}, refs)
    assert e["amount"] == pytest.approx(0.80 * 10 + 0.40 * 4)


def test_piapi_kling_omni_with_reference_video():
    refs = [{"kind": "video", "url": "https://x.test/a.mp4", "duration_s": 6.667}]
    e = est("piapi", "kling-4.0", "omni_reference_to_video",
            {"prompt": "x", "duration": 5, "resolution": "720p"}, refs)
    # doc example: (5 + 6.667) * $0.10 -> $1.17
    assert e["amount"] == pytest.approx(1.17)


def test_piapi_kling_video_generation_rounds_to_cents():
    e = est("piapi", "kling-4.0", "text_to_video", {"prompt": "x", "duration": 5, "resolution": "720p"})
    assert e["amount"] == pytest.approx(0.83)  # doc example: 4.0, 720p, 5s: $0.83


def test_piapi_seedream_pro_less_restriction_and_reference_surcharge():
    imgs = [{"kind": "image", "url": f"https://x.test/{i}.png"} for i in range(3)]
    e = est("piapi", "seedream-5-pro", "image_to_image",
            {"prompt": "x", "resolution": "2K", "settings": {"less_restriction": True}}, imgs)
    assert e["amount"] == pytest.approx(0.17 + 2 * 0.003)


def test_piapi_seedream_lite_has_conflicting_snapshots_and_is_left_out():
    assert est("piapi", "seedream-5-lite", "text_to_image", {"prompt": "x"}) is None


def test_piapi_upscale_per_output_megapixel():
    e = est("piapi", "image-upscaler", "image_to_image", {"settings": {"scale": 2}},
            [{"kind": "image", "url": "https://x.test/a.png", "width": 1024, "height": 1024}])
    assert e["amount"] == pytest.approx(0.004)
    assert e["confidence"] == "partial"
    small = est("piapi", "image-upscaler", "image_to_image", {"settings": {"scale": 2}},
                [{"kind": "image", "url": "https://x.test/a.png", "width": 480, "height": 480}])
    assert small["amount"] == pytest.approx(0.001)


# ------------------------------------------------------------------ robustness


@pytest.mark.parametrize("args", [
    ("kie", "no-such-model", "text_to_video", {"prompt": "x"}),
    ("nope", "seedance-2", "text_to_video", {"prompt": "x"}),
    ("piapi", "wan-3.0", "text_to_video", {"prompt": "x"}),
    ("piapi", "seedance-2.5", "image_to_video", {"prompt": "x"}),
    ("kie", "seedance-2", "text_to_image", {"prompt": "x"}),
    ("kie", "seedance-2", "text_to_video", {"prompt": "x", "duration": 99}),
    ("kie", "seedance-2", "text_to_video", {"prompt": "x", "resolution": "8k"}),
    ("kie", "seedance-2", "text_to_video", "not a dict"),
    ("kie", "seedance-2", "text_to_video", {"prompt": "x", "duration": "five"}),
])
def test_unpriceable_requests_return_none(args):
    assert pricing.estimate_cost(*args, references=[]) is None


def test_bad_references_return_none():
    assert est("kie", "wan-3.0", "omni_reference_to_video", {"prompt": "x"}, ["nope"]) is None


def test_never_mutates_inputs():
    params = {"prompt": "x", "duration": 5, "resolution": "720p", "settings": {"less_restriction": True}}
    refs = [{"kind": "video", "url": "https://x.test/a.mp4", "duration_s": 4}]
    before = copy.deepcopy((params, refs))
    est("piapi", "seedance-2", "omni_reference_to_video", params, refs)
    assert (params, refs) == before


def test_reference_dataclasses_are_accepted():
    refs = [Reference(kind="video", url="https://x.test/a.mp4", duration_s=4)]
    assert est("kie", "wan-3.0", "omni_reference_to_video", {"prompt": "x", "duration": 5,
                                                              "resolution": "720P"}, refs)["amount"] == 144


# ------------------------------------------------------------------ route


@pytest.fixture
def client(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("the estimate route must never call a provider")

    monkeypatch.setattr(service, "adapter_factory", boom)
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app) as c:
        yield c


def test_estimate_route_needs_no_prompt(client):
    """The frontend leaves the prompt out of the estimate request (it never changes the price)."""
    for model, params in (("wan-3.0", {"duration": 5, "resolution": "1080P"}), ("seedance-2", {"duration": 5})):
        body = {"provider": "kie", "model": model, "mode": "text_to_video", "params": params, "references": []}
        with_prompt = {**body, "params": {**params, "prompt": "a fox"}}
        res = client.post("/api/generation/estimate", json=body)
        assert res.status_code == 200
        assert res.json()["estimate"] is not None
        assert res.json() == client.post("/api/generation/estimate", json=with_prompt).json()


def test_estimate_route_returns_the_estimate(client):
    body = {"provider": "kie", "model": "wan-3.0", "mode": "text_to_video",
            "params": {"prompt": "a fox", "duration": 5, "resolution": "1080P"}, "references": []}
    res = client.post("/api/generation/estimate", json=body)
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["estimate"]["amount"] == 160
    assert set(data["estimate"]) == {"amount", "unit", "usd_equivalent", "basis", "source", "as_of", "confidence",
                                     "price_source", "price_updated_at"}
    assert data["estimate"]["price_source"] == "bundled"


def test_estimate_route_unknown_model_is_null(client):
    res = client.post("/api/generation/estimate", json={"provider": "kie", "model": "x", "mode": "text_to_video"})
    body = res.json()
    assert body["ok"] is True and body["estimate"] is None
    assert body["unavailable"]["code"] == "not_priceable_request"


def test_estimate_route_rejects_bad_json(client):
    res = client.post("/api/generation/estimate", content=b"{nope", headers={"Content-Type": "application/json"})
    assert res.status_code == 422
    assert res.json()["ok"] is False
    res = client.post("/api/generation/estimate", json=[1, 2])
    assert res.status_code == 422


def test_estimate_route_with_missing_fields_is_null(client):
    body = client.post("/api/generation/estimate", json={"params": {}}).json()
    assert body["estimate"] is None and body["unavailable"]["code"] == "not_priceable_request"
