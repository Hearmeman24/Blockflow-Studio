"""The capability catalog: every model, provider and mode the app offers.

All values come from the provider documentation as published on 2026-11-15.
Where the docs are silent or contradict
themselves the safest documented value is used and an entry is added to
``UNVERIFIED``. Nothing here is guessed silently.
"""

from __future__ import annotations

from dataclasses import replace

from backend.byok.spec import (
    MB,
    MIB,
    ChoiceSpec,
    DurationSpec,
    FrameSpec,
    MediaLimit,
    MentionSpec,
    ModelEntry,
    ModeSpec,
    PromptSpec,
    ProviderModelId,
    ProviderOffering,
    SettingSpec,
    Unverified,
)

# ---------------------------------------------------------------------------
# Shared building blocks
# ---------------------------------------------------------------------------

NOT_ON_PIAPI = "Not offered by PiAPI"
NOT_ON_KIE = "Not offered by Kie"


def _unsupported(mode: str, reason: str) -> ModeSpec:
    return ModeSpec(mode=mode, supported=False, unavailable_reason=reason)


def _bool(key: str, label: str, default: bool | None, description: str = "", category: str = "general") -> SettingSpec:
    return SettingSpec(key=key, type="bool", label=label, default=default, description=description, category=category)


def _enum(key: str, label: str, choices: tuple, default, description: str = "", category: str = "general") -> SettingSpec:
    return SettingSpec(key=key, type="enum", label=label, choices=choices, default=default,
                       description=description, category=category)


def _int(key: str, label: str, lo: int, hi: int, default: int | None = None, description: str = "") -> SettingSpec:
    return SettingSpec(key=key, type="int", label=label, minimum=lo, maximum=hi, default=default,
                       description=description)


SEED = _int("seed", "Seed", 0, 2147483647, None, "Leave empty for a random seed.")

KIE_NSFW_CHECKER = _bool(
    "nsfw_checker",
    "Kie content filter",
    False,
    "Kie's optional extra content filter. Off by default in the API: results are returned as the model produced them.",
    category="content",
)
PIAPI_LESS_RESTRICTION = _bool(
    "less_restriction",
    "Less restriction",
    False,
    "Use PiAPI's -less-restriction task type: a more permissive content review at a higher price, "
    "with no retry after a content rejection.",
    category="content",
)
PIAPI_REAL_PEOPLE = _bool(
    "real_people",
    "Real people in references",
    False,
    "References show real people. Switches to the -less-restriction task type and sends "
    "auto_upload_assets so PiAPI ingests the references into its Private Asset Library. "
    "Adds up to about 90 seconds and needs a paid PiAPI plan.",
    category="content",
)

# ---------------------------------------------------------------------------
# Seedance (ByteDance)
# ---------------------------------------------------------------------------

_SD_ASPECTS = ("1:1", "4:3", "3:4", "16:9", "9:16", "21:9", "adaptive")


def _kie_seedance_media(*, v25: bool, image_formats: tuple[str, ...]) -> tuple[MediaLimit, ...]:
    image = MediaLimit("image", 30 if v25 else 9, formats=image_formats, max_size_bytes=30 * MB,
                       min_side_px=300, max_side_px=6000, min_aspect=0.4, max_aspect=2.5)
    if v25:
        video = MediaLimit("video", 10, formats=("mp4", "mov", "mkv"), max_size_bytes=200 * MB,
                           min_duration_s=2, max_duration_s=30, max_total_duration_s=30,
                           min_side_px=300, max_side_px=6000, min_aspect=0.4, max_aspect=2.5)
        audio = MediaLimit("audio", 10, formats=("wav", "mp3", "aac", "ogg"), max_size_bytes=15 * MB,
                           min_duration_s=2, max_duration_s=30, max_total_duration_s=30)
    else:
        video = MediaLimit("video", 3, formats=("mp4", "mov"), max_size_bytes=50 * MB,
                           min_duration_s=2, max_duration_s=15, max_total_duration_s=15,
                           min_side_px=300, max_side_px=6000, min_aspect=0.4, max_aspect=2.5)
        audio = MediaLimit("audio", 3, formats=("wav", "mp3"), max_size_bytes=15 * MB,
                           min_duration_s=2, max_duration_s=15, max_total_duration_s=15)
    return (image, video, audio)


def _kie_seedance(model: str, *, resolutions: tuple[str, ...], image_formats: tuple[str, ...], v25: bool = False) -> ProviderOffering:
    ids = ProviderModelId(model)
    prompt = PromptSpec("required", 20480, None) if v25 else PromptSpec("required", 20000, 3)
    duration = DurationSpec(4, 30 if v25 else 15, 5, auto_value=-1)
    res = ChoiceSpec(resolutions, "720p")
    aspects = ChoiceSpec(_SD_ASPECTS, "adaptive" if v25 else "16:9")
    settings: tuple[SettingSpec, ...] = (
        _bool("generate_audio", "Generate audio", True, "Generate audio synchronised with the video."),
    )
    if v25:
        settings += (_enum("output_format", "Output format", ("mp4", "mov"), "mp4"),)
    settings += (KIE_NSFW_CHECKER,)
    image_media = _kie_seedance_media(v25=v25, image_formats=image_formats)
    common = dict(ids=ids, prompt=prompt, duration=duration, resolutions=res, aspect_ratios=aspects, settings=settings)
    return ProviderOffering(
        provider="kie",
        offered=True,
        modes=(
            ModeSpec(mode="text_to_video", supported=True, **common),
            ModeSpec(mode="image_to_video", supported=True, media=(image_media[0],),
                     frames=FrameSpec(first_frame_required=True, last_frame_allowed=True),
                     mixed_media_allowed=False, **common),
            ModeSpec(mode="omni_reference_to_video", supported=True, media=image_media,
                     max_total_references=50 if v25 else 12, min_total_references=1,
                     audio_only_allowed=False, **common),
        ),
    )


