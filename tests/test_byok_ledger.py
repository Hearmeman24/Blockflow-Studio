"""Capability ledger: catalog contents, availability and spec-derived limits."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.byok import ledger
from backend.byok.spec import MEDIA_KINDS, MODES

VIDEO_IDS = {
    "seedance-2": "Seedance 2",
    "seedance-2-fast": "Seedance 2 Fast",
    "seedance-2-mini": "Seedance 2 Mini",
    "seedance-2.5": "Seedance 2.5",
    "kling-4.0": "Kling 4.0",
    "kling-4.0-flash": "Kling 4.0 Flash",
    "wan-3.0": "Wan 3.0",
    "wan-3.0-prime": "Wan 3.0 Prime",
}
IMAGE_IDS = {
    "seedream-5-pro": "Seedream 5 Pro",
    "seedream-5-flash": "Seedream 5 Flash",
    "seedream-5-lite": "Seedream 5 Lite",
    "seedream-5.5": "Seedream 5.5",
    "gpt-image-2.6": "GPT Image 2.6",
    "minimax-h3-image": "MiniMax H3 Image",
    "image-upscaler": "Image Upscaler",
}
NSFW_IDS = {
    "wan-3.0",
    "wan-3.0-prime",
    "seedream-5-pro",
    "seedream-5-flash",
    "seedream-5-lite",
    "seedream-5.5",
    "minimax-h3-image",
}
PIAPI_OFFERED = {
    "seedance-2",
    "seedance-2-fast",
    "seedance-2-mini",
    "seedance-2.5",
    "kling-4.0",
    "kling-4.0-flash",
    "seedream-5-pro",
    "seedream-5-lite",
    "image-upscaler",
}
KIE_OFFERED = set(VIDEO_IDS) | set(IMAGE_IDS) - {"seedream-5-lite"}


def test_catalog_has_exactly_the_listed_models_with_names():
    expected = {**VIDEO_IDS, **IMAGE_IDS}
    assert {m.id: m.name for m in ledger.CATALOG} == expected


@pytest.mark.parametrize("model_id", sorted(VIDEO_IDS))
def test_video_models_output_video(model_id):
    assert ledger.get_model(model_id).output == "video"


@pytest.mark.parametrize("model_id", sorted(IMAGE_IDS))
def test_image_models_output_image(model_id):
    assert ledger.get_model(model_id).output == "image"


def test_nsfw_flags_are_exactly_as_listed():
    assert {m.id for m in ledger.CATALOG if m.nsfw} == NSFW_IDS


def test_only_wan_prime_is_marked_fast():
    """Kie's model page lists Prime's speed as "Faster"; no source was checked for any other model."""
    assert {m.id for m in ledger.CATALOG if m.fast} == {"wan-3.0-prime"}


@pytest.mark.parametrize("model_id", sorted(set(VIDEO_IDS) | set(IMAGE_IDS)))
def test_provider_offering_matches_docs(model_id):
    model = ledger.get_model(model_id)
    assert model.offering("kie").offered is (model_id in KIE_OFFERED)
    assert model.offering("piapi").offered is (model_id in PIAPI_OFFERED)


@pytest.mark.parametrize("model_id", ["wan-3.0", "wan-3.0-prime", "seedream-5.5", "gpt-image-2.6", "minimax-h3-image"])
def test_models_absent_from_piapi_have_no_mode_mapping(model_id):
    offering = ledger.get_model(model_id).offering("piapi")
    assert offering.offered is False
    assert offering.modes == ()
    assert offering.reason == "Not offered by PiAPI"


def test_upscaler_is_image_to_image_only_with_no_prompt_and_one_image():
    model = ledger.get_model("image-upscaler")
    for provider in ("kie", "piapi"):
        offering = model.offering(provider)
        supported = [m.mode for m in offering.modes if m.supported]
        assert supported == ["image_to_image"]
        spec = offering.mode("image_to_image")
        assert spec.prompt.requirement == "none"
        assert spec.media_limit("image").max_count == 1
        assert spec.media_limit("image").min_count == 1
    assert model.offering("kie").mode("image_to_image").ids.model == "kie/image-upscale"
    piapi_ids = model.offering("piapi").mode("image_to_image").ids
    assert (piapi_ids.model, piapi_ids.task_type) == ("Qubico/image-toolkit", "upscale")


def test_gpt_image_has_tier_setting():
    spec = ledger.get_mode_spec("kie", "gpt-image-2.6", "text_to_image")
    tier = spec.setting("tier")
    assert tier.choices == ("flare", "sunburst", "economy")
    assert spec.variant_key == "tier"
    assert spec.variant("flare").ids.model == "gpt-image-2-6/flare-text-to-image"
    assert spec.variant("economy").ids.model == "gpt-image-2-6/economy-text-to-image"
    i2i = ledger.get_mode_spec("kie", "gpt-image-2.6", "image_to_image")
    assert i2i.variant("sunburst").ids.model == "gpt-image-2-6/sunburst-image-to-image"


def test_no_mode_takes_a_voice_kind():
    for model in ledger.CATALOG:
        for offering in model.offerings:
            for spec in offering.modes:
                assert spec.media_limit("voice") is None, (offering.provider, model.id, spec.mode)


# (provider, model, mode) -> {kind: max_count}, max_total
REFERENCE_LIMITS = [
    ("kie", "seedance-2", "omni_reference_to_video", {"image": 9, "video": 3, "audio": 3}, 12),
    ("kie", "seedance-2-fast", "omni_reference_to_video", {"image": 9, "video": 3, "audio": 3}, 12),
    ("kie", "seedance-2-mini", "omni_reference_to_video", {"image": 9, "video": 3, "audio": 3}, 12),
    ("kie", "seedance-2.5", "omni_reference_to_video", {"image": 30, "video": 10, "audio": 10}, 50),
    ("piapi", "seedance-2", "omni_reference_to_video", {"image": 9, "video": 3, "audio": 3}, 12),
    ("piapi", "seedance-2-fast", "omni_reference_to_video", {"image": 9, "video": 3, "audio": 3}, 12),
    ("piapi", "seedance-2-mini", "omni_reference_to_video", {"image": 9, "video": 3, "audio": 3}, 12),
    ("piapi", "seedance-2.5", "omni_reference_to_video", {"image": 30, "video": 10, "audio": 10}, 50),
    ("kie", "kling-4.0", "omni_reference_to_video", {"image": 10, "video": 5, "audio": 3}, 15),
    ("kie", "kling-4.0-flash", "omni_reference_to_video", {"image": 10, "video": 5}, 15),
    ("kie", "wan-3.0", "omni_reference_to_video", {"image": 10, "video": 5, "audio": 5}, None),
    ("kie", "wan-3.0-prime", "omni_reference_to_video", {"image": 10, "video": 5, "audio": 5}, None),
    ("kie", "seedream-5-pro", "image_to_image", {"image": 10}, None),
    ("kie", "seedream-5-flash", "image_to_image", {"image": 10}, None),
    ("kie", "seedream-5.5", "image_to_image", {"image": 10}, None),
    ("kie", "minimax-h3-image", "image_to_image", {"image": 16}, None),
    ("kie", "gpt-image-2.6", "image_to_image", {"image": 16}, None),
    ("piapi", "seedream-5-pro", "image_to_image", {"image": 10}, None),
    ("piapi", "seedream-5-lite", "image_to_image", {"image": 10}, None),
]


@pytest.mark.parametrize("provider,model_id,mode,per_kind,total", REFERENCE_LIMITS)
def test_reference_limits_match_specs(provider, model_id, mode, per_kind, total):
    spec = ledger.get_mode_spec(provider, model_id, mode)
    assert spec.supported
    assert {m.kind: m.max_count for m in spec.media} == per_kind
    assert spec.max_total_references == total


# (provider, model) -> (first required, last allowed)
FRAME_ROLES = [
    ("kie", "seedance-2", True, True),
    ("kie", "seedance-2-fast", True, True),
    ("kie", "seedance-2-mini", True, True),
    ("kie", "seedance-2.5", True, True),
    ("piapi", "seedance-2", True, True),
    ("piapi", "seedance-2-fast", True, True),
    ("piapi", "seedance-2-mini", True, True),
    ("kie", "kling-4.0", True, True),
    ("kie", "kling-4.0-flash", True, False),
    ("piapi", "kling-4.0", True, True),
    ("piapi", "kling-4.0-flash", True, False),
    ("kie", "wan-3.0", True, True),
    ("kie", "wan-3.0-prime", True, True),
]


@pytest.mark.parametrize("provider,model_id,first,last", FRAME_ROLES)
def test_image_to_video_frame_roles(provider, model_id, first, last):
    spec = ledger.get_mode_spec(provider, model_id, "image_to_video")
    assert spec.supported
    assert spec.frames.first_frame_required is first
    assert spec.frames.last_frame_allowed is last
    assert [m.kind for m in spec.media] == ["image"]


def test_piapi_seedance_2_5_has_no_documented_frame_control():
    spec = ledger.get_mode_spec("piapi", "seedance-2.5", "image_to_video")
    assert spec.supported is False
    assert "first/last frame" in spec.unavailable_reason


# (provider, model, mode) -> (min, max, default, auto)
DURATIONS = [
    ("kie", "seedance-2", "text_to_video", 4, 15, 5, -1),
    ("kie", "seedance-2.5", "text_to_video", 4, 30, 5, -1),
    ("piapi", "seedance-2", "text_to_video", 4, 15, 5, None),
    ("piapi", "seedance-2.5", "text_to_video", 4, 30, 5, None),
    ("kie", "kling-4.0", "text_to_video", 3, 30, 5, None),
    ("kie", "kling-4.0-flash", "image_to_video", 3, 20, 5, None),
    ("piapi", "kling-4.0", "image_to_video", 3, 30, 5, None),
    ("piapi", "kling-4.0-flash", "text_to_video", 3, 20, 5, None),
    ("kie", "wan-3.0", "text_to_video", 2, 30, 5, -1),
    ("kie", "wan-3.0-prime", "omni_reference_to_video", 2, 30, 5, -1),
]


@pytest.mark.parametrize("provider,model_id,mode,lo,hi,default,auto", DURATIONS)
def test_duration_ranges(provider, model_id, mode, lo, hi, default, auto):
    d = ledger.get_mode_spec(provider, model_id, mode).duration
    assert (d.min_s, d.max_s, d.default, d.auto_value) == (lo, hi, default, auto)


RESOLUTIONS = [
    ("kie", "seedance-2", ("480p", "720p", "1080p", "4k"), "720p"),
    ("kie", "seedance-2-fast", ("480p", "720p"), "720p"),
    ("kie", "seedance-2-mini", ("480p", "720p"), "720p"),
    ("kie", "seedance-2.5", ("480p", "720p", "1080p"), "720p"),
    ("piapi", "seedance-2", ("480p", "720p", "1080p"), "480p"),
    ("piapi", "seedance-2-fast", ("480p", "720p"), "480p"),
    ("piapi", "seedance-2-mini", ("480p", "720p"), "720p"),
    ("piapi", "seedance-2.5", ("480p", "720p", "1080p"), "720p"),
    ("kie", "kling-4.0", ("720p", "1080p"), "720p"),
    ("kie", "kling-4.0-flash", ("720p",), "720p"),
    ("piapi", "kling-4.0", ("720p", "1080p"), "720p"),
    ("piapi", "kling-4.0-flash", ("720p",), "720p"),
    ("kie", "wan-3.0", ("480P", "720P", "1080P"), "1080P"),
]


@pytest.mark.parametrize("provider,model_id,values,default", RESOLUTIONS)
def test_video_resolutions(provider, model_id, values, default):
    r = ledger.get_mode_spec(provider, model_id, "text_to_video").resolutions
    assert (r.values, r.default) == (values, default)


def test_content_settings_are_explicit_with_documented_defaults():
    kie = ledger.get_mode_spec("kie", "seedance-2", "text_to_video")
    assert kie.setting("nsfw_checker").default is False
    assert kie.setting("real_people") is None
    piapi = ledger.get_mode_spec("piapi", "seedance-2", "omni_reference_to_video")
    assert piapi.setting("less_restriction").default is False
    assert piapi.setting("real_people").default is False
    seedream = ledger.get_mode_spec("piapi", "seedream-5-lite", "text_to_image")
    assert seedream.setting("less_restriction").default is False
    assert ledger.get_mode_spec("piapi", "kling-4.0", "text_to_video").setting("less_restriction") is None


def test_every_mode_listed_for_every_offering():
    for model in ledger.CATALOG:
        for offering in model.offerings:
            if not offering.offered:
                continue
            listed = [m.mode for m in offering.modes]
            relevant = [m for m in MODES if (m.endswith("video")) == (model.output == "video")]
            assert listed == relevant, (model.id, offering.provider)
            for spec in offering.modes:
                assert spec.supported or spec.unavailable_reason
                for limit in spec.media:
                    assert limit.kind in MEDIA_KINDS


def test_catalog_payload_is_json_and_flips_availability():
    none = ledger.catalog_payload(set())
    json.dumps(none)
    assert none["providers"]["kie"]["configured"] is False
    assert none["providers"]["piapi"]["configured"] is False
    wan = _payload_model(none, "wan-3.0")
    assert wan["providers"]["kie"]["available"] is False
    assert wan["providers"]["kie"]["unavailable_reason"] == "Requires a Kie API key"
    assert wan["providers"]["piapi"]["unavailable_reason"] == "Not offered by PiAPI"
    assert wan["available"] is False

    kie_only = ledger.catalog_payload({"kie"})
    wan = _payload_model(kie_only, "wan-3.0")
    assert wan["providers"]["kie"]["available"] is True
    assert wan["providers"]["kie"]["unavailable_reason"] is None
    assert wan["available"] is True
    lite = _payload_model(kie_only, "seedream-5-lite")
    assert lite["available"] is False
    assert lite["providers"]["piapi"]["unavailable_reason"] == "Requires a PiAPI API key"

    piapi_only = ledger.catalog_payload({"piapi"})
    assert _payload_model(piapi_only, "seedream-5-lite")["available"] is True
    assert _payload_model(piapi_only, "wan-3.0")["available"] is False


def test_catalog_payload_lists_modes_kinds_unverified_and_unsupported():
    payload = ledger.catalog_payload({"kie", "piapi"})
    assert [m["id"] for m in payload["modes"]] == list(MODES)
    assert payload["media_kinds"] == list(MEDIA_KINDS)
    assert payload["unverified"], "UNVERIFIED list must be exposed"
    assert {"provider", "model", "field", "detail"} <= set(payload["unverified"][0])
    features = {f["id"] for f in payload["unsupported_features"]}
    assert {"seedance_draft", "seedance_edit_extend", "seedance_2_5_flash", "wan_file_link_to_video",
            "web_search", "gpt_image_gif_svg_mask_markup", "layer_decomposition", "webhooks",
            "remote_cancel"} <= features
    seedance = _payload_model(payload, "seedance-2")
    t2v = seedance["providers"]["piapi"]["modes"]["text_to_video"]
    assert t2v["supported"] is True
    assert t2v["ids"] == {"model": "seedance", "task_type": "seedance-2", "version": None}


def test_catalog_payload_ignores_unknown_provider_names():
    payload = ledger.catalog_payload({"kie", "bogus"})
    assert set(payload["providers"]) == {"kie", "piapi"}


def test_unverified_entries_are_well_formed():
    assert len(ledger.UNVERIFIED) >= 10
    for item in ledger.UNVERIFIED:
        assert item.provider in {"kie", "piapi"}
        assert item.field and item.detail


def _payload_model(payload, model_id):
    return next(m for m in payload["models"] if m["id"] == model_id)


def test_real_people_setting_description_carries_its_consequences():
    """The UI renders this description verbatim; it must state the cost and plan facts."""
    payload = ledger.catalog_payload({"kie", "piapi"})
    descriptions = {
        setting["description"]
        for model in payload["models"]
        for status in model["providers"].values()
        for spec in status["modes"].values()
        for setting in spec["settings"]
        if setting["key"] == "real_people"
    }
    assert len(descriptions) == 1
    (text,) = descriptions
    assert "less-restriction" in text
    assert "Private Asset Library" in text
    assert "about 90 seconds" in text
    assert "paid PiAPI plan" in text


# ---------------------------------------------------------------------------
# Prompt mention syntax (badges above the prompt insert these)
# ---------------------------------------------------------------------------

REFERENCE_MODES = ("image_to_video", "image_to_image", "omni_reference_to_video")


def _mentions(provider, model_id, mode):
    return ledger.get_mode_spec(provider, model_id, mode).mentions


@pytest.mark.parametrize("model_id", ["seedance-2", "seedance-2-fast", "seedance-2-mini", "seedance-2.5"])
def test_piapi_seedance_uses_at_image_n(model_id):
    m = _mentions("piapi", model_id, "omni_reference_to_video")
    assert (m.image, m.video, m.audio, m.documented) == ("@image{n}", "@video{n}", "@audio{n}", True)


def test_kling_mentions_follow_each_provider():
    kie = _mentions("kie", "kling-4.0", "omni_reference_to_video")
    assert (kie.image, kie.video, kie.audio, kie.documented) == ("@image_{n}", "@video_{n}", "@sound_{n}", True)
    # PiAPI does not offer Kling 4.0 Omni Reference to Video (see test_byok_piapi_kling_omni.py).
    assert _mentions("piapi", "kling-4.0", "omni_reference_to_video") is None
    frames = _mentions("kie", "kling-4.0", "image_to_video")
    assert (frames.first_frame, frames.last_frame, frames.documented) == ("@first_frame", "@last_frame", True)


def test_wan_minimax_and_gpt_image_mentions():
    wan = _mentions("kie", "wan-3.0", "omni_reference_to_video")
    assert (wan.image, wan.video, wan.audio) == ("Image{n}", "Video{n}", "Audio{n}")
    assert _mentions("kie", "minimax-h3-image", "image_to_image").image == "<Picture {n}>"
    gpt = _mentions("kie", "gpt-image-2.6", "image_to_image")
    assert (gpt.image, gpt.documented) == ("image {n}", True)


def test_every_reference_mode_has_mentions_and_undocumented_ones_are_listed_unverified():
    unverified = [u for u in ledger.UNVERIFIED if u.field == "prompt mention syntax"]
    for model in ledger.CATALOG:
        for offering in model.offerings:
            for spec in offering.modes:
                if not spec.supported:
                    continue
                if spec.mode in REFERENCE_MODES:
                    assert spec.mentions is not None, (offering.provider, model.id, spec.mode)
                    if not spec.mentions.documented:
                        assert (spec.mentions.image, spec.mentions.video, spec.mentions.audio) == ("Image{n}", "Video{n}", "Audio{n}")
                        assert any(u.provider == offering.provider and model.id in u.model for u in unverified), (
                            offering.provider, model.id, spec.mode)
                else:
                    assert spec.mentions is None


def test_mentions_are_in_the_catalog_payload():
    payload = ledger.catalog_payload({"kie", "piapi"})
    seedance = _payload_model(payload, "seedance-2")
    assert seedance["providers"]["piapi"]["modes"]["omni_reference_to_video"]["mentions"] == {
        "image": "@image{n}", "video": "@video{n}", "audio": "@audio{n}",
        "first_frame": None, "last_frame": None, "documented": True,
    }
    assert seedance["providers"]["kie"]["modes"]["text_to_video"]["mentions"] is None
