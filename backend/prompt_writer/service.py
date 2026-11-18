"""Prompt Writer service: provider status, generation, OpenRouter key check.

Availability:
  - OpenRouter is available when an ``openrouter_api_key`` is saved. Its model
    list is fetched on the first check and cached; a failed fetch keeps the
    provider available and the block falls back to a typed model ID.
  - Ollama and LM Studio are probed on every check (``PROBE_TIMEOUT_S`` each,
    in parallel) and are available only when they answer with at least one
    model. Probes never raise.

Model capabilities (``ModelInfo.accepts``: images, video, audio besides text):
  - OpenRouter: from each model's input modalities, cached with the list.
  - Ollama: ``POST /api/show`` per model, at most ``CAPABILITY_WORKERS`` at a
    time, each within ``OLLAMA_SHOW_TIMEOUT_S`` and all within the probe's own
    ``PROBE_TIMEOUT_S`` budget. Answers are cached (``MODEL_CACHE_TTL_S``,
    cleared by Re-check); a failed or late lookup means text-only for this
    check and is asked again next time.
  - LM Studio: one ``GET /api/v1/models`` in the same budget; text-only when it
    fails.
  - Local models never take video or audio.

Media (``media`` in the generate request): references to files in the
BlockFlow output folder, resolved with the same sandboxed resolver as the
generation service, at most ``MAX_MEDIA_FILES`` files and
``MAX_MEDIA_TOTAL_BYTES`` together. A kind the provider or a known model cannot
take is refused before anything is read or sent.

Nothing here logs a key, a prompt, a file's contents or a provider response body.
"""
from __future__ import annotations

import logging
import math
import re
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from concurrent.futures import wait as wait_futures
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from backend.byok import references
from backend.prompt_writer import base_urls
from backend.prompt_writer.providers import (
    LOCAL_MEDIA_KINDS,
    MEDIA_KINDS,
    ChatProvider,
    ChatRequest,
    LLMError,
    LMStudioProvider,
    MediaPart,
    ModelInfo,
    OllamaProvider,
    OpenRouterProvider,
    redact,
)
from backend.prompt_writer.transport import Transport, UrllibTransport

log = logging.getLogger(__name__)

OPENROUTER_CREDENTIAL = "openrouter_api_key"
PROVIDER_ORDER: tuple[str, ...] = ("openrouter", "ollama", "lmstudio")
LABELS = {"openrouter": "OpenRouter", "ollama": "Ollama", "lmstudio": "LM Studio"}
KINDS = {"openrouter": "hosted", "ollama": "local", "lmstudio": "local"}

PROBE_TIMEOUT_S = 1.5
LOCAL_DEADLINE_S = PROBE_TIMEOUT_S + 0.5
OPENROUTER_MODELS_TIMEOUT_S = 4.0
OPENROUTER_DEADLINE_S = OPENROUTER_MODELS_TIMEOUT_S + 0.5
MODEL_CACHE_TTL_S = 600.0
# Ollama capability lookups (POST /api/show), inside the probe's budget.
OLLAMA_SHOW_TIMEOUT_S = 1.0
CAPABILITY_WORKERS = 4
# How long one generation may take. Local models are slower (and get no
# max-tokens cap from us), so they wait longer. The frontend proxy waits
# longer than both (PROXY_TIMEOUT_S in frontend/next.config.ts, checked by
# tests/test_proxy_timeout.py), so the block always gets this backend's own
# readable timeout error instead of a dropped connection.
OPENROUTER_GENERATE_TIMEOUT_S = 110.0
LOCAL_GENERATE_TIMEOUT_S = 600.0
CHECK_KEY_TIMEOUT_S = 10.0

DEFAULT_TEMPERATURE = 0.6
DEFAULT_MAX_TOKENS = 4096
MAX_MAX_TOKENS = 200_000
MAX_INPUT_CHARS = 20_000
MAX_SYSTEM_PROMPT_CHARS = 20_000
MAX_MODEL_CHARS = 300
ALLOWED_FIELDS = frozenset({"provider", "model", "input", "system_prompt", "temperature", "max_tokens", "media"})
_SAFE_FIELD = re.compile(r"^[a-z_]{1,40}$")