_PIAPI_SD_IMAGE = MediaLimit("image", 9, formats=("jpeg", "jpg", "png", "webp", "bmp", "tiff", "gif"),
                             max_size_bytes=30 * MB, min_side_px=300, max_side_px=6000)
_PIAPI_SD_FRAME = MediaLimit("image", 2, formats=("jpg", "jpeg", "png", "webp", "bmp"),
                             max_size_bytes=30 * MB, min_side_px=300, max_side_px=6000)


def _piapi_seedance(task_type: str, *, resolutions: tuple[str, ...], default_res: str) -> ProviderOffering:
    prompt = PromptSpec("required", 4000)
    duration = DurationSpec(4, 15, 5)
    res = ChoiceSpec(resolutions, default_res)
    six = ("21:9", "16:9", "4:3", "1:1", "3:4", "9:16")
    settings = (_bool("audio", "Generate audio", True, "No audio is generated when off."),
                PIAPI_LESS_RESTRICTION, PIAPI_REAL_PEOPLE)
    common = dict(ids=ProviderModelId("seedance", task_type), prompt=prompt, duration=duration,
                  resolutions=res, settings=settings)
    media = (
        _PIAPI_SD_IMAGE,
        MediaLimit("video", 3, formats=("mp4", "mov"), max_size_bytes=50 * MB, min_duration_s=2,
                   max_duration_s=15, max_total_duration_s=15),
        MediaLimit("audio", 3, formats=("mp3", "wav"), max_total_duration_s=15),
    )
    return ProviderOffering(
        provider="piapi",
        offered=True,
        modes=(
            ModeSpec(mode="text_to_video", supported=True, aspect_ratios=ChoiceSpec(six, "16:9"), **common),
            ModeSpec(mode="image_to_video", supported=True, media=(_PIAPI_SD_FRAME,),
                     frames=FrameSpec(first_frame_required=True, last_frame_allowed=True),
                     mixed_media_allowed=False, aspect_ratios=ChoiceSpec(six + ("auto",), "16:9"), **common),
            ModeSpec(mode="omni_reference_to_video", supported=True, media=media, max_total_references=12,
                     min_total_references=1, audio_only_allowed=False,
                     aspect_ratios=ChoiceSpec(six, "16:9"), **common),
        ),
    )


def _piapi_seedance_25() -> ProviderOffering:
    common = dict(
        ids=ProviderModelId("seedance", "seedance-2.5"),
        prompt=PromptSpec("required", 4000),
        duration=DurationSpec(4, 30, 5),
        resolutions=ChoiceSpec(("480p", "720p", "1080p"), "720p"),
        aspect_ratios=ChoiceSpec(("16:9", "9:16", "4:3", "3:4", "21:9", "1:1", "adaptive"), "16:9"),
        settings=(PIAPI_LESS_RESTRICTION, PIAPI_REAL_PEOPLE),
    )
    media = (
        MediaLimit("image", 30),
        MediaLimit("video", 10, formats=("mp4", "mov"), max_size_bytes=200 * MB, min_duration_s=2,
                   max_duration_s=30, max_total_duration_s=30),
        MediaLimit("audio", 10, formats=("mp3", "wav"), max_size_bytes=15 * MB, min_duration_s=2,
                   max_duration_s=30, max_total_duration_s=30),
    )
    return ProviderOffering(
        provider="piapi",
        offered=True,
        modes=(
            ModeSpec(mode="text_to_video", supported=True, **common),
            _unsupported("image_to_video",
                         "PiAPI documents no first/last frame control for Seedance 2.5. "
                         "Use Omni Reference to Video, or Kie."),
            ModeSpec(mode="omni_reference_to_video", supported=True, media=media, max_total_references=50,
                     min_total_references=1, audio_only_allowed=True, **common),
        ),
    )


# ---------------------------------------------------------------------------
# Kling 4.0
# ---------------------------------------------------------------------------

_KLING_T2V_ASPECTS = ChoiceSpec(("16:9", "9:16", "1:1", "21:9"), "16:9")


def _kie_kling(*, flash: bool) -> ProviderOffering:
    prefix = "kling-4.0/flash-" if flash else "kling-4.0/"
    ref_ids = ProviderModelId(prefix + "reference-to-video")
    key_ids = ProviderModelId(prefix + "keyframe-to-video")
    prompt = PromptSpec("required", 8000, 1)
    duration = DurationSpec(3, 20 if flash else 30, 5)
    res = ChoiceSpec(("720p",), "720p") if flash else ChoiceSpec(("720p", "1080p"), "720p")
    keep_sound = _bool("keep_original_sound", "Keep reference video sound", False,
                       "Keep the original audio of the reference videos. Only applies when videos are given.")
    image = MediaLimit("image", 10, min_side_px=None if flash else 300, max_side_px=None if flash else 65536,
                       min_aspect=None if flash else 0.4, max_aspect=None if flash else 2.5)
    if flash:
        video = MediaLimit("video", 5, max_total_duration_s=20, min_total_duration_s=2)
        omni_media: tuple[MediaLimit, ...] = (image, video)
    else:
        video = MediaLimit("video", 5, min_duration_s=2, max_duration_s=30)
        # Audio is sent as the API's `voices` list (max 3); see KIE_KLING_AUDIO_NAME.
        omni_media = (image, video, MediaLimit("audio", 3))
    return ProviderOffering(
        provider="kie",
        offered=True,
        modes=(
            ModeSpec(mode="text_to_video", supported=True, ids=ref_ids, prompt=prompt, duration=duration,
                     resolutions=res, aspect_ratios=_KLING_T2V_ASPECTS,
                     notes=("Sent to the reference-to-video model with no materials (plain text-to-video).",)),
            ModeSpec(mode="image_to_video", supported=True, ids=key_ids, prompt=prompt, duration=duration,
                     resolutions=res, media=(MediaLimit("image", 1 if flash else 2),),
                     frames=FrameSpec(first_frame_required=True, last_frame_allowed=not flash),
                     mixed_media_allowed=False,
                     notes=("Output follows the first frame's aspect ratio.",)),
            ModeSpec(mode="omni_reference_to_video", supported=True, ids=ref_ids, prompt=prompt,
                     duration=duration, resolutions=res,
                     aspect_ratios=ChoiceSpec(("auto", "16:9", "9:16", "1:1", "21:9"), None),
                     media=omni_media, max_total_references=15, min_total_references=1,
                     audio_only_allowed=False, settings=(keep_sound,),
                     rules=("keep_sound_needs_video",)),
        ),
    )


