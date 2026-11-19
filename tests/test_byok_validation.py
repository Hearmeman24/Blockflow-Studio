"""validate_request: every rule, boundary values, and no input mutation."""

from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.byok.ledger import Reference, validate_request  # noqa: E402


def img(url="https://x.test/a.png", role="reference", **kw):
    return Reference("image", url, role, **kw)


def vid(url="https://x.test/a.mp4", **kw):
    return Reference("video", url, **kw)


def aud(url="https://x.test/a.mp3", **kw):
    return Reference("audio", url, **kw)


def codes(issues, severity="error"):
    return [i.code for i in issues if i.severity == severity]


def only(issues, code):
    found = [i for i in issues if i.code == code]
    assert found, f"expected {code}, got {[i.code for i in issues]}"
    return found[0]


P = {"prompt": "a calm lake at dawn"}


# --- lookup errors ---------------------------------------------------------

def test_unknown_provider():
    assert codes(validate_request("openai", "seedance-2", "text_to_video", P, [])) == ["unknown_provider"]


def test_unknown_model():
    assert codes(validate_request("kie", "sora-9", "text_to_video", P, [])) == ["unknown_model"]


def test_unknown_mode():
    assert codes(validate_request("kie", "seedance-2", "video_to_video", P, [])) == ["unknown_mode"]


@pytest.mark.parametrize("model_id", ["wan-3.0", "wan-3.0-prime", "seedream-5.5", "gpt-image-2.6",
                                      "minimax-h3-image", "seedream-5-flash"])
def test_model_not_offered_by_piapi(model_id):
    mode = "text_to_video" if model_id.startswith("wan") else "text_to_image"
    issue = only(validate_request("piapi", model_id, mode, P, []), "model_not_offered")
    assert "PiAPI" in issue.message


def test_model_not_offered_by_kie():
    assert codes(validate_request("kie", "seedream-5-lite", "text_to_image", P, [])) == ["model_not_offered"]


def test_unsupported_mode_combo():
    assert codes(validate_request("kie", "seedance-2", "text_to_image", P, [])) == ["mode_unsupported"]
    assert codes(validate_request("kie", "image-upscaler", "text_to_image", {}, [])) == ["mode_unsupported"]
    issue = only(validate_request("piapi", "seedance-2.5", "image_to_video", P, [img(role="first_frame")]),
                 "mode_unsupported")
    assert "Omni Reference" in issue.message


# --- prompt ------------------------------------------------------------------

@pytest.mark.parametrize("prompt", [None, "", "   ", "\n\t"])
def test_missing_or_whitespace_prompt(prompt):
    assert "prompt_required" in codes(validate_request("kie", "seedance-2", "text_to_video", {"prompt": prompt}, []))


def test_prompt_length_boundaries_piapi_seedance():
    at = validate_request("piapi", "seedance-2", "text_to_video", {"prompt": "x" * 4000}, [])
    assert codes(at) == []
    over = only(validate_request("piapi", "seedance-2", "text_to_video", {"prompt": "x" * 4001}, []),
                "prompt_too_long")
    assert (over.limit, over.actual) == (4000, 4001)


def test_prompt_length_counts_unicode_characters_not_bytes():
    prompt = "猫" * 2500
    assert codes(validate_request("piapi", "kling-4.0", "text_to_video", {"prompt": prompt}, [])) == []
    issue = only(validate_request("piapi", "kling-4.0", "text_to_video", {"prompt": prompt + "猫"}, []),
                 "prompt_too_long")
    assert issue.actual == 2501


def test_unicode_and_emoji_prompts_are_accepted():
    for prompt in ("Ünïcödé ✨ 日本語 🎬", "ملخص", "x‍y"):
        assert codes(validate_request("kie", "wan-3.0", "text_to_video", {"prompt": prompt}, [])) == []