# Media sent to the model. Files are base64-encoded into one JSON request, so
# the request is about 4/3 of MAX_MEDIA_TOTAL_BYTES.
MAX_MEDIA_FILES = 8
MAX_MEDIA_TOTAL_BYTES = 32 * 1024 * 1024
# Formats per kind (by file extension): (format name, media type). Images are
# the four OpenRouter lists; video and audio are OpenRouter's lists too.
MEDIA_FORMATS: dict[str, dict[str, tuple[str, str]]] = {
    "image": {"png": ("png", "image/png"), "jpg": ("jpeg", "image/jpeg"), "jpeg": ("jpeg", "image/jpeg"),
              "webp": ("webp", "image/webp"), "gif": ("gif", "image/gif")},
    "video": {"mp4": ("mp4", "video/mp4"), "mpeg": ("mpeg", "video/mpeg"), "mpg": ("mpeg", "video/mpeg"),
              "mov": ("mov", "video/mov"), "webm": ("webm", "video/webm")},
    "audio": {"wav": ("wav", "audio/wav"), "mp3": ("mp3", "audio/mpeg"), "aac": ("aac", "audio/aac"),
              "ogg": ("ogg", "audio/ogg"), "flac": ("flac", "audio/flac"), "m4a": ("m4a", "audio/mp4"),
              "aiff": ("aiff", "audio/aiff")},
}
# As the block names them: "Images (2)", "Videos (1)", "Audio (1)".
_PLURAL = {"image": "images", "video": "videos", "audio": "audio"}
_REFILL = "Add it again in the block that loads it."

MODELS_UNAVAILABLE = "Could not load the OpenRouter model list; type a model ID instead."


@dataclass(frozen=True)
class Deps:
    hosted: Transport
    local: Transport
    get_credential: Callable[[str], str | None]
    get_pref: Callable[[str], str | None]


def default_deps() -> Deps:
    from backend import settings_store

    return Deps(
        hosted=UrllibTransport(use_env_proxies=True),
        local=UrllibTransport(use_env_proxies=False),
        get_credential=settings_store.get_credential,
        get_pref=lambda name: settings_store.get_app_pref(name),
    )


# === OpenRouter model cache =================================================

_cache_lock = threading.Lock()
_cache: dict[str, Any] = {"ts": 0.0, "models": None}


# Ollama answers from /api/show: (base_url, model) -> (time, accepts).
_ollama_caps: dict[tuple[str, str], tuple[float, tuple[str, ...]]] = {}
# The last listed models of every provider, so a request with media can be
# refused for a model known not to take that kind: (provider, base_url, id) -> model.
_known: dict[tuple[str, str, str], ModelInfo] = {}


def reset_model_cache() -> None:
    with _cache_lock:
        _cache.update(ts=0.0, models=None)
        _ollama_caps.clear()
        _known.clear()


def _remember(provider: str, base_url: str | None, models: list[ModelInfo] | tuple[ModelInfo, ...]) -> None:
    with _cache_lock:
        for key in [k for k in _known if k[:2] == (provider, base_url or "")]:
            del _known[key]
        for m in models:
            _known[(provider, base_url or "", m.id)] = m


def _known_model(provider: str, base_url: str | None, model: str) -> ModelInfo | None:
    with _cache_lock:
        return _known.get((provider, base_url or "", model))


def _cached_models(refresh: bool) -> list[ModelInfo] | None:
    with _cache_lock:
        models, ts = _cache["models"], _cache["ts"]
    if refresh or models is None or time.monotonic() - ts > MODEL_CACHE_TTL_S:
        return None
    return list(models)


def _store_models(models: list[ModelInfo]) -> None:
    with _cache_lock:
        _cache.update(ts=time.monotonic(), models=list(models))


# === helpers ================================================================

def _safe_call(fn: Callable[[str], str | None], name: str) -> str | None:
    try:
        value = fn(name)
    except Exception:
        log.warning("prompt writer: could not read setting %s", name)
        return None
    return value if isinstance(value, str) else None