def _piapi_kling(*, flash: bool) -> ProviderOffering:
    version = "4.0-flash" if flash else "4.0"
    gen_ids = ProviderModelId("kling", "video_generation", version)
    omni_ids = ProviderModelId("kling", "omni_video_generation", version)
    prompt = PromptSpec("required", 2500)
    duration = DurationSpec(3, 20 if flash else 30, 5)
    res = ChoiceSpec(("720p",), "720p") if flash else ChoiceSpec(("720p", "1080p"), "720p")
    omni_media: tuple[MediaLimit, ...] = (
        MediaLimit("image", 10),
        MediaLimit("video", 5, formats=("mp4",), max_size_bytes=300 * MIB, min_duration_s=3,
                   max_duration_s=20 if flash else 30, max_total_duration_s=20 if flash else 30,
                   min_aspect=0.4, max_aspect=2.5),
    )
    if not flash:
        omni_media += (MediaLimit("audio", 3, formats=("mp3", "wav", "flac"), max_size_bytes=50 * MIB,
                                  min_duration_s=5, max_duration_s=30),)
    omni_settings = (
        _bool("enable_audio", "Generate audio", True, "Generate native audio."),
        _bool("keep_original_audio", "Keep reference video sound", False,
              "Keep the reference video's original audio. Needs a reference video and audio generation off."),
    )
    return ProviderOffering(
        provider="piapi",
        offered=True,
        modes=(
            ModeSpec(mode="text_to_video", supported=True, ids=gen_ids, prompt=prompt, duration=duration,
                     resolutions=res, aspect_ratios=_KLING_T2V_ASPECTS),
            ModeSpec(mode="image_to_video", supported=True, ids=gen_ids, prompt=prompt, duration=duration,
                     resolutions=res,
                     aspect_ratios=ChoiceSpec(("16:9", "9:16", "1:1", "21:9"), None),
                     media=(MediaLimit("image", 1 if flash else 2, max_size_bytes=10 * MB, min_side_px=301),),
                     frames=FrameSpec(first_frame_required=True, last_frame_allowed=not flash),
                     mixed_media_allowed=False,
                     notes=("Without an aspect ratio the output follows the first frame.",)),
            ModeSpec(mode="omni_reference_to_video", supported=True, ids=omni_ids, prompt=prompt,
                     duration=duration, resolutions=res,
                     aspect_ratios=ChoiceSpec(("auto", "16:9", "9:16", "1:1", "21:9"), "auto"),
                     media=omni_media, max_total_references=15, min_total_references=1,
                     audio_only_allowed=False, settings=omni_settings,
                     rules=("keep_audio_needs_video_and_no_audio",)),
        ),
    )


# ---------------------------------------------------------------------------
# Wan 3.0 (Kie only)
# ---------------------------------------------------------------------------


def _kie_wan(model: str) -> ProviderOffering:
    image = MediaLimit("image", 10, formats=("jpeg", "jpg", "png", "bmp", "webp"), max_size_bytes=20 * MB,
                       min_side_px=240, max_side_px=8000, min_aspect=1 / 8, max_aspect=8)
    media = (
        image,
        MediaLimit("video", 5, formats=("mp4", "mov"), max_size_bytes=100 * MB, min_duration_s=1,
                   max_duration_s=15, max_total_duration_s=15, min_side_px=240, max_side_px=4096,
                   min_aspect=1 / 8, max_aspect=8),
        MediaLimit("audio", 5, formats=("wav", "mp3"), max_size_bytes=15 * MB, min_duration_s=1,
                   max_duration_s=15, max_total_duration_s=15),
    )
    settings = (_bool("audio", "Generate audio", True, "Include an audio track in the output."), SEED,
                KIE_NSFW_CHECKER)
    common = dict(ids=ProviderModelId(model), duration=DurationSpec(2, 30, 5, auto_value=-1),
                  resolutions=ChoiceSpec(("480P", "720P", "1080P"), "1080P"),
                  aspect_ratios=ChoiceSpec(("adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"), "adaptive"),
                  settings=settings)
    return ProviderOffering(
        provider="kie",
        offered=True,
        modes=(
            ModeSpec(mode="text_to_video", supported=True, prompt=PromptSpec("required", 20000), **common),
            ModeSpec(mode="image_to_video", supported=True, prompt=PromptSpec("optional", 20000),
                     media=(MediaLimit("image", 2, formats=image.formats, max_size_bytes=image.max_size_bytes,
                                       min_side_px=240, max_side_px=8000, min_aspect=1 / 8, max_aspect=8),),
                     frames=FrameSpec(first_frame_required=True, last_frame_allowed=True),
                     mixed_media_allowed=False, **common),
            ModeSpec(mode="omni_reference_to_video", supported=True, prompt=PromptSpec("optional", 20000),
                     media=media, min_total_references=1, audio_only_allowed=True,
                     rules=("wan_video_plus_output",), **common),
        ),
    )


