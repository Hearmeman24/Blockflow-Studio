"""Capability ledger: the single source of truth for providers, models and modes.

Public API:

- ``CATALOG``, ``UNVERIFIED``, ``UNSUPPORTED_FEATURES``
- ``get_model(model_id)`` / ``find_model(model_id)``
- ``get_mode_spec(provider, model_id, mode, settings=None)``
- ``effective_params(spec, params)``
- ``validate_request(provider, model_id, mode, params, references)``
- ``catalog_payload(configured_providers)``
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from backend.byok.catalog import CATALOG, UNSUPPORTED_FEATURES, UNVERIFIED
from backend.byok.spec import (
    MEDIA_KINDS,
    MODE_NAMES,
    MODES,
    PROVIDER_NAMES,
    PROVIDERS,
    Issue,
    ModelEntry,
    ModeSpec,
    Reference,
    to_jsonable,
)
from backend.byok.validation import (
    coerce_reference,
    effective_setting,
    find_model,
    resolve_variant,
    validate_request,
)


def get_model(model_id: str) -> ModelEntry:
    model = find_model(model_id)
    if model is None:
        raise KeyError(model_id)
    return model


def get_mode_spec(provider: str, model_id: str, mode: str,
                  settings: Mapping[str, Any] | None = None) -> ModeSpec | None:
    """The ModeSpec for one provider/model/mode, or None. With ``settings``,
    variant selection (GPT Image tier) is applied."""
    model = find_model(model_id)
    if model is None:
        return None
    offering = model.offering(provider)
    if offering is None or not offering.offered:
        return None
    spec = offering.mode(mode)
    if spec is None:
        return None
    return resolve_variant(spec, settings) if settings is not None else spec


def effective_params(spec: ModeSpec, params: Mapping[str, Any]) -> dict[str, Any]:
    """Fill documented defaults into validated params. ``None`` means omit."""
    settings = params.get("settings") or {}
    duration = params.get("duration")
    if duration is None and spec.duration is not None:
        duration = spec.duration.default
    resolution = params.get("resolution")
    if resolution is None and spec.resolutions is not None:
        resolution = spec.resolutions.default
    aspect = params.get("aspect_ratio")
    if aspect is None and spec.aspect_ratios is not None:
        aspect = spec.aspect_ratios.default
    resolved = {s.key: effective_setting(spec, settings, s.key) for s in spec.settings}
    prompt = params.get("prompt")
    return {
        "prompt": prompt if isinstance(prompt, str) and prompt.strip() else None,
        "duration": duration,
        "resolution": resolution,
        "aspect_ratio": aspect,
        "settings": resolved,
    }


def _provider_status(model: ModelEntry, provider: str, configured: set[str]) -> dict[str, Any]:
    offering = model.offering(provider)
    name = PROVIDER_NAMES[provider]
    offered = bool(offering and offering.offered)
    is_configured = provider in configured
    if not offered:
        reason = offering.reason if offering and offering.reason else f"Not offered by {name}"
    elif not is_configured:
        reason = f"Requires a {name} API key"
    else:
        reason = None
    modes: dict[str, Any] = {}
    for spec in offering.modes if offered else ():
        entry = to_jsonable(spec)
        entry["available"] = spec.supported and is_configured
        entry["unavailable_reason"] = spec.unavailable_reason if not spec.supported else reason
        modes[spec.mode] = entry
    return {
        "offered": offered,
        "configured": is_configured,
        "available": offered and is_configured,
        "unavailable_reason": reason,
        "modes": modes,
    }


def catalog_payload(configured_providers: set[str]) -> dict[str, Any]:
    """JSON-ready catalog for ``GET /api/providers/catalog``."""
    configured = {p for p in configured_providers if p in PROVIDERS}
    models = []
    for model in CATALOG:
        providers = {p: _provider_status(model, p, configured) for p in PROVIDERS}
        models.append({
            "id": model.id,
            "name": model.name,
            "output": model.output,
            "nsfw": model.nsfw,
            "description": model.description,
            "available": any(p["available"] for p in providers.values()),
            "providers": providers,
        })
    return {
        "providers": {p: {"id": p, "name": PROVIDER_NAMES[p], "configured": p in configured} for p in PROVIDERS},
        "modes": [{"id": m, "name": MODE_NAMES[m]} for m in MODES],
        "media_kinds": list(MEDIA_KINDS),
        "models": models,
        "unsupported_features": [dict(f) for f in UNSUPPORTED_FEATURES],
        "unverified": [to_jsonable(u) for u in UNVERIFIED],
    }


__all__ = [
    "CATALOG",
    "UNSUPPORTED_FEATURES",
    "UNVERIFIED",
    "Issue",
    "Reference",
    "catalog_payload",
    "coerce_reference",
    "effective_params",
    "find_model",
    "get_mode_spec",
    "get_model",
    "validate_request",
]