def test_prompt_min_length_kie_seedance():
    assert "prompt_too_short" in codes(validate_request("kie", "seedance-2", "text_to_video", {"prompt": "ab"}, []))
    assert codes(validate_request("kie", "seedance-2", "text_to_video", {"prompt": "abc"}, [])) == []


def test_optional_prompt_allows_empty_for_wan_image_to_video():
    issues = validate_request("kie", "wan-3.0", "image_to_video", {"prompt": ""}, [img(role="first_frame")])
    assert codes(issues) == []


def test_prompt_none_rejects_text_for_upscaler():
    ref = [img()]
    assert codes(validate_request("kie", "image-upscaler", "image_to_image", {}, ref)) == []
    assert codes(validate_request("kie", "image-upscaler", "image_to_image", {"prompt": "  "}, ref)) == []
    assert codes(validate_request("kie", "image-upscaler", "image_to_image", {"prompt": "sharper"}, ref)) == [
        "prompt_not_accepted"]


def test_non_string_prompt():
    assert codes(validate_request("kie", "wan-3.0", "text_to_video", {"prompt": 12}, [])) == ["invalid_prompt"]


# --- references --------------------------------------------------------------

def test_text_modes_reject_references():
    issue = only(validate_request("kie", "seedance-2", "text_to_video", P, [img()]), "media_kind_not_accepted")
    assert issue.field == "references.image"


def test_media_kind_not_accepted_in_mode():
    refs = [img(), aud()]
    issue = only(validate_request("kie", "kling-4.0-flash", "omni_reference_to_video", P, refs),
                 "media_kind_not_accepted")
    assert issue.field == "references.audio"


def test_legacy_voice_kind_is_audio_on_every_model():
    voice = {"kind": "voice", "url": "https://x.test/v.mp3", "name": "Narrator"}
    for provider, model_id in (("piapi", "seedance-2"), ("kie", "kling-4.0")):
        assert codes(validate_request(provider, model_id, "omni_reference_to_video", P, [img(), voice])) == []
    issue = only(validate_request("kie", "kling-4.0-flash", "omni_reference_to_video", P, [img(), voice]),
                 "media_kind_not_accepted")
    assert issue.field == "references.audio"


def test_unknown_media_kind():
    ref = Reference("pdf", "https://x.test/a.pdf")
    assert "unknown_media_kind" in codes(validate_request("kie", "wan-3.0", "omni_reference_to_video", P, [ref]))


def test_missing_url():
    ref = Reference("image", "  ")
    assert "reference_url_missing" in codes(validate_request("kie", "wan-3.0", "omni_reference_to_video", P, [ref]))


@pytest.mark.parametrize("provider,model_id,kind,limit", [
    ("kie", "seedance-2", "image", 9),
    ("kie", "seedance-2", "video", 3),
    ("kie", "seedance-2", "audio", 3),
    ("piapi", "seedance-2.5", "image", 30),
    ("kie", "wan-3.0", "video", 5),
    ("kie", "kling-4.0", "audio", 3),
    ("piapi", "seedance-2", "audio", 3),
])
def test_per_kind_count_boundaries(provider, model_id, kind, limit):
    make = {"image": img, "video": vid, "audio": aud}[kind]
    anchor = [] if kind in ("image", "video") else [img()]
    at = [make() for _ in range(limit)]
    assert "too_many_references" not in codes(validate_request(provider, model_id, "omni_reference_to_video", P,
                                                               anchor + at))
    over = at + [make()]
    issue = only(validate_request(provider, model_id, "omni_reference_to_video", P, anchor + over),
                 "too_many_references")
    assert (issue.limit, issue.actual, issue.field) == (limit, limit + 1, f"references.{kind}")


def test_total_reference_boundary_kie_seedance():
    at = [img() for _ in range(9)] + [vid(), aud()] + [vid()]
    assert codes(validate_request("kie", "seedance-2", "omni_reference_to_video", P, at)) == []
    over = at + [aud()]
    issue = only(validate_request("kie", "seedance-2", "omni_reference_to_video", P, over),
                 "too_many_total_references")
    assert (issue.limit, issue.actual) == (12, 13)