# ---------------------------------------------------------------------------
# Image models
# ---------------------------------------------------------------------------

_SEEDREAM_KIE_ASPECTS = ("1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9")
_KIE_IMG_FORMATS = ("jpeg", "jpg", "png", "webp")


def _kie_seedream(variant: str) -> ProviderOffering:
    """variant: '5-pro' | '5-flash' | '5-5'."""
    if variant == "5-pro":
        prompt = PromptSpec("required", 5000, 4)
        res = None
        settings = (
            _enum("quality", "Quality", ("basic", "high"), "basic", "Basic outputs 1K images, High outputs 2K."),
            _enum("output_format", "Output format", ("png", "jpeg"), "png"),
            KIE_NSFW_CHECKER,
        )
        t2i_aspects = i2i_aspects = ChoiceSpec(_SEEDREAM_KIE_ASPECTS, "1:1")
        image = MediaLimit("image", 10, min_count=1, formats=_KIE_IMG_FORMATS, max_size_bytes=30 * MB)
        rules: tuple[str, ...] = ()
    elif variant == "5-flash":
        prompt = PromptSpec("required", 5000, 4)
        res = ChoiceSpec(("1K", "1.5K", "2K"), "1K")
        settings = (_enum("output_format", "Output format", ("png", "jpeg"), "png"), KIE_NSFW_CHECKER)
        t2i_aspects = i2i_aspects = ChoiceSpec(_SEEDREAM_KIE_ASPECTS, "1:1")
        image = MediaLimit("image", 10, min_count=1, formats=_KIE_IMG_FORMATS, max_size_bytes=30 * MB)
        rules = ()
    else:
        prompt = PromptSpec("required", 5000, 5)
        res = ChoiceSpec(("1K", "1.5K", "2K"), "2K")
        settings = (
            _enum("output_format", "Output format", ("png", "jpeg"), "png"),
            _enum("background", "Background", ("auto", "transparent", "opaque"), "auto",
                  "Transparent needs PNG output."),
            KIE_NSFW_CHECKER,
        )
        t2i_aspects = ChoiceSpec(_SEEDREAM_KIE_ASPECTS, "1:1")
        i2i_aspects = ChoiceSpec(_SEEDREAM_KIE_ASPECTS + ("auto",), "auto")
        image = MediaLimit("image", 10, min_count=1, formats=_KIE_IMG_FORMATS, max_size_bytes=10 * MB)
        rules = ("transparent_needs_png",)
    return ProviderOffering(
        provider="kie",
        offered=True,
        modes=(
            ModeSpec(mode="text_to_image", supported=True, ids=ProviderModelId(f"seedream/{variant}-text-to-image"),
                     prompt=prompt, resolutions=res, aspect_ratios=t2i_aspects, settings=settings, rules=rules),
            ModeSpec(mode="image_to_image", supported=True,
                     ids=ProviderModelId(f"seedream/{variant}-image-to-image"), prompt=prompt, resolutions=res,
                     aspect_ratios=i2i_aspects, settings=settings, media=(image,), min_total_references=1,
                     rules=rules),
        ),
    )


def _piapi_seedream(tier: str) -> ProviderOffering:
    res = ChoiceSpec(("1K", "2K"), "1K") if tier == "pro" else ChoiceSpec(("2K", "3K"), "2K")
    aspects = ChoiceSpec(("1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9"), "1:1")
    settings = (_enum("output_format", "Output format", ("png", "jpeg"), "jpeg"), PIAPI_LESS_RESTRICTION)
    common = dict(ids=ProviderModelId("seedream", f"seedream-5-{tier}"), prompt=PromptSpec("required"),
                  resolutions=res, aspect_ratios=aspects, settings=settings)
    image = MediaLimit("image", 10, min_count=1, formats=("jpeg", "jpg", "png", "webp", "bmp", "tiff", "gif"),
                       max_size_bytes=30 * MB, min_side_px=300, max_side_px=6000)
    return ProviderOffering(
        provider="piapi",
        offered=True,
        modes=(
            ModeSpec(mode="text_to_image", supported=True, **common),
            ModeSpec(mode="image_to_image", supported=True, media=(image,), min_total_references=1, **common),
        ),
    )


_GPT_FULL_ASPECTS = ("auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2",
                     "21:9", "9:21", "3:1", "1:3")
_GPT_ECONOMY_ASPECTS = ("auto", "1:1", "16:9", "9:16", "3:2", "2:3", "21:9", "4:3")
GPT_TIER = _enum("tier", "Tier", ("flare", "sunburst", "economy"), "flare",
                 "Flare and Sunburst are separate models; Economy is the budget route.", category="variant")


