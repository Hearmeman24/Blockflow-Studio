"""Tool group: the model catalog (GET /api/providers/catalog). Read-only."""

from typing import Any

from blockflow_mcp.client import ToolFailure, get_client, tool

# Mode-spec fields that are provider-internal and not useful to a caller.
_INTERNAL_SPEC_FIELDS = ("ids", "supported", "mode")


def _catalog() -> dict[str, Any]:
    status, body = get_client().get("/api/providers/catalog")
    if status >= 400 or not isinstance(body, dict) or "models" not in body:
        raise ToolFailure("backend", f"The model catalog could not be read (HTTP {status}).")
    return body


def _check_choice(value: str, allowed: list[str], what: str) -> None:
    if value and value not in allowed:
        raise ToolFailure(f"unknown_{what}", f"Unknown {what} {value!r}. Available: {', '.join(allowed)}.",
                          available=allowed)


@tool(read_only=True)
def list_models(mode: str = "", provider: str = "") -> dict[str, Any]:
    """List the image and video models BlockFlow offers, with where each one can run.

    Each model has: `id`, `name`, `kind` (image | video output), `nsfw`
    (true when the model allows adult content), `fast` (true when the provider
    lists it as the faster variant of a model), `modes` it supports, and per
    provider (`kie`, `piapi`) whether it is `available` now and, if not, the
    `reason` (usually: no API key saved for that provider in Settings).

    Filter with `mode` (text_to_image, image_to_image, text_to_video,
    image_to_video, omni_reference_to_video) and/or `provider` (kie, piapi).
    These five modes are the only ones that exist. Next step: `get_model` for
    the full settings of one model, provider and mode."""
    catalog = _catalog()
    modes = [m["id"] for m in catalog.get("modes", [])]
    providers = catalog.get("providers", {})
    _check_choice(mode, modes, "mode")
    _check_choice(provider, list(providers), "provider")
    models = []
    for m in catalog["models"]:
        per_provider: dict[str, Any] = {}
        for pid, entry in (m.get("providers") or {}).items():
            if provider and pid != provider:
                continue
            supported = [k for k, spec in (entry.get("modes") or {}).items() if spec.get("supported")]
            if not entry.get("offered", True) or not supported:
                continue
            if mode and mode not in supported:
                continue
            available = bool(entry.get("available"))
            reason = entry.get("unavailable_reason")
            if mode:
                spec = entry["modes"][mode]
                available = available and bool(spec.get("available", True))
                reason = reason or spec.get("unavailable_reason")
            per_provider[pid] = {"available": available, "reason": None if available else reason,
                                 "modes": supported}
        if not per_provider:
            continue
        models.append({
            "id": m["id"], "name": m.get("name", m["id"]), "kind": m.get("output"), "nsfw": bool(m.get("nsfw")),
            "fast": bool(m.get("fast")),
            "modes": sorted({k for p in per_provider.values() for k in p["modes"]}, key=modes.index),
            "providers": per_provider,
        })
    return {
        "ok": True,
        "modes": catalog.get("modes", []),
        "providers": {pid: {"name": p.get("name", pid), "key_saved": bool(p.get("configured"))}
                      for pid, p in providers.items()},
        "models": models,
        "count": len(models),
    }


@tool(read_only=True)
def get_model(model: str, provider: str, mode: str) -> dict[str, Any]:
    """The full spec for one model on one provider in one mode: everything
    `estimate_cost` / `generate` accept.

    Returns `prompt` (required | optional | none, with length limits),
    `references` (accepted kinds, each with min/max count, formats, size,
    duration and pixel limits), `frames` (Image to Video: first frame required,
    last frame allowed), `duration` (seconds: min, max, default), `resolutions`
    and `aspect_ratios` (values and default), `settings` (key, type, default,
    choices, range, description), `rules`, `notes`, and `mentions`: how the
    prompt refers to references, e.g. `@image1` or `Image1` ({n} is the
    1-based position among references of that kind, so the second audio clip
    of Kling 4.0 on Kie is `@sound_2`). `available` / `unavailable_reason` say whether it can run now."""
    catalog = _catalog()
    entry = next((m for m in catalog["models"] if m.get("id") == model), None)
    if entry is None:
        raise ToolFailure("unknown_model", f"Unknown model {model!r}. Use list_models to see the ids.",
                          available=[m["id"] for m in catalog["models"]])
    offered = entry.get("providers") or {}
    if provider not in offered:
        raise ToolFailure("unknown_provider", f"{entry.get('name', model)} is not offered by {provider!r}.",
                          available=list(offered))
    spec = (offered[provider].get("modes") or {}).get(mode)
    if not spec or not spec.get("supported"):
        supported = [k for k, s in (offered[provider].get("modes") or {}).items() if s.get("supported")]
        raise ToolFailure("unsupported_mode", f"{entry.get('name', model)} on {provider} does not support {mode!r}.",
                          available=supported)
    available = bool(offered[provider].get("available")) and bool(spec.get("available", True))
    details = {k: v for k, v in spec.items() if k not in _INTERNAL_SPEC_FIELDS and k not in ("media", "available")}
    return {
        "ok": True,
        "model": {"id": entry["id"], "name": entry.get("name"), "kind": entry.get("output"),
                  "nsfw": bool(entry.get("nsfw")), "fast": bool(entry.get("fast")),
                  "description": entry.get("description") or ""},
        "provider": provider,
        "mode": mode,
        "available": available,
        "unavailable_reason": None if available else (offered[provider].get("unavailable_reason")
                                                      or spec.get("unavailable_reason")),
        "references": spec.get("media") or [],
        **details,
        "reference_input": ("Pass references to estimate_cost / generate as {kind, path | url, role?, name?}: "
                            "an absolute file path on this computer, an /outputs/... app path, or a public "
                            "http(s) URL."),
    }


TOOLS = [list_models, get_model]