def test_total_reference_boundary_kling():
    refs = [img() for _ in range(10)] + [vid() for _ in range(5)]
    assert codes(validate_request("kie", "kling-4.0", "omni_reference_to_video", P, refs)) == []
    issue = only(validate_request("kie", "kling-4.0", "omni_reference_to_video", P, refs + [aud()]),
                 "too_many_total_references")
    assert issue.limit == 15


def test_omni_needs_at_least_one_reference():
    issue = only(validate_request("kie", "seedance-2", "omni_reference_to_video", P, []), "too_few_references")
    assert issue.limit == 1


def test_image_to_image_needs_an_image():
    issue = only(validate_request("kie", "seedream-5-pro", "image_to_image", P, []), "too_few_references")
    assert issue.field == "references.image"


def test_upscaler_accepts_exactly_one_image():
    assert "too_many_references" in codes(validate_request("piapi", "image-upscaler", "image_to_image", {},
                                                           [img(), img()]))


@pytest.mark.parametrize("provider,model_id", [("kie", "seedance-2"), ("piapi", "seedance-2"), ("kie", "kling-4.0")])
def test_audio_only_forbidden(provider, model_id):
    refs = [aud()]
    assert "audio_only_not_allowed" in codes(validate_request(provider, model_id, "omni_reference_to_video", P, refs))


@pytest.mark.parametrize("provider,model_id", [("kie", "wan-3.0"), ("piapi", "seedance-2.5")])
def test_audio_only_allowed_where_documented(provider, model_id):
    assert codes(validate_request(provider, model_id, "omni_reference_to_video", P, [aud()])) == []


def test_mixed_media_not_allowed_in_image_to_video():
    refs = [img(role="first_frame"), Reference("video", "https://x.test/a.mp4", role="last_frame")]
    found = codes(validate_request("kie", "seedance-2", "image_to_video", P, refs))
    assert "mixed_media_not_allowed" in found
    assert "media_kind_not_accepted" in found


def test_mixed_media_allowed_in_omni():
    refs = [img(), vid(), aud()]
    assert codes(validate_request("kie", "seedance-2", "omni_reference_to_video", P, refs)) == []


# --- frame roles ---------------------------------------------------------------

def test_first_frame_required():
    issue = only(validate_request("kie", "seedance-2", "image_to_video", P, []), "first_frame_required")
    assert issue.field == "references.first_frame"


def test_last_frame_without_first():
    found = codes(validate_request("kie", "seedance-2", "image_to_video", P, [img(role="last_frame")]))
    assert "first_frame_required" in found


@pytest.mark.parametrize("provider,model_id", [("kie", "kling-4.0-flash"), ("piapi", "kling-4.0-flash")])
def test_last_frame_unsupported(provider, model_id):
    refs = [img(role="first_frame"), img(role="last_frame")]
    found = codes(validate_request(provider, model_id, "image_to_video", P, refs))
    assert "last_frame_not_supported" in found


@pytest.mark.parametrize("provider,model_id", [("kie", "kling-4.0"), ("piapi", "kling-4.0"),
                                               ("kie", "wan-3.0"), ("piapi", "seedance-2-mini")])
def test_first_and_last_frame_accepted(provider, model_id):
    refs = [img(role="first_frame"), img(role="last_frame")]
    assert codes(validate_request(provider, model_id, "image_to_video", P, refs)) == []


def test_duplicate_first_frame():
    refs = [img(role="first_frame"), img(role="first_frame")]
    assert "duplicate_frame" in codes(validate_request("kie", "wan-3.0", "image_to_video", P, refs))


def test_plain_reference_role_rejected_in_image_to_video():
    refs = [img(role="first_frame"), img()]
    assert "invalid_reference_role" in codes(validate_request("kie", "wan-3.0", "image_to_video", P, refs))