def _gpt_variant(mode: str, tier: str) -> ModeSpec:
    suffix = "text-to-image" if mode == "text_to_image" else "image-to-image"
    ids = ProviderModelId(f"gpt-image-2-6/{tier}-{suffix}")
    background = _enum("background", "Background", ("auto", "transparent", "opaque"), "auto",
                       "Transparent needs PNG or WebP output.")
    if tier == "economy":
        prompt = PromptSpec("required", 20000, 1)
        settings: tuple[SettingSpec, ...] = (GPT_TIER, background,
                                             _enum("output_format", "Output format", ("png",), "png"))
        aspects = ChoiceSpec(_GPT_ECONOMY_ASPECTS, "auto")
        res = None
        image = MediaLimit("image", 16, min_count=1, formats=_KIE_IMG_FORMATS, max_size_bytes=30 * MB)
        rules: tuple[str, ...] = ()
    else:
        prompt = PromptSpec("required", 32000, 1)
        settings = (
            GPT_TIER,
            _enum("quality", "Quality", ("low", "medium", "high", "xhigh", "max", "auto"), "medium"),
            background,
            _enum("output_format", "Output format", ("png", "jpeg", "webp"), "png"),
            _enum("complexity", "Planning complexity", ("low", "medium", "high"), "high"),
            _enum("moderation", "Moderation", ("auto", "low"), "low", category="content"),
            _int("output_compression", "Compression", 0, 100, None, "JPEG / WebP only."),
        )
        aspects = ChoiceSpec(_GPT_FULL_ASPECTS, "auto")
        res = ChoiceSpec(("1K", "2K", "4K"), "1K")
        image = MediaLimit("image", 16, min_count=1, formats=_KIE_IMG_FORMATS)
        rules = ("transparent_needs_png_or_webp", "compression_needs_jpeg_or_webp")
    extra = dict(media=(image,), min_total_references=1) if mode == "image_to_image" else {}
    return ModeSpec(mode=mode, supported=True, ids=ids, prompt=prompt, resolutions=res, aspect_ratios=aspects,
                    settings=settings, rules=rules, **extra)


def _kie_gpt_image() -> ProviderOffering:
    modes = []
    for mode in ("text_to_image", "image_to_image"):
        variants = tuple((tier, _gpt_variant(mode, tier)) for tier in ("flare", "sunburst", "economy"))
        flare = variants[0][1]
        modes.append(ModeSpec(mode=mode, supported=True, ids=flare.ids, prompt=flare.prompt, media=flare.media,
                              min_total_references=flare.min_total_references, resolutions=flare.resolutions,
                              aspect_ratios=flare.aspect_ratios, settings=flare.settings, rules=flare.rules,
                              variant_key="tier", variants=variants))
    return ProviderOffering(provider="kie", offered=True, modes=tuple(modes))


def _kie_minimax_h3() -> ProviderOffering:
    aspects = ChoiceSpec(("auto", "1:1", "5:4", "4:3", "3:2", "16:9", "21:9", "4:5", "3:4", "2:3", "9:16"), "auto")
    settings = (
        _bool("expand_prompt", "Expand prompt", True, "Rewrite the prompt into a detailed description first."),
        _enum("output_format", "Output format", ("png", "jpeg"), "png"),
        SEED,
    )
    common = dict(prompt=PromptSpec("required", 5000, 1), resolutions=ChoiceSpec(("1K", "2K", "4K"), "2K"),
                  aspect_ratios=aspects, settings=settings)
    image = MediaLimit("image", 16, min_count=1, formats=("jpg", "jpeg", "png", "webp", "heic", "bmp"),
                       max_size_bytes=20 * MB)
    return ProviderOffering(
        provider="kie",
        offered=True,
        modes=(
            ModeSpec(mode="text_to_image", supported=True, ids=ProviderModelId("minimax-h3/text-to-image"), **common),
            ModeSpec(mode="image_to_image", supported=True, ids=ProviderModelId("minimax-h3/image-edit"),
                     media=(image,), min_total_references=1, **common),
        ),
    )


def _upscaler(provider: str) -> ProviderOffering:
    t2i = _unsupported("text_to_image", "The upscaler only works on an input image.")
    if provider == "kie":
        i2i = ModeSpec(
            mode="image_to_image", supported=True, ids=ProviderModelId("kie/image-upscale"),
            prompt=PromptSpec("none"),
            media=(MediaLimit("image", 1, min_count=1, formats=("jpg", "jpeg", "png", "webp", "gif"),
                              max_size_bytes=20 * MB),),
            min_total_references=1,
            settings=(_enum("upscale_factor", "Upscale factor", ("1", "2", "4", "8"), "2",
                            "1 enhances quality at the same size. Output must stay within 67 MP."),),
        )
    else:
        i2i = ModeSpec(
            mode="image_to_image", supported=True, ids=ProviderModelId("Qubico/image-toolkit", "upscale"),
            prompt=PromptSpec("none"),
            media=(MediaLimit("image", 1, min_count=1, max_side_px=2048),),
            min_total_references=1,
            settings=(_enum("scale", "Upscale factor", (2, 4, 8), 2),
                      _bool("face_enhance", "Face enhance", False)),
        )
    return ProviderOffering(provider=provider, offered=True, modes=(t2i, i2i))


def _absent(provider: str) -> ProviderOffering:
    return ProviderOffering(provider=provider, offered=False, reason=NOT_ON_PIAPI if provider == "piapi" else NOT_ON_KIE)


_SD_IMG_FORMATS = ("jpeg", "jpg", "png", "webp", "bmp", "tiff", "gif")