def _api_key(deps: Deps) -> str | None:
    key = _safe_call(deps.get_credential, OPENROUTER_CREDENTIAL)
    key = key.strip() if key else ""
    return key or None


def _local_base_url(deps: Deps, provider: str) -> tuple[str | None, str | None]:
    stored = _safe_call(deps.get_pref, base_urls.PREF_NAMES[provider])
    url, error = base_urls.resolve_base_url(provider, stored)
    if error:
        return None, f"The {LABELS[provider]} server URL in Settings is not valid: {error}"
    return url, None


def _local_provider(provider: str, base_url: str) -> ChatProvider:
    return OllamaProvider(base_url) if provider == "ollama" else LMStudioProvider(base_url)


def _status(provider: str, *, available: bool, reason: str | None, models: list[ModelInfo] | tuple = (),
            models_error: str | None = None, base_url: str | None = None) -> dict[str, Any]:
    return {
        "id": provider,
        "label": LABELS[provider],
        "kind": KINDS[provider],
        "available": available,
        "reason": None if available else reason,
        "models": [m.to_dict() for m in models] if available else [],
        "models_error": models_error if available else None,
        "base_url": base_url,
    }


# === status =================================================================

def _openrouter_status(deps: Deps, key: str | None, refresh: bool) -> dict[str, Any]:
    if not key:
        return _status("openrouter", available=False, reason="No OpenRouter API key is saved")
    models = _cached_models(refresh)
    if models is not None:
        _remember("openrouter", None, models)
        return _status("openrouter", available=True, reason=None, models=models)
    try:
        models = OpenRouterProvider(key).list_models(deps.hosted, OPENROUTER_MODELS_TIMEOUT_S)
    except Exception as exc:  # any failure degrades to a typed model ID
        log.info("prompt writer: OpenRouter model list unavailable (%s)", type(exc).__name__)
        return _status("openrouter", available=True, reason=None, models_error=MODELS_UNAVAILABLE)
    _store_models(models)
    _remember("openrouter", None, models)
    return _status("openrouter", available=True, reason=None, models=models,
                   models_error=None if models else MODELS_UNAVAILABLE)


def _ollama_capabilities(provider: OllamaProvider, transport: Transport, models: list[ModelInfo],
                         deadline: float, refresh: bool) -> list[ModelInfo]:
    """``models`` with ``accepts`` from ``/api/show``; never raises, never
    waits past ``deadline``. Cached answers are used unless ``refresh``."""
    now = time.monotonic()
    known: dict[str, tuple[str, ...]] = {}
    with _cache_lock:
        for m in models:
            hit = _ollama_caps.get((provider.base_url, m.id))
            if hit and not refresh and now - hit[0] <= MODEL_CACHE_TTL_S:
                known[m.id] = hit[1]
    missing = [m.id for m in models if m.id not in known]
    remaining = deadline - time.monotonic()
    if missing and remaining > 0:
        timeout = min(OLLAMA_SHOW_TIMEOUT_S, remaining)
        pool = ThreadPoolExecutor(max_workers=min(CAPABILITY_WORKERS, len(missing)),
                                  thread_name_prefix="prompt-writer-show")
        try:
            futures = {pool.submit(provider.model_accepts, transport, name, timeout): name for name in missing}
            done, _late = wait_futures(futures, timeout=max(0.0, deadline - time.monotonic()))
            for future in done:
                try:
                    accepts = future.result()
                except Exception as exc:
                    log.info("prompt writer: Ollama capability check failed (%s)", type(exc).__name__)
                    continue
                if accepts is None:
                    continue
                accepts = tuple(k for k in accepts if k in LOCAL_MEDIA_KINDS)
                known[futures[future]] = accepts
                with _cache_lock:
                    _ollama_caps[(provider.base_url, futures[future])] = (time.monotonic(), accepts)
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
    return [replace(m, accepts=known.get(m.id, ())) for m in models]


