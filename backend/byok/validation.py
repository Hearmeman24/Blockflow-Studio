"""Request validation against the capability ledger.

``validate_request`` never mutates, truncates or drops its inputs; it only
reports :class:`Issue` objects.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Callable, Mapping, Sequence
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import urlparse

from backend.byok import catalog
from backend.byok.spec import (
    MEDIA_KINDS,
    MODE_NAMES,
    MODES,
    PROVIDER_NAMES,
    PROVIDERS,
    ROLES,
    SOUND_KINDS,
    Issue,
    MediaLimit,
    ModelEntry,
    ModeSpec,
    Reference,
    canonical_kind,
    canonical_reference,
)

PARAM_KEYS = frozenset({"prompt", "duration", "resolution", "aspect_ratio", "settings"})
_KNOWN_EXTS = frozenset({
    "jpg", "jpeg", "png", "webp", "bmp", "tiff", "tif", "gif", "heic", "heif",
    "mp4", "mov", "mkv", "webm", "m4v",
    "mp3", "wav", "aac", "ogg", "flac", "m4a",
})
_KIND_PLURAL = {"image": "images", "video": "videos", "audio": "audio clips"}


def find_model(model_id: str) -> ModelEntry | None:
    for model in catalog.CATALOG:
        if model.id == model_id:
            return model
    return None


def resolve_variant(spec: ModeSpec, settings: Mapping[str, Any] | None) -> ModeSpec:
    """Return the variant ModeSpec selected by ``settings`` (GPT Image tier)."""
    if not spec.variant_key:
        return spec
    setting = spec.setting(spec.variant_key)
    value = (settings or {}).get(spec.variant_key)
    if value is None and setting is not None:
        value = setting.default
    return spec.variant(value) or spec


def coerce_reference(ref: Reference | Mapping[str, Any]) -> Reference:
    """A Reference with a canonical kind: a legacy ``voice`` is read as audio
    (``spec.canonical_reference``); a ``name`` is ignored."""
    if isinstance(ref, Reference):
        kind = canonical_kind(ref.kind)
        return ref if kind == ref.kind else dataclasses.replace(ref, kind=kind)
    if not isinstance(ref, Mapping):
        raise TypeError("reference must be a Reference or a mapping")
    allowed = {"kind", "url", "role", "duration_s", "size_bytes", "width", "height", "format"}
    return Reference(**{k: v for k, v in canonical_reference(ref).items() if k in allowed})


def reference_format(ref: Reference) -> str | None:
    if ref.format:
        return str(ref.format).lower().lstrip(".")
    if not isinstance(ref.url, str):
        return None
    path = urlparse(ref.url).path if "://" in ref.url else ref.url
    ext = PurePosixPath(path).suffix.lower().lstrip(".")
    return ext if ext in _KNOWN_EXTS else None


class _Ctx:
    def __init__(self, provider: str, model: ModelEntry, spec: ModeSpec) -> None:
        self.provider = provider
        self.model = model
        self.spec = spec
        self.issues: list[Issue] = []

    @property
    def where(self) -> str:
        return f"{self.model.name} on {PROVIDER_NAMES[self.provider]}"

    def error(self, code: str, field: str, message: str, limit: Any = None, actual: Any = None) -> None:
        self.issues.append(Issue(code, "error", field, message, limit, actual))

    def warn(self, code: str, field: str, message: str, limit: Any = None, actual: Any = None) -> None:
        self.issues.append(Issue(code, "warning", field, message, limit, actual))


def validate_request(
    provider: str,
    model_id: str,
    mode: str,
    params: Mapping[str, Any] | None,
    references: Sequence[Reference | Mapping[str, Any]] | None,
) -> list[Issue]:
    if provider not in PROVIDERS:
        return [Issue("unknown_provider", "error", "provider",
                      f"Unknown provider '{provider}'. Choose one of: {', '.join(PROVIDERS)}.", list(PROVIDERS), provider)]
    model = find_model(model_id)
    if model is None:
        return [Issue("unknown_model", "error", "model", f"Unknown model '{model_id}'.", None, model_id)]
    if mode not in MODES:
        return [Issue("unknown_mode", "error", "mode",
                      f"Unknown mode '{mode}'. Choose one of: {', '.join(MODES)}.", list(MODES), mode)]
    offering = model.offering(provider)
    if offering is None or not offering.offered:
        return [Issue("model_not_offered", "error", "provider",
                      f"{model.name} is not offered by {PROVIDER_NAMES[provider]}. Pick another provider.",
                      None, provider)]
    spec = offering.mode(mode)
    if spec is None or not spec.supported:
        reason = spec.unavailable_reason if spec else None
        detail = f" {reason}" if reason else ""
        return [Issue("mode_unsupported", "error", "mode",
                      f"{model.name} on {PROVIDER_NAMES[provider]} does not support {MODE_NAMES[mode]}.{detail}",
                      None, mode)]

    params = params if params is not None else {}
    if not isinstance(params, Mapping):
        return [Issue("invalid_parameter", "error", "params", "Parameters must be an object.")]
    raw_settings = params.get("settings") or {}
    ctx = _Ctx(provider, model, spec)
    if not isinstance(raw_settings, Mapping):
        ctx.error("invalid_parameter", "settings", "Settings must be an object.")
        raw_settings = {}
    for key in params:
        if key not in PARAM_KEYS:
            ctx.error("unknown_parameter", str(key), f"'{key}' is not a recognised parameter.")

    if spec.variant_key:
        ctx.spec = resolve_variant(spec, raw_settings)
    spec = ctx.spec

    try:
        refs = [coerce_reference(r) for r in (references or [])]
    except (TypeError, ValueError) as exc:
        ctx.error("invalid_reference", "references", f"Invalid reference: {exc}")
        refs = []

    _check_prompt(ctx, params.get("prompt"))
    _check_references(ctx, refs)
    _check_choice(ctx, "duration", params.get("duration"))
    _check_choice(ctx, "resolution", params.get("resolution"))
    _check_choice(ctx, "aspect_ratio", params.get("aspect_ratio"))
    _check_settings(ctx, raw_settings)
    for rule in spec.rules:
        _RULES[rule](ctx, params, raw_settings, refs)
    _provider_warnings(ctx, raw_settings)
    return ctx.issues


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------


def _check_prompt(ctx: _Ctx, prompt: Any) -> None:
    rule = ctx.spec.prompt
    if prompt is not None and not isinstance(prompt, str):
        ctx.error("invalid_prompt", "prompt", "The prompt must be text.")
        return
    text = prompt or ""
    empty = not text.strip()
    if rule.requirement == "none":
        if not empty:
            ctx.error("prompt_not_accepted", "prompt", f"{ctx.where} does not take a prompt. Clear the prompt.")
        return
    if empty:
        if rule.requirement == "required":
            ctx.error("prompt_required", "prompt", f"{ctx.where} needs a prompt for {MODE_NAMES[ctx.spec.mode]}.")
        return
    length = len(text)
    if rule.max_length is not None and length > rule.max_length:
        ctx.error("prompt_too_long", "prompt",
                  f"The prompt is {length} characters; {ctx.where} accepts at most {rule.max_length}. "
                  f"Shorten it by {length - rule.max_length}.", rule.max_length, length)
    if rule.min_length is not None and length < rule.min_length:
        ctx.error("prompt_too_short", "prompt",
                  f"The prompt must be at least {rule.min_length} characters for {ctx.where}.",
                  rule.min_length, length)


# ---------------------------------------------------------------------------
# References
# ---------------------------------------------------------------------------


def _check_references(ctx: _Ctx, refs: list[Reference]) -> None:
    spec = ctx.spec
    by_kind: dict[str, list[tuple[int, Reference]]] = {}
    for i, ref in enumerate(refs):
        field = f"references[{i}]"
        if ref.kind not in MEDIA_KINDS:
            ctx.error("unknown_media_kind", f"{field}.kind",
                      f"Unknown media kind '{ref.kind}'. Use one of: {', '.join(MEDIA_KINDS)}.")
            continue
        if not isinstance(ref.url, str) or not ref.url.strip():
            ctx.error("reference_url_missing", f"{field}.url", "This reference has no file or URL.")
        if ref.role not in ROLES:
            ctx.error("invalid_reference_role", f"{field}.role", f"Unknown reference role '{ref.role}'.")
        by_kind.setdefault(ref.kind, []).append((i, ref))

    for kind, items in by_kind.items():
        limit = spec.media_limit(kind)
        if limit is None:
            ctx.error("media_kind_not_accepted", f"references.{kind}",
                      f"{ctx.where} does not accept {_KIND_PLURAL[kind]} in {MODE_NAMES[spec.mode]}. "
                      f"Remove {len(items)} {_KIND_PLURAL[kind]}.", 0, len(items))
            continue
        if len(items) > limit.max_count:
            ctx.error("too_many_references", f"references.{kind}",
                      f"{ctx.where} accepts at most {limit.max_count} {_KIND_PLURAL[kind]}; "
                      f"remove {len(items) - limit.max_count}.", limit.max_count, len(items))
        _check_items(ctx, kind, limit, items)

    for limit in spec.media:
        count = len(by_kind.get(limit.kind, []))
        if count < limit.min_count:
            ctx.error("too_few_references", f"references.{limit.kind}",
                      f"{ctx.where} needs at least {limit.min_count} {_KIND_PLURAL[limit.kind]}.",
                      limit.min_count, count)

    known = [r for r in refs if r.kind in MEDIA_KINDS]
    total = len(known)
    if spec.max_total_references is not None and total > spec.max_total_references:
        ctx.error("too_many_total_references", "references",
                  f"{ctx.where} accepts at most {spec.max_total_references} references in total; "
                  f"remove {total - spec.max_total_references}.", spec.max_total_references, total)
    if spec.frames is None and total < spec.min_total_references:
        ctx.error("too_few_references", "references",
                  f"{MODE_NAMES[spec.mode]} needs at least {spec.min_total_references} reference.",
                  spec.min_total_references, total)
    kinds = {r.kind for r in known}
    if len(kinds) > 1 and not spec.mixed_media_allowed:
        ctx.error("mixed_media_not_allowed", "references",
                  f"{ctx.where} cannot mix {', '.join(sorted(kinds))} in {MODE_NAMES[spec.mode]}.",
                  None, sorted(kinds))
    if kinds and kinds <= SOUND_KINDS and not spec.audio_only_allowed and spec.media:
        ctx.error("audio_only_not_allowed", "references",
                  f"{ctx.where} needs at least one image or video alongside audio references.")

    if spec.frames is not None:
        _check_frames(ctx, known)
    else:
        for i, ref in enumerate(refs):
            if ref.role in ROLES and ref.role != "reference":
                ctx.error("invalid_reference_role", f"references[{i}].role",
                          f"{MODE_NAMES[spec.mode]} does not use a {ref.role.replace('_', ' ')}; "
                          "mark it as a reference or switch to Image to Video.")


def _check_frames(ctx: _Ctx, refs: list[Reference]) -> None:
    frames = ctx.spec.frames
    firsts = [r for r in refs if r.role == "first_frame"]
    lasts = [r for r in refs if r.role == "last_frame"]
    if any(r.role == "reference" for r in refs):
        ctx.error("invalid_reference_role", "references",
                  "Image to Video only takes a first frame and an optional last frame. "
                  "Use Omni Reference to Video for other references.")
    if frames.first_frame_required and not firsts:
        ctx.error("first_frame_required", "references.first_frame", "Add a first frame image.", 1, 0)
    if len(firsts) > 1:
        ctx.error("duplicate_frame", "references.first_frame", "Only one first frame is allowed.", 1, len(firsts))
    if lasts and not frames.last_frame_allowed:
        ctx.error("last_frame_not_supported", "references.last_frame",
                  f"{ctx.where} does not support a last frame. Remove it.", 0, len(lasts))
    elif len(lasts) > 1:
        ctx.error("duplicate_frame", "references.last_frame", "Only one last frame is allowed.", 1, len(lasts))
    if lasts and not firsts:
        ctx.error("first_frame_required", "references.first_frame", "A last frame needs a first frame.", 1, 0)


def _check_items(ctx: _Ctx, kind: str, limit: MediaLimit, items: list[tuple[int, Reference]]) -> None:
    durations: list[float] = []
    all_known = True
    for i, ref in items:
        field = f"references[{i}]"
        fmt = reference_format(ref)
        if limit.formats and fmt and fmt not in limit.formats:
            ctx.error("invalid_format", f"{field}.format",
                      f"{ctx.where} does not accept .{fmt} {_KIND_PLURAL[kind]}. "
                      f"Use {', '.join(limit.formats)}.", list(limit.formats), fmt)
        if limit.max_size_bytes is not None and ref.size_bytes is not None and ref.size_bytes > limit.max_size_bytes:
            ctx.error("file_too_large", f"{field}.size_bytes",
                      f"This file is {_mb(ref.size_bytes)}; {ctx.where} accepts at most "
                      f"{_mb(limit.max_size_bytes)} per file.", limit.max_size_bytes, ref.size_bytes)
        if ref.duration_s is None:
            all_known = False
        else:
            durations.append(float(ref.duration_s))
            if limit.min_duration_s is not None and ref.duration_s < limit.min_duration_s:
                ctx.error("reference_duration_out_of_range", f"{field}.duration_s",
                          f"Each reference must be at least {limit.min_duration_s:g} s long.",
                          limit.min_duration_s, ref.duration_s)
            if limit.max_duration_s is not None and ref.duration_s > limit.max_duration_s:
                ctx.error("reference_duration_out_of_range", f"{field}.duration_s",
                          f"Each reference can be at most {limit.max_duration_s:g} s long. Trim it.",
                          limit.max_duration_s, ref.duration_s)
        _check_dimensions(ctx, field, limit, ref)
    total = sum(durations)
    if limit.max_total_duration_s is not None and total > limit.max_total_duration_s:
        ctx.error("total_duration_exceeded", f"references.{kind}",
                  f"All {_KIND_PLURAL[kind]} together are {total:g} s; {ctx.where} accepts at most "
                  f"{limit.max_total_duration_s:g} s in total.", limit.max_total_duration_s, total)
    if limit.min_total_duration_s is not None and all_known and durations and total < limit.min_total_duration_s:
        ctx.error("total_duration_too_short", f"references.{kind}",
                  f"All {_KIND_PLURAL[kind]} together must be at least {limit.min_total_duration_s:g} s.",
                  limit.min_total_duration_s, total)


def _check_dimensions(ctx: _Ctx, field: str, limit: MediaLimit, ref: Reference) -> None:
    if ref.width is None or ref.height is None:
        return
    w, h = int(ref.width), int(ref.height)
    if limit.min_side_px is not None and min(w, h) < limit.min_side_px:
        ctx.error("dimension_out_of_range", f"{field}.width",
                  f"Each side must be at least {limit.min_side_px} px (this is {w}x{h}).",
                  limit.min_side_px, min(w, h))
    if limit.max_side_px is not None and max(w, h) > limit.max_side_px:
        ctx.error("dimension_out_of_range", f"{field}.width",
                  f"Each side must be at most {limit.max_side_px} px (this is {w}x{h}).",
                  limit.max_side_px, max(w, h))
    if h > 0:
        ratio = w / h
        if (limit.min_aspect is not None and ratio < limit.min_aspect) or (
            limit.max_aspect is not None and ratio > limit.max_aspect
        ):
            ctx.error("aspect_out_of_range", f"{field}.width",
                      f"Width / height must be between {limit.min_aspect:g} and {limit.max_aspect:g} "
                      f"(this is {ratio:.2f}).", [limit.min_aspect, limit.max_aspect], round(ratio, 4))


def _mb(n: int) -> str:
    return f"{n / 1_000_000:.1f} MB"


# ---------------------------------------------------------------------------
# Duration / resolution / aspect ratio
# ---------------------------------------------------------------------------


def _check_choice(ctx: _Ctx, key: str, value: Any) -> None:
    if value is None:
        return
    spec = ctx.spec
    label = key.replace("_", " ")
    if key == "duration":
        d = spec.duration
        if d is None:
            ctx.error("unknown_parameter", key, f"{ctx.where} does not take a duration in {MODE_NAMES[spec.mode]}.")
            return
        valid = isinstance(value, int) and not isinstance(value, bool) and (
            d.min_s <= value <= d.max_s or (d.auto_value is not None and value == d.auto_value))
        if not valid:
            auto = f", or {d.auto_value} for automatic" if d.auto_value is not None else ""
            ctx.error("invalid_duration", key,
                      f"Duration must be a whole number of seconds from {d.min_s} to {d.max_s}{auto}.",
                      [d.min_s, d.max_s], value)
        return
    choice = spec.resolutions if key == "resolution" else spec.aspect_ratios
    if choice is None:
        ctx.error("unknown_parameter", key, f"{ctx.where} does not take a {label} in {MODE_NAMES[spec.mode]}.")
        return
    if value not in choice.values:
        ctx.error(f"invalid_{key}", key,
                  f"{ctx.where} does not support {label} '{value}'. Choose one of: {', '.join(choice.values)}.",
                  list(choice.values), value)


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


def _check_settings(ctx: _Ctx, settings: Mapping[str, Any]) -> None:
    for key, value in settings.items():
        spec = ctx.spec.setting(key)
        if spec is None:
            ctx.error("unknown_setting", f"settings.{key}", f"{ctx.where} has no setting '{key}'.")
            continue
        if value is None:
            continue
        field = f"settings.{key}"
        if spec.type == "bool":
            if not isinstance(value, bool):
                ctx.error("invalid_setting", field, f"{spec.label} must be on or off.", None, value)
        elif spec.type == "int":
            if not isinstance(value, int) or isinstance(value, bool):
                ctx.error("invalid_setting", field, f"{spec.label} must be a whole number.", None, value)
            elif not (spec.minimum <= value <= spec.maximum):
                ctx.error("invalid_setting", field,
                          f"{spec.label} must be between {spec.minimum} and {spec.maximum}.",
                          [spec.minimum, spec.maximum], value)
        elif value not in spec.choices or isinstance(value, bool):
            ctx.error("invalid_setting", field,
                      f"{spec.label} must be one of: {', '.join(str(c) for c in spec.choices)}.",
                      list(spec.choices), value)


def effective_setting(spec: ModeSpec, settings: Mapping[str, Any], key: str) -> Any:
    value = settings.get(key)
    if value is None:
        setting = spec.setting(key)
        return setting.default if setting else None
    return value


# ---------------------------------------------------------------------------
# Cross-field rules
# ---------------------------------------------------------------------------

Rule = Callable[[_Ctx, Mapping[str, Any], Mapping[str, Any], list[Reference]], None]


def _rule_keep_sound_needs_video(ctx, params, settings, refs) -> None:
    if settings.get("keep_original_sound") is True and not any(r.kind == "video" for r in refs):
        ctx.error("setting_conflict", "settings.keep_original_sound",
                  "Keeping the original sound needs at least one reference video.")


def _rule_keep_audio(ctx, params, settings, refs) -> None:
    if settings.get("keep_original_audio") is not True:
        return
    if not any(r.kind == "video" for r in refs):
        ctx.error("setting_conflict", "settings.keep_original_audio",
                  "Keeping the original audio needs at least one reference video.")
    if effective_setting(ctx.spec, settings, "enable_audio") is not False:
        ctx.error("setting_conflict", "settings.keep_original_audio",
                  "Turn off audio generation to keep the reference video's original audio.")


def _rule_wan_video_plus_output(ctx, params, settings, refs) -> None:
    durations = [r.duration_s for r in refs if r.kind == "video" and r.duration_s is not None]
    if not durations:
        return
    duration = params.get("duration")
    if duration is None:
        duration = ctx.spec.duration.default
    if not isinstance(duration, int) or isinstance(duration, bool) or duration == ctx.spec.duration.auto_value:
        return
    total = sum(durations) + duration
    if total > 30:
        ctx.error("total_duration_exceeded", "duration",
                  f"Reference video length plus output duration is {total:g} s; {ctx.where} allows at most 30 s.",
                  30, total)


def _format_rule(allowed: tuple[str, ...], setting: str, value: Any, message: str) -> Rule:
    def rule(ctx, params, settings, refs) -> None:
        current = settings.get(setting)
        if setting == "output_compression":
            triggered = current is not None
        else:
            triggered = current == value
        if triggered and effective_setting(ctx.spec, settings, "output_format") not in allowed:
            ctx.error("setting_conflict", f"settings.{setting}", message)

    return rule


_RULES: dict[str, Rule] = {
    "keep_sound_needs_video": _rule_keep_sound_needs_video,
    "keep_audio_needs_video_and_no_audio": _rule_keep_audio,
    "wan_video_plus_output": _rule_wan_video_plus_output,
    "transparent_needs_png": _format_rule(("png",), "background", "transparent",
                                          "A transparent background needs PNG output."),
    "transparent_needs_png_or_webp": _format_rule(("png", "webp"), "background", "transparent",
                                                  "A transparent background needs PNG or WebP output."),
    "compression_needs_jpeg_or_webp": _format_rule(("jpeg", "webp"), "output_compression", None,
                                                   "Compression only applies to JPEG or WebP output."),
}


def _provider_warnings(ctx: _Ctx, settings: Mapping[str, Any]) -> None:
    if (ctx.provider == "piapi" and settings.get("real_people") is True
            and ctx.model.id in {"seedance-2-mini", "seedance-2.5"}):
        ctx.warn("unverified_behaviour", "settings.real_people",
                 f"PiAPI does not confirm Private Asset support for {ctx.model.name}; "
                 "real-person references may still be rejected.")