def test_frame_role_rejected_in_omni():
    assert "invalid_reference_role" in codes(validate_request("kie", "wan-3.0", "omni_reference_to_video", P,
                                                              [img(role="first_frame")]))


def test_unknown_role():
    assert "invalid_reference_role" in codes(validate_request("kie", "wan-3.0", "omni_reference_to_video", P,
                                                              [img(role="hero")]))


# --- per-item metadata -------------------------------------------------------

def test_format_check_from_url_and_explicit_format():
    bad = img(url="https://x.test/a.heic")
    issue = only(validate_request("kie", "seedream-5-pro", "image_to_image", P, [bad]), "invalid_format")
    assert issue.actual == "heic"
    ok_no_ext = img(url="https://tmpfiles.org/dl/123.abc/file")
    assert codes(validate_request("kie", "seedream-5-pro", "image_to_image", P, [ok_no_ext])) == []
    explicit = img(url="https://x.test/raw", format="tiff")
    assert "invalid_format" in codes(validate_request("kie", "seedream-5-pro", "image_to_image", P, [explicit]))


def test_size_boundary():
    at = img(size_bytes=10_000_000)
    assert codes(validate_request("kie", "seedream-5.5", "image_to_image", P, [at])) == []
    over = img(size_bytes=10_000_001)
    issue = only(validate_request("kie", "seedream-5.5", "image_to_image", P, [over]), "file_too_large")
    assert issue.limit == 10_000_000


def test_reference_duration_boundaries():
    refs = [img(), vid(duration_s=15)]
    assert codes(validate_request("kie", "seedance-2", "omni_reference_to_video", P, refs)) == []
    refs = [img(), vid(duration_s=15.1)]
    assert "reference_duration_out_of_range" in codes(
        validate_request("kie", "seedance-2", "omni_reference_to_video", P, refs))
    refs = [img(), vid(duration_s=1.9)]
    assert "reference_duration_out_of_range" in codes(
        validate_request("kie", "seedance-2", "omni_reference_to_video", P, refs))


def test_total_reference_duration():
    refs = [img(), aud(duration_s=7.5), aud(duration_s=7.5)]
    assert codes(validate_request("kie", "seedance-2", "omni_reference_to_video", P, refs)) == []
    refs = [img(), aud(duration_s=8), aud(duration_s=7.5)]
    issue = only(validate_request("kie", "seedance-2", "omni_reference_to_video", P, refs), "total_duration_exceeded")
    assert (issue.limit, issue.actual) == (15, 15.5)


def test_kling_flash_minimum_combined_video_duration():
    refs = [vid(duration_s=1.5)]
    assert "total_duration_too_short" in codes(
        validate_request("kie", "kling-4.0-flash", "omni_reference_to_video", P, refs))


def test_dimension_and_aspect_limits():
    small = img(width=299, height=800)
    assert "dimension_out_of_range" in codes(validate_request("kie", "seedance-2", "omni_reference_to_video", P,
                                                              [small]))
    edge = img(width=300, height=300)
    assert codes(validate_request("kie", "seedance-2", "omni_reference_to_video", P, [edge])) == []
    wide = img(width=2600, height=1000)
    assert "aspect_out_of_range" in codes(validate_request("kie", "seedance-2", "omni_reference_to_video", P, [wide]))


def test_kling_kie_audio_needs_no_name():
    """Names were a voice concept; audio references are named by the adapter."""
    refs = [img(), aud(), aud()]
    assert codes(validate_request("kie", "kling-4.0", "omni_reference_to_video", P, refs)) == []


def test_references_accept_plain_dicts():
    refs = [{"kind": "image", "url": "https://x.test/a.png"}]
    assert codes(validate_request("kie", "seedream-5-pro", "image_to_image", P, refs)) == []


# --- duration / resolution / aspect ratio -------------------------------------

@pytest.mark.parametrize("value,ok", [(4, True), (15, True), (3, False), (16, False), (-1, True),
                                      (5.0, False), (True, False), ("5", False)])