CATALOG: tuple[ModelEntry, ...] = (
    ModelEntry("seedance-2", "Seedance 2", "video", False, (
        _kie_seedance("bytedance/seedance-2", resolutions=("480p", "720p", "1080p", "4k"),
                      image_formats=_SD_IMG_FORMATS),
        _piapi_seedance("seedance-2", resolutions=("480p", "720p", "1080p"), default_res="480p"),
    )),
    ModelEntry("seedance-2-fast", "Seedance 2 Fast", "video", False, (
        _kie_seedance("bytedance/seedance-2-fast", resolutions=("480p", "720p"), image_formats=_SD_IMG_FORMATS),
        _piapi_seedance("seedance-2-fast", resolutions=("480p", "720p"), default_res="480p"),
    )),
    ModelEntry("seedance-2-mini", "Seedance 2 Mini", "video", False, (
        _kie_seedance("bytedance/seedance-2-mini", resolutions=("480p", "720p"),
                      image_formats=("jpeg", "jpg", "png", "webp", "gif")),
        _piapi_seedance("seedance-2-mini", resolutions=("480p", "720p"), default_res="720p"),
    )),
    ModelEntry("seedance-2.5", "Seedance 2.5", "video", False, (
        _kie_seedance("bytedance/seedance-2-5", resolutions=("480p", "720p", "1080p"),
                      image_formats=("jpeg", "jpg", "png", "webp"), v25=True),
        _piapi_seedance_25(),
    )),
    ModelEntry("kling-4.0", "Kling 4.0", "video", False, (_kie_kling(flash=False), _piapi_kling(flash=False))),
    ModelEntry("kling-4.0-flash", "Kling 4.0 Flash", "video", False, (_kie_kling(flash=True), _piapi_kling(flash=True))),
    ModelEntry("wan-3.0", "Wan 3.0", "video", True, (_kie_wan("wan/3-0-video"), _absent("piapi"))),
    ModelEntry("wan-3.0-prime", "Wan 3.0 Prime", "video", True, (_kie_wan("wan/3-0-video-prime"), _absent("piapi"))),
    ModelEntry("seedream-5-pro", "Seedream 5 Pro", "image", True, (_kie_seedream("5-pro"), _piapi_seedream("pro"))),
    ModelEntry("seedream-5-flash", "Seedream 5 Flash", "image", True, (_kie_seedream("5-flash"), _absent("piapi"))),
    ModelEntry("seedream-5-lite", "Seedream 5 Lite", "image", True, (_absent("kie"), _piapi_seedream("lite"))),
    ModelEntry("seedream-5.5", "Seedream 5.5", "image", True, (_kie_seedream("5-5"), _absent("piapi"))),
    ModelEntry("gpt-image-2.6", "GPT Image 2.6", "image", False, (_kie_gpt_image(), _absent("piapi"))),
    ModelEntry("minimax-h3-image", "MiniMax H3 Image", "image", True, (_kie_minimax_h3(), _absent("piapi"))),
    ModelEntry("image-upscaler", "Image Upscaler", "image", False, (_upscaler("kie"), _upscaler("piapi")),
               description="Kie and PiAPI run different upscaler models."),
)

# ---------------------------------------------------------------------------
# Prompt mention syntax
# ---------------------------------------------------------------------------
# How the prompt refers to references, from the provider docs. Where a provider documents nothing for a
# model, the fallback form ("Image1", "Video1", "Audio1") is used and the gap is listed in UNVERIFIED.

REFERENCE_MODES = ("image_to_video", "image_to_image", "omni_reference_to_video")
PLAIN_MENTIONS = MentionSpec()
_PIAPI_SEEDANCE = MentionSpec("@image{n}", "@video{n}", "@audio{n}", documented=True)
# Kling 4.0 on Kie has no audio field: each audio reference is sent as one
# entry of the API's `voices` list, named KIE_KLING_AUDIO_NAME (n = its 1-based
# position among the request's audio references) and mentioned as `@<name>`
# ("`@name` maps to the `name` of an item in `elements` or `voices`"). The doc
# reserves `audio_N` (with image_N, video_N, ...), so the names are `sound_N`.
KIE_KLING_AUDIO_NAME = "sound_{n}"
_KIE_KLING_OMNI = MentionSpec("@image_{n}", "@video_{n}", documented=True)
_KIE_KLING_4_OMNI = replace(_KIE_KLING_OMNI, audio="@" + KIE_KLING_AUDIO_NAME)
# PiAPI writes audio as `audio_1` without the @ (Kling 4.0 omni docs).
_PIAPI_KLING_OMNI = MentionSpec("@image_{n}", "@video_{n}", "audio_{n}", documented=True)
_KIE_KLING_FRAMES = MentionSpec("@image_{n}", first_frame="@first_frame", last_frame="@last_frame", documented=True)
_KIE_WAN_OMNI = MentionSpec("Image{n}", "Video{n}", "Audio{n}", documented=True)

MENTIONS: dict[tuple[str, str, str], MentionSpec] = {
    **{("piapi", m, mode): _PIAPI_SEEDANCE
       for m in ("seedance-2", "seedance-2-fast", "seedance-2-mini", "seedance-2.5")
       for mode in ("image_to_video", "omni_reference_to_video")},
    ("kie", "kling-4.0", "omni_reference_to_video"): _KIE_KLING_4_OMNI,
    ("kie", "kling-4.0-flash", "omni_reference_to_video"): _KIE_KLING_OMNI,
    ("kie", "kling-4.0", "image_to_video"): _KIE_KLING_FRAMES,
    ("kie", "kling-4.0-flash", "image_to_video"): _KIE_KLING_FRAMES,
    ("piapi", "kling-4.0", "omni_reference_to_video"): _PIAPI_KLING_OMNI,
    ("piapi", "kling-4.0-flash", "omni_reference_to_video"): _PIAPI_KLING_OMNI,
    ("kie", "wan-3.0", "omni_reference_to_video"): _KIE_WAN_OMNI,
    ("kie", "wan-3.0-prime", "omni_reference_to_video"): _KIE_WAN_OMNI,
    ("kie", "minimax-h3-image", "image_to_image"): MentionSpec("<Picture {n}>", documented=True),
    # Kie's GPT Image docs: "refer to them by order in the prompt (for example, ... image 1 ...)".
    ("kie", "gpt-image-2.6", "image_to_image"): MentionSpec("image {n}", "video {n}", "audio {n}", documented=True),
}