def _local_status(deps: Deps, provider: str, base_url: str, refresh: bool = False) -> dict[str, Any]:
    # The probe and the capability lookups share one PROBE_TIMEOUT_S budget,
    # so a status check still ends within LOCAL_DEADLINE_S.
    deadline = time.monotonic() + PROBE_TIMEOUT_S
    adapter = _local_provider(provider, base_url)
    result = adapter.probe(deps.local, PROBE_TIMEOUT_S)
    models = list(result.models)
    if result.available:
        try:
            if isinstance(adapter, OllamaProvider):
                models = _ollama_capabilities(adapter, deps.local, models, deadline, refresh)
            elif isinstance(adapter, LMStudioProvider):
                remaining = deadline - time.monotonic()
                if remaining > 0:
                    models = adapter.with_native_capabilities(deps.local, models, remaining)
        except Exception as exc:  # capabilities are a bonus: never make the provider unavailable
            log.info("prompt writer: %s capability check failed (%s)", provider, type(exc).__name__)
        if not models:
            return _status(provider, available=False, reason=adapter.empty_reason(), base_url=base_url)
        _remember(provider, base_url, models)
    return _status(provider, available=result.available, reason=result.reason, models=models,
                   base_url=base_url)


def provider_statuses(deps: Deps, *, refresh: bool = False) -> list[dict[str, Any]]:
    """Status of every provider, in ``PROVIDER_ORDER``. Never raises; takes at
    most about ``OPENROUTER_DEADLINE_S`` (``LOCAL_DEADLINE_S`` once the
    OpenRouter model list is cached)."""
    start = time.monotonic()
    key = _api_key(deps)
    local_urls = {p: _local_base_url(deps, p) for p in ("ollama", "lmstudio")}
    pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="prompt-writer-probe")
    try:
        futures = {"openrouter": pool.submit(_openrouter_status, deps, key, refresh)}
        for provider, (url, _error) in local_urls.items():
            if url:
                futures[provider] = pool.submit(_local_status, deps, provider, url, refresh)

        out: list[dict[str, Any]] = []
        for provider in PROVIDER_ORDER:
            if provider != "openrouter":
                url, error = local_urls[provider]
                if not url:
                    out.append(_status(provider, available=False, reason=error))
                    continue
            deadline = OPENROUTER_DEADLINE_S if provider == "openrouter" else LOCAL_DEADLINE_S
            remaining = max(0.0, deadline - (time.monotonic() - start))
            try:
                out.append(futures[provider].result(timeout=remaining))
            except FutureTimeout:
                out.append(_late_status(provider, local_urls))
            except Exception as exc:
                log.warning("prompt writer: %s status check failed (%s)", provider, type(exc).__name__)
                out.append(_crashed_status(provider, local_urls))
        return out
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def _late_status(provider: str, local_urls: dict[str, tuple[str | None, str | None]]) -> dict[str, Any]:
    if provider == "openrouter":
        return _status("openrouter", available=True, reason=None,
                       models_error="The OpenRouter model list is still loading. Press Re-check in a moment, "
                                    "or type a model ID.")
    url = local_urls[provider][0]
    return _status(provider, available=False, base_url=url,
                   reason=f"{LABELS[provider]} did not respond at {url} within {PROBE_TIMEOUT_S:g} s")


def _crashed_status(provider: str, local_urls: dict[str, tuple[str | None, str | None]]) -> dict[str, Any]:
    if provider == "openrouter":
        return _status("openrouter", available=True, reason=None, models_error=MODELS_UNAVAILABLE)
    url = local_urls[provider][0]
    return _status(provider, available=False, base_url=url, reason=f"Could not check {LABELS[provider]} at {url}")


# === generate ===============================================================

class _Invalid(Exception):
    pass