def test_kie_seedance_duration(value, ok):
    issues = validate_request("kie", "seedance-2", "text_to_video", {**P, "duration": value}, [])
    assert ("invalid_duration" not in codes(issues)) is ok


@pytest.mark.parametrize("value,ok", [(4, True), (15, True), (-1, False), (16, False)])
def test_piapi_seedance_duration_has_no_auto(value, ok):
    issues = validate_request("piapi", "seedance-2", "text_to_video", {**P, "duration": value}, [])
    assert ("invalid_duration" not in codes(issues)) is ok


@pytest.mark.parametrize("value,ok", [(20, True), (21, False), (3, True), (2, False)])
def test_kling_flash_duration(value, ok):
    issues = validate_request("kie", "kling-4.0-flash", "text_to_video", {**P, "duration": value}, [])
    assert ("invalid_duration" not in codes(issues)) is ok


def test_duration_not_accepted_for_images():
    assert "unknown_parameter" in codes(validate_request("kie", "seedream-5-pro", "text_to_image",
                                                         {**P, "duration": 5}, []))


def test_resolution_values():
    assert codes(validate_request("kie", "seedance-2", "text_to_video", {**P, "resolution": "4k"}, [])) == []
    issue = only(validate_request("kie", "seedance-2-fast", "text_to_video", {**P, "resolution": "1080p"}, []),
                 "invalid_resolution")
    assert issue.limit == ["480p", "720p"]
    assert "unknown_parameter" in codes(validate_request("kie", "seedream-5-pro", "text_to_image",
                                                         {**P, "resolution": "2K"}, []))


def test_aspect_ratio_values():
    assert "invalid_aspect_ratio" in codes(validate_request("piapi", "seedance-2", "text_to_video",
                                                            {**P, "aspect_ratio": "auto"}, []))
    assert codes(validate_request("piapi", "seedance-2", "image_to_video", {**P, "aspect_ratio": "auto"},
                                  [img(role="first_frame")])) == []
    assert "unknown_parameter" in codes(validate_request("kie", "kling-4.0", "image_to_video",
                                                         {**P, "aspect_ratio": "16:9"}, [img(role="first_frame")]))


def test_unknown_top_level_parameter():
    issue = only(validate_request("kie", "wan-3.0", "text_to_video", {**P, "negative_prompt": "x"}, []),
                 "unknown_parameter")
    assert issue.field == "negative_prompt"


# --- settings ----------------------------------------------------------------

def test_unknown_setting():
    issue = only(validate_request("kie", "wan-3.0", "text_to_video", {**P, "settings": {"web_search": True}}, []),
                 "unknown_setting")
    assert issue.field == "settings.web_search"


def test_real_people_is_not_a_kie_setting():
    assert "unknown_setting" in codes(validate_request("kie", "seedance-2", "omni_reference_to_video",
                                                       {**P, "settings": {"real_people": True}}, [img()]))


@pytest.mark.parametrize("settings,ok", [
    ({"seed": 0}, True), ({"seed": 2147483647}, True), ({"seed": -1}, False), ({"seed": 2147483648}, False),
    ({"seed": "1"}, False), ({"audio": False}, True), ({"audio": "no"}, False), ({"nsfw_checker": True}, True),
    ({"seed": None}, True),
])
def test_setting_types_and_ranges(settings, ok):
    issues = validate_request("kie", "wan-3.0", "text_to_video", {**P, "settings": settings}, [])
    assert ("invalid_setting" not in codes(issues)) is ok


def test_enum_setting_values():
    good = {**P, "settings": {"upscale_factor": "8"}}
    assert codes(validate_request("kie", "image-upscaler", "image_to_image", {"settings": good["settings"]},
                                  [img()])) == []
    bad = {"settings": {"upscale_factor": "3"}}
    assert "invalid_setting" in codes(validate_request("kie", "image-upscaler", "image_to_image", bad, [img()]))