def _with_mentions(spec: ModeSpec, provider: str, model_id: str) -> ModeSpec:
    if not spec.supported or spec.mode not in REFERENCE_MODES:
        return spec
    mentions = MENTIONS.get((provider, model_id, spec.mode), PLAIN_MENTIONS)
    variants = tuple((name, replace(v, mentions=mentions)) for name, v in spec.variants)
    return replace(spec, mentions=mentions, variants=variants)


CATALOG = tuple(
    replace(model, offerings=tuple(
        replace(offering, modes=tuple(_with_mentions(spec, offering.provider, model.id) for spec in offering.modes))
        for offering in model.offerings
    ))
    for model in CATALOG
)

# ---------------------------------------------------------------------------
# Out of scope for V1 (listed, not implemented)
# ---------------------------------------------------------------------------

UNSUPPORTED_FEATURES: tuple[dict[str, str], ...] = (
    {"id": "seedance_draft", "label": "Seedance 2.5 draft mode (draft / draft_task_id)"},
    {"id": "seedance_edit_extend", "label": "Seedance 2.5 video edit and extend (omni_reference_task_type)"},
    {"id": "seedance_2_5_flash", "label": "Seedance 2.5 Flash"},
    {"id": "seedance_return_last_frame", "label": "Seedance return_last_frame"},
    {"id": "wan_file_link_to_video", "label": "Wan 3.0 file-to-video and link-to-video"},
    {"id": "web_search", "label": "Seedance web_search"},
    {"id": "gpt_image_gif_svg_mask_markup", "label": "GPT Image GIF / SVG output, mask and markup edits"},
    {"id": "layer_decomposition", "label": "Seedream layer decomposition"},
    {"id": "kling_elements_keyframes", "label": "Kling elements[] and middle keyframes"},
    {"id": "kling_multi_shots", "label": "Kling multi-shot prompts"},
    {"id": "minimax_custom_size", "label": "MiniMax H3 Image custom width / height"},
    {"id": "piapi_seedream_batch", "label": "Seedream sequential (batch) image generation"},
    {"id": "webhooks", "label": "Webhooks and callbacks (status is polled)"},
    {"id": "remote_cancel", "label": "Cancelling a job at the provider"},
)

# ---------------------------------------------------------------------------
# Undocumented or contradictory behaviour
# ---------------------------------------------------------------------------

