"""Data types for the capability ledger.

Every type here is a frozen dataclass so the catalog cannot be mutated at
runtime, and every field is JSON-serialisable through :func:`to_jsonable`.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

PROVIDERS: tuple[str, ...] = ("kie", "piapi")
PROVIDER_NAMES: dict[str, str] = {"kie": "Kie", "piapi": "PiAPI"}

MODES: tuple[str, ...] = (
    "text_to_video",
    "image_to_video",
    "omni_reference_to_video",
    "text_to_image",
    "image_to_image",
)
MODE_NAMES: dict[str, str] = {
    "text_to_video": "Text to Video",
    "image_to_video": "Image to Video",
    "omni_reference_to_video": "Omni Reference to Video",
    "text_to_image": "Text to Image",
    "image_to_image": "Image to Image",
}
VIDEO_MODES = ("text_to_video", "image_to_video", "omni_reference_to_video")
IMAGE_MODES = ("text_to_image", "image_to_image")

# Sound is one kind, ``audio``, on every model: it is sent to the model as
# audio and the prompt says what to do with it (speech, music, ambience).
MEDIA_KINDS: tuple[str, ...] = ("image", "video", "audio")
SOUND_KINDS = frozenset({"audio"})
# Old saved flows and MCP clients may still send ``kind: "voice"``; it is read
# as audio wherever a request is parsed (``canonical_reference``).
LEGACY_KIND_ALIASES: dict[str, str] = {"voice": "audio"}

ROLES: tuple[str, ...] = ("first_frame", "last_frame", "reference")

PromptRequirement = Literal["required", "optional", "none"]
SettingType = Literal["bool", "int", "enum"]

MB = 1_000_000
MIB = 1024 * 1024


@dataclass(frozen=True)
class ProviderModelId:
    """How the provider names this model for one mode.

    Kie uses only ``model``. PiAPI uses ``model`` + ``task_type`` and, for
    Kling, ``version``.
    """

    model: str
    task_type: str | None = None
    version: str | None = None


@dataclass(frozen=True)
class PromptSpec:
    requirement: PromptRequirement
    max_length: int | None = None
    min_length: int | None = None


@dataclass(frozen=True)
class MediaLimit:
    """Limits for one media kind in one mode. ``None`` means undocumented."""

    kind: str
    max_count: int
    min_count: int = 0
    formats: tuple[str, ...] = ()
    max_size_bytes: int | None = None
    min_duration_s: float | None = None
    max_duration_s: float | None = None
    max_total_duration_s: float | None = None
    min_total_duration_s: float | None = None
    min_side_px: int | None = None
    max_side_px: int | None = None
    min_aspect: float | None = None
    max_aspect: float | None = None


@dataclass(frozen=True)
class FrameSpec:
    """Frame roles for image-to-video."""

    first_frame_required: bool = True
    last_frame_allowed: bool = False


@dataclass(frozen=True)
class ChoiceSpec:
    """An enumerated parameter. ``default=None`` means the field is omitted
    from the provider request unless the user sets it."""

    values: tuple[str, ...]
    default: str | None


@dataclass(frozen=True)
class DurationSpec:
    """Output duration in whole seconds. ``auto_value`` is a provider sentinel
    (Kie uses ``-1``) that lets the model choose the duration."""

    min_s: int
    max_s: int
    default: int
    auto_value: int | None = None


@dataclass(frozen=True)
class SettingSpec:
    key: str
    type: SettingType
    label: str
    default: Any = None
    choices: tuple[Any, ...] = ()
    minimum: int | None = None
    maximum: int | None = None
    description: str = ""
    # ``content`` marks provider content-moderation controls (nsfw_checker,
    # less_restriction, real_people). They are always explicit settings.
    category: Literal["general", "content", "variant"] = "general"


@dataclass(frozen=True)
class MentionSpec:
    """How the prompt refers to each reference, as the provider documents it.

    Templates use ``{n}`` for the 1-based position within the media kind.
    ``first_frame`` / ``last_frame`` are set
    only where the model names frames by role. ``documented=False`` means no
    syntax is documented and the fallback form ("Image1") is used.
    """

    image: str = "Image{n}"
    video: str = "Video{n}"
    audio: str = "Audio{n}"
    first_frame: str | None = None
    last_frame: str | None = None
    documented: bool = False


@dataclass(frozen=True)
class ModeSpec:
    mode: str
    supported: bool
    ids: ProviderModelId | None = None
    prompt: PromptSpec = PromptSpec("required")
    media: tuple[MediaLimit, ...] = ()
    frames: FrameSpec | None = None
    max_total_references: int | None = None
    min_total_references: int = 0
    mixed_media_allowed: bool = True
    audio_only_allowed: bool = False
    duration: DurationSpec | None = None
    resolutions: ChoiceSpec | None = None
    aspect_ratios: ChoiceSpec | None = None
    settings: tuple[SettingSpec, ...] = ()
    # Names of cross-field rules implemented in ``validation.py``.
    rules: tuple[str, ...] = ()
    # Variant setting key -> {value: ModeSpec}. Used by GPT Image 2.6 tiers,
    # where the tier picks a different Kie model with different options.
    variant_key: str | None = None
    variants: tuple[tuple[str, ModeSpec], ...] = ()
    unavailable_reason: str | None = None
    notes: tuple[str, ...] = ()
    # Prompt mention syntax; set for modes that take references.
    mentions: MentionSpec | None = None

    def media_limit(self, kind: str) -> MediaLimit | None:
        for limit in self.media:
            if limit.kind == kind:
                return limit
        return None

    def setting(self, key: str) -> SettingSpec | None:
        for spec in self.settings:
            if spec.key == key:
                return spec
        return None

    def variant(self, value: str) -> ModeSpec | None:
        for name, spec in self.variants:
            if name == value:
                return spec
        return None


@dataclass(frozen=True)
class ProviderOffering:
    provider: str
    offered: bool
    modes: tuple[ModeSpec, ...] = ()
    reason: str | None = None

    def mode(self, mode: str) -> ModeSpec | None:
        for spec in self.modes:
            if spec.mode == mode:
                return spec
        return None


@dataclass(frozen=True)
class ModelEntry:
    id: str
    name: str
    output: Literal["video", "image"]
    nsfw: bool
    offerings: tuple[ProviderOffering, ...]
    description: str = ""

    def offering(self, provider: str) -> ProviderOffering | None:
        for offering in self.offerings:
            if offering.provider == provider:
                return offering
        return None


@dataclass(frozen=True)
class Unverified:
    provider: str
    model: str
    field: str
    detail: str


@dataclass(frozen=True)
class Reference:
    """One media input. ``url`` may be public http(s), ``asset://``, or a local
    path before media preparation. Optional metadata enables extra checks."""

    kind: str
    url: str
    role: str = "reference"
    duration_s: float | None = None
    size_bytes: int | None = None
    width: int | None = None
    height: int | None = None
    format: str | None = None


@dataclass(frozen=True)
class Issue:
    code: str
    severity: Literal["error", "warning"]
    field: str
    message: str
    limit: Any = None
    actual: Any = None


def canonical_kind(kind: Any) -> Any:
    """``kind`` with a legacy alias (``voice``) replaced by its kind (``audio``)."""
    return LEGACY_KIND_ALIASES.get(kind, kind) if isinstance(kind, str) else kind


def canonical_reference(raw: Any) -> Any:
    """A request reference with its kind made canonical. A legacy ``voice``
    becomes ``audio`` and loses its ``name`` (a voice's speaker name, never
    sent any more). Anything that is not a mapping is returned unchanged."""
    if not isinstance(raw, Mapping):
        return raw
    out = {k: v for k, v in raw.items() if k != "name"}
    if "kind" in out:
        out["kind"] = canonical_kind(out["kind"])
    return out


def to_jsonable(value: Any) -> Any:
    """Convert ledger dataclasses (and nested tuples) into plain JSON data."""
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {f.name: to_jsonable(getattr(value, f.name)) for f in dataclasses.fields(value)}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): to_jsonable(v) for k, v in value.items()}
    return value


__all__ = [
    "IMAGE_MODES",
    "LEGACY_KIND_ALIASES",
    "MB",
    "MEDIA_KINDS",
    "MIB",
    "MODES",
    "MODE_NAMES",
    "PROVIDERS",
    "PROVIDER_NAMES",
    "ROLES",
    "SOUND_KINDS",
    "VIDEO_MODES",
    "canonical_kind",
    "canonical_reference",
    "ChoiceSpec",
    "DurationSpec",
    "FrameSpec",
    "Issue",
    "MediaLimit",
    "ModeSpec",
    "ModelEntry",
    "PromptSpec",
    "ProviderModelId",
    "ProviderOffering",
    "Reference",
    "SettingSpec",
    "Unverified",
    "to_jsonable",
]