def test_gpt_image_tier_switches_options():
    economy = {**P, "settings": {"tier": "economy"}}
    assert codes(validate_request("kie", "gpt-image-2.6", "text_to_image", economy, [])) == []
    issue = only(validate_request("kie", "gpt-image-2.6", "text_to_image",
                                  {**P, "aspect_ratio": "5:4", "settings": {"tier": "economy"}}, []),
                 "invalid_aspect_ratio")
    assert "5:4" == issue.actual
    assert "unknown_setting" in codes(validate_request("kie", "gpt-image-2.6", "text_to_image",
                                                       {**P, "settings": {"tier": "economy", "quality": "high"}}, []))
    assert codes(validate_request("kie", "gpt-image-2.6", "text_to_image",
                                  {**P, "aspect_ratio": "5:4", "settings": {"quality": "high"}}, [])) == []
    assert "invalid_setting" in codes(validate_request("kie", "gpt-image-2.6", "text_to_image",
                                                       {**P, "settings": {"tier": "gold"}}, []))


def test_cross_field_setting_conflicts():
    transparent = {**P, "settings": {"background": "transparent", "output_format": "jpeg"}}
    assert "setting_conflict" in codes(validate_request("kie", "seedream-5.5", "text_to_image", transparent, []))
    ok = {**P, "settings": {"background": "transparent"}}
    assert codes(validate_request("kie", "seedream-5.5", "text_to_image", ok, [])) == []
    compression = {**P, "settings": {"output_compression": 80}}
    assert "setting_conflict" in codes(validate_request("kie", "gpt-image-2.6", "text_to_image", compression, []))
    compression_ok = {**P, "settings": {"output_compression": 80, "output_format": "webp"}}
    assert codes(validate_request("kie", "gpt-image-2.6", "text_to_image", compression_ok, [])) == []


def test_kling_keep_sound_rules():
    keep = {**P, "settings": {"keep_original_sound": True}}
    assert "setting_conflict" in codes(validate_request("kie", "kling-4.0", "omni_reference_to_video", keep, [img()]))
    assert codes(validate_request("kie", "kling-4.0", "omni_reference_to_video", keep, [vid()])) == []


def test_wan_reference_video_plus_output_limit():
    refs = [vid(duration_s=15)]
    assert codes(validate_request("kie", "wan-3.0", "omni_reference_to_video", {**P, "duration": 15}, refs)) == []
    issue = only(validate_request("kie", "wan-3.0", "omni_reference_to_video", {**P, "duration": 16}, refs),
                 "total_duration_exceeded")
    assert issue.actual == 31
    assert codes(validate_request("kie", "wan-3.0", "omni_reference_to_video", {**P, "duration": -1}, refs)) == []


def test_piapi_real_people_on_mini_is_a_warning_not_an_error():
    issues = validate_request("piapi", "seedance-2-mini", "omni_reference_to_video",
                              {**P, "settings": {"real_people": True}}, [img()])
    assert codes(issues) == []
    assert codes(issues, "warning") == ["unverified_behaviour"]


# --- non-mutation and non-truncation --------------------------------------

def test_inputs_are_never_mutated_or_truncated():
    params = {"prompt": "x" * 5000, "duration": 99, "settings": {"audio": True, "bogus": 1}}
    refs = [{"kind": "image", "url": "https://x.test/a.png"} for _ in range(20)]
    before = (copy.deepcopy(params), copy.deepcopy(refs))
    issues = validate_request("kie", "wan-3.0", "omni_reference_to_video", params, refs)
    assert (params, refs) == before
    assert len(refs) == 20 and len(params["prompt"]) == 5000
    assert {"too_many_references", "invalid_duration", "unknown_setting"} <= set(codes(issues))


def test_issues_carry_actionable_messages():
    issues = validate_request("kie", "seedance-2", "omni_reference_to_video", P, [img() for _ in range(10)])
    issue = only(issues, "too_many_references")
    assert issue.severity == "error"
    assert "Seedance 2 on Kie" in issue.message and "remove 1" in issue.message