UNVERIFIED: tuple[Unverified, ...] = (
    Unverified("kie", "seedance-2, seedance-2-fast, seedance-2-mini, seedance-2.5, wan-3.0 (image to video), "
               "wan-3.0-prime (image to video), seedream-5-pro, seedream-5-flash, seedream-5.5, image-upscaler",
               "prompt mention syntax",
               "No way to refer to references in the prompt is documented; the fallback form (Image1, Video1, Audio1) is used."),
    Unverified("piapi", "kling-4.0 (image to video), kling-4.0-flash (image to video), seedream-5-pro, "
               "seedream-5-lite, image-upscaler",
               "prompt mention syntax",
               "No way to refer to references in the prompt is documented; the fallback form (Image1, Video1, Audio1) is used."),
    Unverified("kie", "seedance-2", "aspect_ratio",
               "The schema enum omits 'adaptive' but the enum labels, playground and FAQ list it. 'adaptive' is offered."),
    Unverified("kie", "seedance-2, seedance-2-fast, seedance-2-mini", "max_total_references",
               "Kie documents per-kind limits (9 images, 3 videos, 3 audio) but no total. Capped at 12, the "
               "total PiAPI documents for the same model in two places (a third place says 15)."),
    Unverified("kie", "seedance-2.5", "max_total_references",
               "Kie documents no total; the per-kind sum (50) matches the total PiAPI documents."),
    Unverified("kie", "seedance-2, seedance-2-fast, seedance-2-mini, seedance-2.5", "reference_audio_urls",
               "Kie does not say whether audio-only references are allowed. Rejected to avoid a paid failure "
               "(PiAPI forbids it for Seedance 2; PiAPI allows it for Seedance 2.5)."),
    Unverified("kie", "seedance-2.5", "prompt",
               "The schema does not mark the prompt required (Seedance 2 docs do). Treated as required."),
    Unverified("kie", "seedance-2, seedance-2-fast, seedance-2-mini, seedance-2.5", "real_people",
               "Kie documents no asset-creation API or real-face behaviour. References pass through unchanged; "
               "real-face references may be rejected by the upstream model."),
    Unverified("kie", "seedance-2, seedance-2-fast, seedance-2-mini, seedance-2.5, wan-3.0, seedream-*",
               "nsfw_checker",
               "The API docs say it defaults to false; the playground says it defaults to true. The ledger "
               "default is false and the value is always sent explicitly."),
    Unverified("kie", "seedance-2.5", "omni_reference_task_type",
               "Sent as 'reference' for Omni Reference requests so edit/extend are never inferred. "
               "Not sent for text or frame requests (documented as rejected there)."),
    Unverified("kie", "kling-4.0, kling-4.0-flash", "first_frame_url",
               "Keyframe-to-video does not mark the first frame required. Image to Video requires it; "
               "last-frame-only requests are not offered."),
    Unverified("kie", "kling-4.0", "audio",
               "Kie has no audio field for this model: audio references are sent as the API's `voices` list, "
               "named sound_1, sound_2, ... in order (`audio_N` is a reserved name there). Up to 3 are "
               "documented; their formats, size and duration limits are undocumented, and whether audio alone "
               "(without images or videos) is allowed is undocumented. Audio-only requests are rejected. "
               "Kie's doc says the task fails if no usable voice can be detected, so audio without speech "
               "(music, ambience) may be rejected by the provider; this is untested."),
    Unverified("kie", "kling-4.0, kling-4.0-flash", "image_urls / video_urls",
               "No formats or file-size limits are documented for Kling 4.0 references on Kie."),
    Unverified("kie", "wan-3.0, wan-3.0-prime", "max_total_references",
               "No total reference limit is documented; only per-kind limits are enforced."),
    Unverified("kie", "seedream-5-pro", "quality / aspect_ratio",
               "Both are required with no documented default. The ledger defaults to 'basic' and '1:1' and "
               "always sends them."),
    Unverified("kie", "seedream-5-flash", "output_format",
               "Documented as 'set this field explicitly' with no default. Defaults to 'png' and is always sent."),
    Unverified("kie", "kling-4.0, kling-4.0-flash, gpt-image-2.6, minimax-h3-image, image-upscaler",
               "content filtering",
               "No nsfw_checker or less-restriction control is documented for these models on Kie."),
    Unverified("kie", "*", "failMsg",
               "Kie documents no failure codes for content rejection. A failed task is classified as "
               "content_rejected only when failMsg mentions sensitive content, a content policy or review, "
               "a violation, NSFW, moderation or safety."),
    Unverified("kie", "*", "code 433",
               "Listed in the response code enum with no meaning. Treated as a provider failure."),
    Unverified("kie", "*", "task status",
               "Get Task Details documents five states (waiting, queuing, generating, success, fail) and no "
               "cancelled or expired state. Any other state is treated as an unknown response: the job keeps "
               "polling and fails as malformed_response after several such answers in a row."),
    Unverified("kie", "*", "failMsg credits",
               "Insufficient credits is documented only as response code 402, which is classified as "
               "insufficient_credits. No failCode or failMsg for it on a failed task is documented, so a "
               "failed task is never classified as insufficient_credits."),
    Unverified("piapi", "seedance-2, seedance-2-fast, seedance-2-mini", "mode",
               "The description calls mode optional (inferred); the schema marks it required. Always sent."),
    Unverified("piapi", "seedance-2, seedance-2-fast, seedance-2-mini", "max_total_references",
               "Documented as 1-12 in two places and 1-15 in one. Capped at 12."),
    Unverified("piapi", "seedance-2, seedance-2-fast, seedance-2-mini", "video_urls size",
               "One page says 100 MB per video, another 50 MB. Capped at 50 MB."),
    Unverified("piapi", "seedance-2, seedance-2-fast, seedance-2-mini", "video_urls total duration",
               "One page says 15.4 s total, the material spec says 15 s. Capped at 15 s."),
    Unverified("piapi", "seedance-2, seedance-2-fast, seedance-2-mini, seedance-2.5", "auto_upload_assets",
               "The schema says it defaults to true; the Private Asset guide says false and returns 400 on "
               "strict task types. Never sent on strict task types; always sent explicitly on less-restriction."),
    Unverified("piapi", "seedance-2-mini, seedance-2.5", "real_people",
               "The Private Asset guide lists only seedance-2 and seedance-2-fast less-restriction as "
               "supported for assets. Mini and 2.5 asset support is not confirmed; a warning is returned."),
    Unverified("piapi", "seedance-2.5", "mode",
               "Not in the schema, but every example sends it ('text_to_video' / 'omni_reference'). Sent."),
    Unverified("piapi", "seedance-2.5", "audio / seed",
               "Mentioned only as fields to omit in draft step 2; not in the schema. Not exposed."),
    Unverified("piapi", "seedance-2.5", "image_urls",
               "No formats, size or dimension limits are documented for Seedance 2.5 images."),
    Unverified("piapi", "seedance-2.5", "image_to_video",
               "Image URLs are described as usable for image-to-video, but no first/last frame semantics are "
               "documented. Image to Video is not offered on PiAPI for Seedance 2.5."),
    Unverified("piapi", "seedream-5-pro, seedream-5-lite", "prompt max length",
               "No prompt length limit is documented."),
    Unverified("piapi", "seedream-5-pro, seedream-5-lite", "output_format",
               "The overview lists jpeg/png/webp; the schema lists png/jpeg. Only png and jpeg are offered."),
    Unverified("piapi", "kling-4.0, kling-4.0-flash", "omni audio-only",
               "Whether audio references alone are allowed is undocumented. Rejected."),
    Unverified("piapi", "kling-4.0, kling-4.0-flash", "omni images",
               "No image formats or size limits are documented for omni references."),
    Unverified("piapi", "image-upscaler", "scale / face_enhance",
               "Both appear required with no documented default. Defaults are 2 and false, always sent."),
    Unverified("piapi", "*", "task status",
               "The Get Task pages differ per model (pending, staged, starting, processing, retry, completed, "
               "success, failed). A canceled status is documented only for models not offered here, and the "
               "provider-side cancel is not used. Any other status is treated as an unknown response: the job "
               "keeps polling and fails as malformed_response after several such answers in a row."),
    Unverified("piapi", "*", "account/info response",
               "The response schema is empty; balance fields are read best-effort."),
    Unverified("piapi", "*", "error codes",
               "No HTTP or body error-code table is documented except error.code 10003 (unknown fields) and "
               "the upload 403 (plan). Errors are classified by HTTP status and message keywords."),
)