def _number(value: Any, *, name: str, lo: float, hi: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise _Invalid(f"{name} must be a number between {lo:g} and {hi:g}.")
    if not lo <= value <= hi:
        raise _Invalid(f"{name} must be a number between {lo:g} and {hi:g}.")
    return float(value)


@dataclass(frozen=True)
class _MediaRef:
    kind: str
    local: str


def _parse_media(value: Any) -> list[_MediaRef]:
    """The shape of ``media`` only; files are resolved later. Extra fields a
    loader attaches (label, size, url...) are ignored."""
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise _Invalid("media must be a list of file references from upstream blocks.")
    if len(value) > MAX_MEDIA_FILES:
        raise _Invalid(f"Send at most {MAX_MEDIA_FILES} files to the model at once ({len(value)} were sent).")
    out: list[_MediaRef] = []
    for item in value:
        if item.get("kind") not in MEDIA_KINDS:
            raise _Invalid("Each file sent to the model must be an image, video or audio reference.")
        local = item.get("local")
        if not isinstance(local, str) or not local.strip().startswith(references.OUTPUTS_PREFIX):
            raise _Invalid(f"A file sent to the model is not in the BlockFlow output folder. {_REFILL}")
        out.append(_MediaRef(item["kind"], local.strip()))
    return out


def _parse(payload: Any) -> tuple[str, ChatRequest, list[_MediaRef]]:
    if not isinstance(payload, dict):
        raise _Invalid("Send the request as a JSON object.")
    for field in payload:
        if field not in ALLOWED_FIELDS:
            name = field if isinstance(field, str) and _SAFE_FIELD.match(field) else None
            raise _Invalid(f"Unknown field: {name}." if name else "Unknown field.")
    provider = payload.get("provider")
    if provider not in PROVIDER_ORDER:
        raise _Invalid("Unknown provider. Choose OpenRouter, Ollama or LM Studio.")
    model = payload.get("model")
    if not isinstance(model, str) or not model.strip() or len(model.strip()) > MAX_MODEL_CHARS:
        raise _Invalid("Choose a model.")
    user_input = payload.get("input")
    if not isinstance(user_input, str) or not user_input.strip():
        raise _Invalid("Write an idea for the prompt first.")
    if len(user_input) > MAX_INPUT_CHARS:
        raise _Invalid(f"The idea is too long (at most {MAX_INPUT_CHARS:,} characters).")
    system_prompt = payload.get("system_prompt", "")
    if system_prompt is None:
        system_prompt = ""
    if not isinstance(system_prompt, str) or len(system_prompt) > MAX_SYSTEM_PROMPT_CHARS:
        raise _Invalid(f"System prompt must be text of at most {MAX_SYSTEM_PROMPT_CHARS:,} characters.")
    temperature = payload.get("temperature", DEFAULT_TEMPERATURE)
    temperature = _number(temperature, name="Temperature", lo=0, hi=2)
    max_tokens = payload.get("max_tokens", DEFAULT_MAX_TOKENS)
    if isinstance(max_tokens, bool) or not isinstance(max_tokens, int) or not 1 <= max_tokens <= MAX_MAX_TOKENS:
        raise _Invalid(f"Max tokens must be a whole number between 1 and {MAX_MAX_TOKENS:,}.")
    media = _parse_media(payload.get("media"))
    return provider, ChatRequest(model.strip(), system_prompt, user_input, temperature, max_tokens), media


def _error(kind: str, message: str) -> dict[str, Any]:
    return {"ok": False, "kind": kind, "message": message}


def _check_media_kinds(provider_id: str, base_url: str | None, model: str, media: list[_MediaRef]) -> None:
    """Refuse kinds the provider can never take, or the model is known not to."""
    kinds = [k for k in MEDIA_KINDS if any(r.kind == k for r in media)]
    if KINDS[provider_id] == "local":
        refused = [k for k in kinds if k not in LOCAL_MEDIA_KINDS]
        if refused:
            what = " or ".join(_PLURAL[k] for k in refused)
            raise _Invalid(f"{LABELS[provider_id]} takes images only, not {what}. Untick "
                           f"{' and '.join(_PLURAL[k].capitalize() for k in refused)} in the block, "
                           f"or use an OpenRouter model that accepts {what}.")
    known = _known_model(provider_id, base_url, model)
    if known is None:
        return  # not listed (a typed model ID): the provider decides
    for kind in kinds:
        if kind not in known.accepts:
            plural = _PLURAL[kind]
            raise _Invalid(f"{known.name} does not accept {plural}. Pick a model that accepts {plural}, "
                           f"or untick {plural.capitalize()} in the block.")


def _read_media_file(path: Path) -> bytes:
    return path.read_bytes()


def _load_media(media: list[_MediaRef]) -> tuple[MediaPart, ...]:
    """Resolve, check and read the files. Messages name a file by its own name
    only, never by the path that was sent."""
    found: list[tuple[_MediaRef, Path, str, str]] = []
    total = 0
    for ref in media:
        try:
            path = references.resolve_local(ref.local)
        except references.UnsafePathError:
            raise _Invalid(f"A file sent to the model is not in the BlockFlow output folder. {_REFILL}") from None
        if not path.is_file():
            raise _Invalid(f"{path.name} no longer exists. {_REFILL}")
        fmt = MEDIA_FORMATS[ref.kind].get(path.suffix.lower().lstrip("."))
        if fmt is None:
            allowed = ", ".join(sorted({f for f, _ in MEDIA_FORMATS[ref.kind].values()}))
            raise _Invalid(f"{path.name} is not a supported {ref.kind} file for the model (use {allowed}).")
        try:
            total += path.stat().st_size
        except OSError:
            raise _Invalid(f"{path.name} could not be read. {_REFILL}") from None
        found.append((ref, path, *fmt))
    if total > MAX_MEDIA_TOTAL_BYTES:
        raise _Invalid(f"The files sent to the model are too large together ({total / 1_000_000:.1f} MB; "
                       f"at most {MAX_MEDIA_TOTAL_BYTES / 1_000_000:.0f} MB). Untick a kind or send fewer files.")
    parts: list[MediaPart] = []
    for ref, path, fmt_name, mime in found:
        try:
            data = _read_media_file(path)
        except OSError:
            raise _Invalid(f"{path.name} could not be read. {_REFILL}") from None
        parts.append(MediaPart(ref.kind, mime, fmt_name, data))
    return tuple(parts)


def generate(payload: Any, deps: Deps) -> dict[str, Any]:
    """``{ok: True, text, provider, model}`` or ``{ok: False, kind, message}``."""
    try:
        provider_id, request, media = _parse(payload)
    except _Invalid as exc:
        return _error("validation", str(exc))

    key: str | None = None
    url: str | None = None
    if provider_id == "openrouter":
        key = _api_key(deps)
        if not key:
            return _error("unavailable", "No OpenRouter API key is saved. Add one in Settings → API keys.")
        provider: ChatProvider = OpenRouterProvider(key)
        transport = deps.hosted
    else:
        url, url_error = _local_base_url(deps, provider_id)
        if not url:
            return _error("unavailable", f"{(url_error or '').rstrip('.')}. Fix it in Settings → API keys.")
        provider = _local_provider(provider_id, url)
        transport = deps.local

    if media:
        try:
            _check_media_kinds(provider_id, url, request.model, media)
            request = replace(request, media=_load_media(media))
        except _Invalid as exc:
            return _error("validation", str(exc))

    try:
        timeout = OPENROUTER_GENERATE_TIMEOUT_S if provider_id == "openrouter" else LOCAL_GENERATE_TIMEOUT_S
        text = provider.chat(transport, request, timeout)
    except LLMError as err:
        log.info("prompt writer: %s generation failed (%s)", provider_id, err.kind)
        return _error(err.kind, redact(err.message, key))
    except Exception as exc:
        log.warning("prompt writer: %s generation crashed (%s)", provider_id, type(exc).__name__)
        return _error("provider_failure", f"{LABELS[provider_id]} could not complete the request.")
    return {"ok": True, "text": text, "provider": provider_id, "model": request.model}


# === key check ==============================================================

def check_openrouter_key(deps: Deps) -> dict[str, Any]:
    key = _api_key(deps)
    if not key:
        return {"ok": False, "valid": None, "message": "No OpenRouter API key is saved."}
    try:
        return OpenRouterProvider(key).check_key(deps.hosted, CHECK_KEY_TIMEOUT_S)
    except Exception as exc:
        log.warning("prompt writer: OpenRouter key check crashed (%s)", type(exc).__name__)
        return {"ok": False, "valid": None, "message": "Could not check the OpenRouter key."}
