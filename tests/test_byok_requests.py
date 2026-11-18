"""Pure request construction: full URL and JSON body per provider x model x mode."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.byok.errors import ProviderError  # noqa: E402
from backend.byok.providers import get_adapter  # noqa: E402
from backend.byok.spec import Reference  # noqa: E402

KIE_CREATE = "https://api.kie.ai/api/v1/jobs/createTask"
PIAPI_TASK = "https://api.piapi.ai/api/v1/task"
PROMPT = "a red fox running through snow"

I1, I2 = "https://cdn.test/one.png", "https://cdn.test/two.png"
V1 = "https://cdn.test/clip.mp4"
A1 = "https://cdn.test/song.mp3"


def first(url=I1):
    return Reference("image", url, "first_frame")


def last(url=I2):
    return Reference("image", url, "last_frame")


def ref(kind, url, **kw):
    return Reference(kind, url, **kw)


def build(provider, model, mode, params=None, refs=()):
    return get_adapter(provider).build_request(model, mode, params if params is not None else {"prompt": PROMPT},
                                               list(refs))


SD_DEFAULTS = {"duration": 5, "resolution": "720p", "aspect_ratio": "16:9", "generate_audio": True,
               "nsfw_checker": False}

KIE_CASES = [
    # --- Seedance 2 family -------------------------------------------------
    ("seedance-2", "text_to_video", {"prompt": PROMPT}, [],
     {"model": "bytedance/seedance-2", "input": {"prompt": PROMPT, **SD_DEFAULTS}}),
    ("seedance-2-fast", "image_to_video", {"prompt": PROMPT, "duration": 8, "resolution": "480p"}, [first(), last()],
     {"model": "bytedance/seedance-2-fast",
      "input": {"prompt": PROMPT, **SD_DEFAULTS, "duration": 8, "resolution": "480p",
                "first_frame_url": I1, "last_frame_url": I2}}),
    ("seedance-2-mini", "omni_reference_to_video",
     {"prompt": PROMPT, "duration": -1, "aspect_ratio": "adaptive",
      "settings": {"generate_audio": False, "nsfw_checker": True}},
     [ref("image", I1), ref("video", V1), ref("audio", A1)],
     {"model": "bytedance/seedance-2-mini",
      "input": {"prompt": PROMPT, "duration": -1, "resolution": "720p", "aspect_ratio": "adaptive",
                "generate_audio": False, "nsfw_checker": True, "reference_image_urls": [I1],
                "reference_video_urls": [V1], "reference_audio_urls": [A1]}}),
    ("seedance-2", "image_to_video", {"prompt": PROMPT, "resolution": "4k"}, [first()],
     {"model": "bytedance/seedance-2", "input": {"prompt": PROMPT, **SD_DEFAULTS, "resolution": "4k",
                                                 "first_frame_url": I1}}),
    ("seedance-2.5", "text_to_video", {"prompt": PROMPT, "duration": 30}, [],
     {"model": "bytedance/seedance-2-5",
      "input": {"prompt": PROMPT, "duration": 30, "resolution": "720p", "aspect_ratio": "adaptive",
                "generate_audio": True, "output_format": "mp4", "nsfw_checker": False}}),
    ("seedance-2.5", "omni_reference_to_video", {"prompt": PROMPT, "settings": {"output_format": "mov"}},
     [ref("image", I1), ref("image", I2)],
     {"model": "bytedance/seedance-2-5",
      "input": {"prompt": PROMPT, "duration": 5, "resolution": "720p", "aspect_ratio": "adaptive",
                "generate_audio": True, "output_format": "mov", "nsfw_checker": False,
                "reference_image_urls": [I1, I2], "omni_reference_task_type": "reference"}}),
    # --- Kling 4.0 ---------------------------------------------------------
    ("kling-4.0", "text_to_video", {"prompt": PROMPT}, [],
     {"model": "kling-4.0/reference-to-video",
      "input": {"prompt": PROMPT, "duration": 5, "resolution": "720p", "aspect_ratio": "16:9"}}),
    ("kling-4.0", "image_to_video", {"prompt": PROMPT, "duration": 10, "resolution": "1080p"}, [first(), last()],
     {"model": "kling-4.0/keyframe-to-video",
      "input": {"prompt": PROMPT, "duration": 10, "resolution": "1080p", "first_frame_url": I1,
                "last_frame_url": I2}}),
    ("kling-4.0", "omni_reference_to_video", {"prompt": "@image_1 sings with @sound_1"},
     [ref("image", I1), ref("audio", A1)],
     {"model": "kling-4.0/reference-to-video",
      "input": {"prompt": "@image_1 sings with @sound_1", "duration": 5, "resolution": "720p",
                "image_urls": [I1], "voices": [{"name": "sound_1", "audio_url": A1}]}}),
    ("kling-4.0", "omni_reference_to_video",
     {"prompt": PROMPT, "aspect_ratio": "auto", "settings": {"keep_original_sound": True}},
     [ref("video", V1)],
     {"model": "kling-4.0/reference-to-video",
      "input": {"prompt": PROMPT, "duration": 5, "resolution": "720p", "aspect_ratio": "auto",
                "video_urls": [V1], "keep_original_sound": True}}),
    ("kling-4.0-flash", "image_to_video", {"prompt": PROMPT}, [first()],
     {"model": "kling-4.0/flash-keyframe-to-video",
      "input": {"prompt": PROMPT, "duration": 5, "resolution": "720p", "first_frame_url": I1}}),
    ("kling-4.0-flash", "omni_reference_to_video", {"prompt": PROMPT, "duration": 20}, [ref("image", I1)],
     {"model": "kling-4.0/flash-reference-to-video",
      "input": {"prompt": PROMPT, "duration": 20, "resolution": "720p", "image_urls": [I1]}}),
    # --- Wan 3.0 -----------------------------------------------------------
    ("wan-3.0", "text_to_video", {"prompt": PROMPT, "settings": {"seed": 42}}, [],
     {"model": "wan/3-0-video",
      "input": {"prompt": PROMPT, "duration": 5, "resolution": "1080P", "aspect_ratio": "adaptive",
                "audio": True, "seed": 42, "nsfw_checker": False}}),
    ("wan-3.0-prime", "image_to_video", {"prompt": ""}, [first()],
     {"model": "wan/3-0-video-prime",
      "input": {"duration": 5, "resolution": "1080P", "aspect_ratio": "adaptive", "audio": True,
                "nsfw_checker": False, "first_frame_url": I1}}),
    ("wan-3.0", "omni_reference_to_video", {"prompt": "Audio1 plays", "resolution": "720P"}, [ref("audio", A1)],
     {"model": "wan/3-0-video",
      "input": {"prompt": "Audio1 plays", "duration": 5, "resolution": "720P", "aspect_ratio": "adaptive",
                "audio": True, "nsfw_checker": False, "reference_audio_urls": [A1]}}),
    # --- Seedream ----------------------------------------------------------
    ("seedream-5-pro", "text_to_image", {"prompt": PROMPT}, [],
     {"model": "seedream/5-pro-text-to-image",
      "input": {"prompt": PROMPT, "aspect_ratio": "1:1", "quality": "basic", "output_format": "png",
                "nsfw_checker": False}}),
    ("seedream-5-pro", "image_to_image", {"prompt": PROMPT, "settings": {"quality": "high"}}, [ref("image", I1)],
     {"model": "seedream/5-pro-image-to-image",
      "input": {"prompt": PROMPT, "aspect_ratio": "1:1", "quality": "high", "output_format": "png",
                "nsfw_checker": False, "image_urls": [I1]}}),
    ("seedream-5-flash", "text_to_image", {"prompt": PROMPT, "resolution": "1.5K"}, [],
     {"model": "seedream/5-flash-text-to-image",
      "input": {"prompt": PROMPT, "size": "1.5K", "aspect_ratio": "1:1", "output_format": "png",
                "nsfw_checker": False}}),
    ("seedream-5-flash", "image_to_image", {"prompt": PROMPT}, [ref("image", I1), ref("image", I2)],
     {"model": "seedream/5-flash-image-to-image",
      "input": {"prompt": PROMPT, "size": "1K", "aspect_ratio": "1:1", "output_format": "png",
                "nsfw_checker": False, "image_urls": [I1, I2]}}),
    ("seedream-5.5", "text_to_image", {"prompt": PROMPT, "settings": {"background": "transparent"}}, [],
     {"model": "seedream/5-5-text-to-image",
      "input": {"prompt": PROMPT, "size": "2K", "aspect_ratio": "1:1", "output_format": "png",
                "background": "transparent", "nsfw_checker": False}}),
    ("seedream-5.5", "image_to_image", {"prompt": PROMPT}, [ref("image", I1)],
     {"model": "seedream/5-5-image-to-image",
      "input": {"prompt": PROMPT, "size": "2K", "aspect_ratio": "auto", "output_format": "png",
                "background": "auto", "nsfw_checker": False, "image_urls": [I1]}}),
    # --- GPT Image 2.6 -------------------------------------------------------
    ("gpt-image-2.6", "text_to_image", {"prompt": PROMPT}, [],
     {"model": "gpt-image-2-6/flare-text-to-image",
      "input": {"prompt": PROMPT, "resolution": "1K", "aspect_ratio": "auto", "quality": "medium",
                "background": "auto", "output_format": "png", "complexity": "high", "moderation": "low"}}),
    ("gpt-image-2.6", "image_to_image",
     {"prompt": PROMPT, "settings": {"tier": "sunburst", "output_format": "webp", "output_compression": 70}},
     [ref("image", I1)],
     {"model": "gpt-image-2-6/sunburst-image-to-image",
      "input": {"prompt": PROMPT, "resolution": "1K", "aspect_ratio": "auto", "quality": "medium",
                "background": "auto", "output_format": "webp", "complexity": "high", "moderation": "low",
                "output_compression": 70, "input_urls": [I1]}}),
    ("gpt-image-2.6", "text_to_image", {"prompt": PROMPT, "aspect_ratio": "16:9", "settings": {"tier": "economy"}},
     [],
     {"model": "gpt-image-2-6/economy-text-to-image",
      "input": {"prompt": PROMPT, "aspect_ratio": "16:9", "background": "auto", "output_format": "png"}}),
    ("gpt-image-2.6", "image_to_image", {"prompt": PROMPT, "settings": {"tier": "economy"}}, [ref("image", I1)],
     {"model": "gpt-image-2-6/economy-image-to-image",
      "input": {"prompt": PROMPT, "aspect_ratio": "auto", "background": "auto", "output_format": "png",
                "input_urls": [I1]}}),
    # --- MiniMax H3 Image ----------------------------------------------------
    ("minimax-h3-image", "text_to_image", {"prompt": PROMPT, "settings": {"seed": 7}}, [],
     {"model": "minimax-h3/text-to-image",
      "input": {"prompt": PROMPT, "resolution": "2K", "aspect_ratio": "auto", "expand_prompt": True,
                "output_format": "png", "seed": 7}}),
    ("minimax-h3-image", "image_to_image", {"prompt": "edit <Picture 1>"}, [ref("image", I1)],
     {"model": "minimax-h3/image-edit",
      "input": {"prompt": "edit <Picture 1>", "resolution": "2K", "aspect_ratio": "auto",
                "expand_prompt": True, "output_format": "png", "image_urls": [I1]}}),
    # --- Upscaler ------------------------------------------------------------
    ("image-upscaler", "image_to_image", {"settings": {"upscale_factor": "4"}}, [ref("image", I1)],
     {"model": "kie/image-upscale", "input": {"upscale_factor": "4", "image_url": I1}}),
    # --- remaining Kie combinations ------------------------------------------
    ("kling-4.0-flash", "text_to_video", {"prompt": PROMPT, "aspect_ratio": "21:9"}, [],
     {"model": "kling-4.0/flash-reference-to-video",
      "input": {"prompt": PROMPT, "duration": 5, "resolution": "720p", "aspect_ratio": "21:9"}}),
    ("seedance-2", "omni_reference_to_video", {"prompt": PROMPT}, [ref("video", V1)],
     {"model": "bytedance/seedance-2", "input": {"prompt": PROMPT, **SD_DEFAULTS, "reference_video_urls": [V1]}}),
    ("seedance-2-fast", "omni_reference_to_video", {"prompt": PROMPT}, [ref("image", I1), ref("audio", A1)],
     {"model": "bytedance/seedance-2-fast",
      "input": {"prompt": PROMPT, **SD_DEFAULTS, "reference_image_urls": [I1], "reference_audio_urls": [A1]}}),
    ("seedance-2-fast", "text_to_video", {"prompt": PROMPT, "aspect_ratio": "9:16"}, [],
     {"model": "bytedance/seedance-2-fast", "input": {"prompt": PROMPT, **SD_DEFAULTS, "aspect_ratio": "9:16"}}),
    ("seedance-2-mini", "image_to_video", {"prompt": PROMPT}, [first()],
     {"model": "bytedance/seedance-2-mini", "input": {"prompt": PROMPT, **SD_DEFAULTS, "first_frame_url": I1}}),
    ("seedance-2-mini", "text_to_video", {"prompt": PROMPT, "resolution": "480p"}, [],
     {"model": "bytedance/seedance-2-mini", "input": {"prompt": PROMPT, **SD_DEFAULTS, "resolution": "480p"}}),
    ("seedance-2.5", "image_to_video", {"prompt": PROMPT, "aspect_ratio": "1:1"}, [first(), last()],
     {"model": "bytedance/seedance-2-5",
      "input": {"prompt": PROMPT, "duration": 5, "resolution": "720p", "aspect_ratio": "1:1",
                "generate_audio": True, "output_format": "mp4", "nsfw_checker": False,
                "first_frame_url": I1, "last_frame_url": I2}}),
    ("wan-3.0", "image_to_video", {"prompt": PROMPT, "duration": 30}, [first(), last()],
     {"model": "wan/3-0-video",
      "input": {"prompt": PROMPT, "duration": 30, "resolution": "1080P", "aspect_ratio": "adaptive",
                "audio": True, "nsfw_checker": False, "first_frame_url": I1, "last_frame_url": I2}}),
    ("wan-3.0-prime", "omni_reference_to_video", {"prompt": "Image1 and Video1"},
     [ref("image", I1), ref("video", V1)],
     {"model": "wan/3-0-video-prime",
      "input": {"prompt": "Image1 and Video1", "duration": 5, "resolution": "1080P", "aspect_ratio": "adaptive",
                "audio": True, "nsfw_checker": False, "reference_image_urls": [I1], "reference_video_urls": [V1]}}),
    ("wan-3.0-prime", "text_to_video", {"prompt": PROMPT, "settings": {"audio": False, "nsfw_checker": True}}, [],
     {"model": "wan/3-0-video-prime",
      "input": {"prompt": PROMPT, "duration": 5, "resolution": "1080P", "aspect_ratio": "adaptive",
                "audio": False, "nsfw_checker": True}}),
]


@pytest.mark.parametrize("model,mode,params,refs,body", KIE_CASES, ids=[f"{c[0]}-{c[1]}" for c in KIE_CASES])
def test_kie_request(model, mode, params, refs, body):
    req = build("kie", model, mode, params, refs)
    assert (req.method, req.url) == ("POST", KIE_CREATE)
    assert req.body == body
    assert req.header_dict["Content-Type"] == "application/json"
    assert "Authorization" not in req.header_dict


PIAPI_SD = {"duration": 5, "aspect_ratio": "16:9", "audio": True}

PIAPI_CASES = [
    # --- Seedance 2 family -----------------------------------------------------
    ("seedance-2", "text_to_video", {"prompt": PROMPT}, [],
     {"model": "seedance", "task_type": "seedance-2",
      "input": {"prompt": PROMPT, "mode": "text_to_video", **PIAPI_SD, "resolution": "480p"}}),
    ("seedance-2-fast", "image_to_video", {"prompt": PROMPT, "aspect_ratio": "auto"}, [first(), last()],
     {"model": "seedance", "task_type": "seedance-2-fast",
      "input": {"prompt": PROMPT, "mode": "first_last_frames", **PIAPI_SD, "aspect_ratio": "auto",
                "resolution": "480p", "image_urls": [I1, I2]}}),
    ("seedance-2-mini", "omni_reference_to_video", {"prompt": PROMPT, "settings": {"audio": False}},
     [ref("image", I1), ref("video", V1), ref("audio", A1)],
     {"model": "seedance", "task_type": "seedance-2-mini",
      "input": {"prompt": PROMPT, "mode": "omni_reference", **PIAPI_SD, "audio": False, "resolution": "720p",
                "image_urls": [I1], "video_urls": [V1], "audio_urls": [A1]}}),
    ("seedance-2", "text_to_video", {"prompt": PROMPT, "settings": {"less_restriction": True}}, [],
     {"model": "seedance", "task_type": "seedance-2-less-restriction",
      "input": {"prompt": PROMPT, "mode": "text_to_video", **PIAPI_SD, "resolution": "480p",
                "auto_upload_assets": False}}),
    ("seedance-2-fast", "omni_reference_to_video", {"prompt": PROMPT, "settings": {"real_people": True}},
     [ref("image", I1)],
     {"model": "seedance", "task_type": "seedance-2-fast-less-restriction",
      "input": {"prompt": PROMPT, "mode": "omni_reference", **PIAPI_SD, "resolution": "480p", "image_urls": [I1],
                "auto_upload_assets": True}}),
    ("seedance-2.5", "text_to_video", {"prompt": PROMPT, "duration": 30, "resolution": "1080p"}, [],
     {"model": "seedance", "task_type": "seedance-2.5",
      "input": {"prompt": PROMPT, "mode": "text_to_video", "duration": 30, "aspect_ratio": "16:9",
                "resolution": "1080p"}}),
    ("seedance-2.5", "omni_reference_to_video",
     {"prompt": PROMPT, "aspect_ratio": "adaptive", "settings": {"less_restriction": True, "real_people": True}},
     [ref("audio", A1)],
     {"model": "seedance", "task_type": "seedance-2.5-less-restriction",
      "input": {"prompt": PROMPT, "mode": "omni_reference", "duration": 5, "aspect_ratio": "adaptive",
                "resolution": "720p", "audio_urls": [A1], "omni_reference_task_type": "reference",
                "auto_upload_assets": True}}),
    # --- Kling 4.0 -------------------------------------------------------------
    ("kling-4.0", "text_to_video", {"prompt": PROMPT, "resolution": "1080p", "duration": 8}, [],
     {"model": "kling", "task_type": "video_generation",
      "input": {"prompt": PROMPT, "version": "4.0", "duration": 8, "mode": "pro", "aspect_ratio": "16:9"},
      "config": {"service_mode": "public"}}),
    ("kling-4.0", "image_to_video", {"prompt": PROMPT}, [first(), last()],
     {"model": "kling", "task_type": "video_generation",
      "input": {"prompt": PROMPT, "version": "4.0", "duration": 5, "mode": "std", "image_url": I1,
                "image_tail_url": I2},
      "config": {"service_mode": "public"}}),
    ("kling-4.0-flash", "image_to_video", {"prompt": PROMPT, "aspect_ratio": "9:16"}, [first()],
     {"model": "kling", "task_type": "video_generation",
      "input": {"prompt": PROMPT, "version": "4.0-flash", "duration": 5, "mode": "std", "aspect_ratio": "9:16",
                "image_url": I1},
      "config": {"service_mode": "public"}}),
    ("kling-4.0", "omni_reference_to_video", {"prompt": "@image_1 with audio_1"},
     [ref("image", I1), ref("audio", A1)],
     {"model": "kling", "task_type": "omni_video_generation",
      "input": {"prompt": "@image_1 with audio_1", "version": "4.0", "duration": 5, "resolution": "720p",
                "aspect_ratio": "auto", "enable_audio": True, "images": [I1], "audio_urls": [A1]},
      "config": {"service_mode": "public"}}),
    ("kling-4.0-flash", "omni_reference_to_video",
     {"prompt": PROMPT, "settings": {"enable_audio": False, "keep_original_audio": True}}, [ref("video", V1)],
     {"model": "kling", "task_type": "omni_video_generation",
      "input": {"prompt": PROMPT, "version": "4.0-flash", "duration": 5, "resolution": "720p",
                "aspect_ratio": "auto", "enable_audio": False, "videos": [V1], "keep_original_audio": True},
      "config": {"service_mode": "public"}}),
    # --- Seedream --------------------------------------------------------------
    ("seedream-5-pro", "text_to_image", {"prompt": PROMPT}, [],
     {"model": "seedream", "task_type": "seedream-5-pro",
      "input": {"prompt": PROMPT, "aspect_ratio": "1:1", "size": "1K", "output_format": "jpeg"}}),
    ("seedream-5-lite", "image_to_image", {"prompt": PROMPT, "resolution": "3K",
                                           "settings": {"less_restriction": True, "output_format": "png"}},
     [ref("image", I1)],
     {"model": "seedream", "task_type": "seedream-5-lite-less-restriction",
      "input": {"prompt": PROMPT, "aspect_ratio": "1:1", "size": "3K", "output_format": "png",
                "image_urls": [I1]}}),
    # --- Upscaler --------------------------------------------------------------
    ("image-upscaler", "image_to_image", {}, [ref("image", I1)],
     {"model": "Qubico/image-toolkit", "task_type": "upscale",
      "input": {"image": I1, "scale": 2, "face_enhance": False}}),
    # --- remaining PiAPI combinations --------------------------------------
    ("kling-4.0-flash", "text_to_video", {"prompt": PROMPT, "duration": 20}, [],
     {"model": "kling", "task_type": "video_generation",
      "input": {"prompt": PROMPT, "version": "4.0-flash", "duration": 20, "mode": "std", "aspect_ratio": "16:9"},
      "config": {"service_mode": "public"}}),
    ("seedance-2", "image_to_video", {"prompt": PROMPT, "resolution": "1080p"}, [first()],
     {"model": "seedance", "task_type": "seedance-2",
      "input": {"prompt": PROMPT, "mode": "first_last_frames", **PIAPI_SD, "resolution": "1080p",
                "image_urls": [I1]}}),
    ("seedance-2", "omni_reference_to_video", {"prompt": "@image1 dances to @audio1"},
     [ref("image", I1), ref("audio", A1)],
     {"model": "seedance", "task_type": "seedance-2",
      "input": {"prompt": "@image1 dances to @audio1", "mode": "omni_reference", **PIAPI_SD, "resolution": "480p",
                "image_urls": [I1], "audio_urls": [A1]}}),
    ("seedance-2-fast", "text_to_video", {"prompt": PROMPT, "resolution": "720p"}, [],
     {"model": "seedance", "task_type": "seedance-2-fast",
      "input": {"prompt": PROMPT, "mode": "text_to_video", **PIAPI_SD, "resolution": "720p"}}),
    ("seedance-2-mini", "image_to_video", {"prompt": PROMPT, "settings": {"less_restriction": True}},
     [first(), last()],
     {"model": "seedance", "task_type": "seedance-2-mini-less-restriction",
      "input": {"prompt": PROMPT, "mode": "first_last_frames", **PIAPI_SD, "resolution": "720p",
                "image_urls": [I1, I2], "auto_upload_assets": False}}),
    ("seedance-2-mini", "text_to_video", {"prompt": PROMPT}, [],
     {"model": "seedance", "task_type": "seedance-2-mini",
      "input": {"prompt": PROMPT, "mode": "text_to_video", **PIAPI_SD, "resolution": "720p"}}),
    ("seedream-5-lite", "text_to_image", {"prompt": PROMPT, "aspect_ratio": "4:5"}, [],
     {"model": "seedream", "task_type": "seedream-5-lite",
      "input": {"prompt": PROMPT, "aspect_ratio": "4:5", "size": "2K", "output_format": "jpeg"}}),
    ("seedream-5-pro", "image_to_image", {"prompt": PROMPT, "resolution": "2K",
                                          "settings": {"less_restriction": True}},
     [ref("image", I1), ref("image", I2)],
     {"model": "seedream", "task_type": "seedream-5-pro-less-restriction",
      "input": {"prompt": PROMPT, "aspect_ratio": "1:1", "size": "2K", "output_format": "jpeg",
                "image_urls": [I1, I2]}}),
]


@pytest.mark.parametrize("model,mode,params,refs,body", PIAPI_CASES, ids=[f"{c[0]}-{c[1]}" for c in PIAPI_CASES])
def test_piapi_request(model, mode, params, refs, body):
    req = build("piapi", model, mode, params, refs)
    assert (req.method, req.url) == ("POST", PIAPI_TASK)
    assert req.body == body
    assert "x-api-key" not in {k.lower() for k in req.header_dict}


def test_every_supported_provider_model_mode_has_a_request_case():
    from backend.byok.catalog import CATALOG

    covered = {("kie", c[0], c[1]) for c in KIE_CASES} | {("piapi", c[0], c[1]) for c in PIAPI_CASES}
    expected = {(o.provider, m.id, s.mode) for m in CATALOG for o in m.offerings for s in o.modes if s.supported}
    assert expected - covered == set()


def test_kling_on_piapi_sends_only_documented_fields():
    allowed_gen = {"prompt", "version", "duration", "mode", "aspect_ratio", "image_url", "image_tail_url"}
    allowed_omni = {"prompt", "version", "resolution", "duration", "aspect_ratio", "enable_audio", "images",
                    "videos", "audio_urls", "keep_original_audio"}
    for model, mode, params, refs, _ in PIAPI_CASES:
        if not model.startswith("kling"):
            continue
        body = build("piapi", model, mode, params, refs).body
        allowed = allowed_omni if body["task_type"] == "omni_video_generation" else allowed_gen
        assert set(body["input"]) <= allowed
        assert set(body) == {"model", "task_type", "input", "config"}


def test_auto_upload_assets_never_sent_on_strict_task_types():
    for model, mode, params, refs, _ in PIAPI_CASES:
        body = build("piapi", model, mode, params, refs).body
        if not body["task_type"].endswith("-less-restriction"):
            assert "auto_upload_assets" not in body["input"]


def test_kie_kling_audio_is_sent_as_voices_and_piapi_as_audio():
    audio = ref("audio", A1)
    kie = build("kie", "kling-4.0", "omni_reference_to_video", {"prompt": PROMPT}, [ref("image", I1), audio]).body
    assert kie["input"]["voices"] == [{"name": "sound_1", "audio_url": A1}]
    assert "audio_urls" not in kie["input"]
    piapi = build("piapi", "kling-4.0", "omni_reference_to_video", {"prompt": PROMPT}, [ref("image", I1), audio]).body
    assert "voices" not in piapi["input"]


def test_build_request_raises_validation_with_issues():
    with pytest.raises(ProviderError) as exc:
        build("kie", "seedance-2", "omni_reference_to_video", {"prompt": PROMPT},
              [ref("image", I1) for _ in range(10)])
    err = exc.value
    assert err.kind == "validation" and err.retryable is False
    assert [i.code for i in err.issues] == ["too_many_references"]
    assert "at most 9 images" in err.message


def test_build_request_rejects_wrong_provider_model():
    with pytest.raises(ProviderError) as exc:
        build("piapi", "wan-3.0", "text_to_video")
    assert exc.value.kind == "unsupported"


def test_build_request_does_not_mutate_inputs():
    params = {"prompt": PROMPT, "settings": {"seed": 3}}
    refs = [first()]
    before = (dict(params), dict(params["settings"]), list(refs))
    build("kie", "wan-3.0", "image_to_video", params, refs)
    assert (params, params["settings"], refs) == (before[0], before[1], before[2])


def test_build_request_keeps_reference_order_and_all_items():
    urls = [f"https://cdn.test/{i}.png" for i in range(9)]
    req = build("kie", "seedance-2", "omni_reference_to_video", {"prompt": PROMPT}, [ref("image", u) for u in urls])
    assert req.body["input"]["reference_image_urls"] == urls


def test_output_kind_recorded_on_request():
    assert build("kie", "wan-3.0", "text_to_video").output_kind == "video"
    assert build("piapi", "seedream-5-pro", "text_to_image").output_kind == "image"
