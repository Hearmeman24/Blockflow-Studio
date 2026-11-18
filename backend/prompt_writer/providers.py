"""One adapter per Prompt Writer provider behind the same small interface.

- ``probe(transport, timeout) -> ProbeResult``: is the server answering, and
  with which models (local servers only; OpenRouter availability is the key).
- ``list_models(transport, timeout) -> list[ModelInfo]``.
- ``chat(transport, request, timeout) -> str``: one non-streaming completion,
  with optional media (images, video, audio) attached to the user message in
  the provider's own format.

Every listed model writes text and nothing else; ``ModelInfo.accepts`` names
the input kinds it takes besides text (``MEDIA_KINDS``). Local servers take
images at most: Ollama reports ``vision`` from ``POST /api/show``, LM Studio
``capabilities.vision`` from its native ``GET /api/v1/models``.

Every failure is an :class:`LLMError` with a normalised ``kind`` and a
message safe to show: the OpenRouter key is passed per call, goes only into
the ``Authorization`` header and is redacted from anything a provider echoes.
"""
from __future__ import annotations

import base64
import json
import re
from collections.abc import Iterable
from dataclasses import dataclass, field, replace
from typing import Any

from backend.prompt_writer.transport import HttpResponse, Transport, TransportError

ERROR_KINDS: tuple[str, ...] = (
    "validation",
    "unavailable",
    "auth",
    "insufficient_credits",
    "rate_limited",
    "model_not_found",
    "timeout",
    "network",
    "provider_failure",
    "malformed_response",
)

OPENROUTER_API_BASE = "https://openrouter.ai/api/v1"
# Sent as OpenRouter's optional app attribution header. No user data.
APP_TITLE = "BlockFlow"
REDACTED = "[redacted]"
_DETAIL_LIMIT = 200
_MISSING_MODEL_WORDS = ("not a valid model", "not found", "no endpoints found", "no models loaded",
                        "does not exist", "not loaded", "unknown model")
_THINK_RE = re.compile(r"^\s*<think>.*?</think>\s*", re.DOTALL | re.IGNORECASE)


class LLMError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        if kind not in ERROR_KINDS:
            raise ValueError(f"unknown error kind: {kind}")
        super().__init__(message)
        self.kind = kind
        self.message = message


# Input kinds a model may accept besides text, in this order everywhere.
MEDIA_KINDS: tuple[str, ...] = ("image", "video", "audio")
# What a local server (Ollama, LM Studio) can ever take besides text.
LOCAL_MEDIA_KINDS: frozenset[str] = frozenset({"image"})


def media_kinds(kinds: Iterable[object]) -> tuple[str, ...]:
    """The media kinds among ``kinds``, in ``MEDIA_KINDS`` order."""
    present = {k for k in kinds if isinstance(k, str)}
    return tuple(k for k in MEDIA_KINDS if k in present)


@dataclass(frozen=True)
class ModelInfo:
    id: str
    name: str
    # Input kinds accepted besides text: a subset of MEDIA_KINDS, in that order.
    accepts: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "accepts": list(self.accepts)}


@dataclass(frozen=True)
class ProbeResult:
    available: bool
    reason: str | None
    models: tuple[ModelInfo, ...] = ()


@dataclass(frozen=True)
class MediaPart:
    """One file sent to the model. ``fmt`` is the short format name
    (``png``, ``mp4``, ``mp3``...), ``mime`` its media type."""

    kind: str
    mime: str
    fmt: str
    data: bytes = field(repr=False)

    def b64(self) -> str:
        return base64.b64encode(self.data).decode("ascii")

    def data_url(self) -> str:
        return f"data:{self.mime};base64,{self.b64()}"


@dataclass(frozen=True)
class ChatRequest:
    model: str
    system_prompt: str
    user_input: str
    temperature: float
    max_tokens: int
    media: tuple[MediaPart, ...] = ()

    def messages(self) -> list[dict[str, Any]]:
        """System and user message, the user content as plain text. Each
        provider's ``chat_body`` adds the media in its own format."""
        out: list[dict[str, Any]] = []
        if self.system_prompt.strip():
            out.append({"role": "system", "content": self.system_prompt})
        out.append({"role": "user", "content": self.user_input})
        return out


def openai_content_part(part: MediaPart) -> dict[str, Any]:
    """An OpenAI-style chat content part, as OpenRouter documents them:
    ``image_url`` / ``video_url`` with a base64 data URL, ``input_audio`` with
    base64 data and a format name (audio cannot be a URL)."""
    if part.kind == "image":
        return {"type": "image_url", "image_url": {"url": part.data_url()}}
    if part.kind == "video":
        return {"type": "video_url", "video_url": {"url": part.data_url()}}
    return {"type": "input_audio", "input_audio": {"data": part.b64(), "format": part.fmt}}


def openai_messages(req: ChatRequest) -> list[dict[str, Any]]:
    """Messages with the media as content parts after the text (text first, as
    OpenRouter recommends). Without media the user content stays a string."""
    messages = req.messages()
    if req.media:
        messages[-1] = {"role": "user", "content": [{"type": "text", "text": req.user_input},
                                                    *(openai_content_part(p) for p in req.media)]}
    return messages


# === shared helpers =========================================================

def redact(text: str, secret: str | None) -> str:
    if secret and len(secret) >= 4:
        return text.replace(secret, REDACTED)
    return text


def _json(resp: HttpResponse) -> Any:
    try:
        return json.loads(resp.body.decode("utf-8")) if resp.body else None
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def _error_detail(data: Any) -> str:
    """The provider's own error text from the usual JSON error shapes."""
    if isinstance(data, dict):
        err = data.get("error", data.get("message"))
        if isinstance(err, str):
            return err
        if isinstance(err, dict) and isinstance(err.get("message"), str):
            return err["message"]
    return ""


def _clip(text: str, secret: str | None) -> str:
    text = redact(" ".join(text.split()), secret)
    return text if len(text) <= _DETAIL_LIMIT else text[: _DETAIL_LIMIT - 1] + "…"


def _with_detail(message: str, detail: str) -> str:
    return f"{message} ({detail})" if detail else message


def classify_http(label: str, status: int, detail: str, *, model: str, hosted: bool) -> LLMError:
    low = detail.lower()
    if status in (401, 403):
        if hosted:
            return LLMError("auth", f"{label} rejected the API key. Check it in Settings → API keys.")
        return LLMError("auth", _with_detail(f"{label} refused the request (HTTP {status}).", detail))
    if status == 402:
        return LLMError("insufficient_credits",
                        _with_detail(f"Your {label} account does not have enough credits for this request.", detail))
    if status == 429:
        return LLMError("rate_limited", f"{label} is rate limiting requests. Try again shortly.")
    if status in (408, 504):
        return LLMError("timeout", f"{label} did not answer in time.")
    if status < 500 and (status == 404 or any(word in low for word in _MISSING_MODEL_WORDS)):
        return LLMError("model_not_found",
                        _with_detail(f'Model "{model}" is not available on {label}. Choose another model.', detail))
    if status in (400, 413, 422):
        return LLMError("validation", _with_detail(f"{label} rejected the request.", detail))
    return LLMError("provider_failure",
                    _with_detail(f"{label} could not complete the request (HTTP {status}).", detail))


def _message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [p if isinstance(p, str) else p.get("text") for p in content if isinstance(p, (str, dict))]
        return "\n".join(p for p in parts if isinstance(p, str) and p)
    return ""


def clean_text(text: str) -> str:
    return _THINK_RE.sub("", text, count=1).strip()


def _openai_text(data: Any) -> str:
    choices = data.get("choices") if isinstance(data, dict) else None
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return ""
    first = choices[0]
    message = first.get("message")
    text = _message_text(message.get("content")) if isinstance(message, dict) else ""
    if not text and isinstance(first.get("text"), str):
        text = first["text"]
    return clean_text(text)


# === base adapter ===========================================================

class ChatProvider:
    id: str = ""
    label: str = ""
    kind: str = ""  # "hosted" | "local"

    def __init__(self, base_url: str, api_key: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key

    # -- to override --
    chat_path: str = ""
    models_path: str = ""

    def headers(self) -> dict[str, str]:
        return {"Content-Type": "application/json", "Accept": "application/json"}

    def chat_body(self, req: ChatRequest) -> dict[str, Any]:
        raise NotImplementedError

    def reply_text(self, data: Any) -> str:
        return _openai_text(data)

    def parse_models(self, data: Any) -> list[ModelInfo] | None:
        raise NotImplementedError

    def empty_reason(self) -> str:
        return f"{self.label} is running but has no models"

    # -- shared --
    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def _send(self, transport: Transport, method: str, path: str, body: bytes | None, timeout: float,
              *, headers: dict[str, str] | None = None) -> HttpResponse:
        return transport(method, self._url(path), headers or self.headers(), body, timeout)

    def transport_error(self, err: TransportError, *, timeout: float) -> LLMError:
        if err.kind == "timeout":
            return LLMError("timeout", f"{self.label} did not finish writing within {timeout:g} s. "
                                       "Try a faster model or a shorter prompt, then run again.")
        if err.kind == "refused":
            return LLMError("unavailable", f"{self.not_running_reason()}. Start it, then press Re-check.")
        return LLMError("network", f"Could not reach {self.label} at {self.base_url}.")

    def chat(self, transport: Transport, req: ChatRequest, timeout: float) -> str:
        body = json.dumps(self.chat_body(req), ensure_ascii=False).encode("utf-8")
        try:
            resp = self._send(transport, "POST", self.chat_path, body, timeout)
        except TransportError as err:
            raise self.transport_error(err, timeout=timeout) from None
        data = _json(resp)
        if resp.status != 200:
            detail = _clip(_error_detail(data), self._api_key)
            raise classify_http(self.label, resp.status, detail, model=req.model, hosted=self.kind == "hosted")
        if data is None:
            raise LLMError("malformed_response", f"{self.label} returned a response that is not valid JSON.")
        embedded = _error_detail(data) if isinstance(data, dict) and "error" in data else ""
        text = self.reply_text(data)
        if not text and embedded:
            raise LLMError("provider_failure",
                           _with_detail(f"{self.label} could not complete the request.", _clip(embedded, self._api_key)))
        if not text:
            raise LLMError("malformed_response", f"{self.label} returned a response without any text.")
        return text

    def list_models(self, transport: Transport, timeout: float) -> list[ModelInfo]:
        resp = self._send(transport, "GET", self.models_path, None, timeout)
        if resp.status != 200:
            raise LLMError("provider_failure", f"{self.label} answered with HTTP {resp.status}")
        models = self.parse_models(_json(resp))
        if models is None:
            raise LLMError("malformed_response", f"The server at {self.base_url} did not answer like {self.label}")
        return models

    def probe(self, transport: Transport, timeout: float) -> ProbeResult:
        """Local servers only. Never raises a TransportError."""
        try:
            resp = self._send(transport, "GET", self.models_path, None, timeout)
        except TransportError as err:
            if err.kind == "timeout":
                return ProbeResult(False, f"{self.label} did not respond at {self.base_url} within {timeout:g} s")
            if err.kind == "refused":
                return ProbeResult(False, self.not_running_reason())
            return ProbeResult(False, f"Could not reach {self.label} at {self.base_url}")
        if resp.status != 200:
            return ProbeResult(False, f"{self.label} at {self.base_url} answered with HTTP {resp.status}")
        models = self.parse_models(_json(resp))
        if models is None:
            return ProbeResult(False, f"The server at {self.base_url} did not answer like {self.label}")
        if not models:
            return ProbeResult(False, self.empty_reason())
        return ProbeResult(True, None, tuple(models))

    def not_running_reason(self) -> str:
        return f"{self.label} is not running at {self.base_url}"


# === OpenRouter =============================================================

def _modalities(row: dict[str, Any]) -> tuple[set[str], set[str]] | None:
    """(inputs, outputs) from ``input_modalities``/``output_modalities``, else
    from the legacy ``modality`` string such as ``"text+image->text"``."""
    arch = row.get("architecture")
    if not isinstance(arch, dict):
        return None
    ins, outs = arch.get("input_modalities"), arch.get("output_modalities")
    if isinstance(ins, list) and isinstance(outs, list):
        return ({x.strip().lower() for x in ins if isinstance(x, str)},
                {x.strip().lower() for x in outs if isinstance(x, str)})
    modality = arch.get("modality")
    if isinstance(modality, str) and "->" in modality:
        left, right = modality.lower().split("->", 1)
        return {x.strip() for x in left.split("+")}, {x.strip() for x in right.split("+")}
    return None


def _text_model_accepts(row: dict[str, Any]) -> tuple[str, ...] | None:
    """The extra input kinds of a model that takes text and writes only text;
    None for any other model (image, audio or video output, embeddings...)."""
    modalities = _modalities(row)
    if modalities is None:
        return None
    ins, outs = modalities
    if "text" not in ins or outs != {"text"}:
        return None
    return media_kinds(ins)


class OpenRouterProvider(ChatProvider):
    id = "openrouter"
    label = "OpenRouter"
    kind = "hosted"
    chat_path = "/chat/completions"
    models_path = "/models"
    key_path = "/key"

    def __init__(self, api_key: str | None, base_url: str = OPENROUTER_API_BASE) -> None:
        super().__init__(base_url, api_key)

    def headers(self) -> dict[str, str]:
        headers = super().headers()
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        headers["X-Title"] = APP_TITLE
        return headers

    def chat_body(self, req: ChatRequest) -> dict[str, Any]:
        return {
            "model": req.model,
            "messages": openai_messages(req),
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
            "stream": False,
        }

    def parse_models(self, data: Any) -> list[ModelInfo] | None:
        rows = data.get("data") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            return None
        out: list[ModelInfo] = []
        for row in rows:
            accepts = _text_model_accepts(row) if isinstance(row, dict) else None
            if accepts is None:
                continue
            model_id = row["id"].strip() if isinstance(row.get("id"), str) else ""
            if model_id:
                name = row["name"].strip() if isinstance(row.get("name"), str) else ""
                out.append(ModelInfo(model_id, name or model_id, accepts))
        out.sort(key=lambda m: (m.name.lower(), m.id))
        return out

    def transport_error(self, err: TransportError, *, timeout: float) -> LLMError:
        if err.kind == "timeout":
            return LLMError("timeout", f"OpenRouter did not finish writing within {timeout:g} s. "
                                       "Try again, or pick a faster model.")
        return LLMError("network", "Could not reach OpenRouter. Check your internet connection and try again.")

    def check_key(self, transport: Transport, timeout: float) -> dict[str, Any]:
        try:
            resp = self._send(transport, "GET", self.key_path, None, timeout)
        except TransportError:
            return {"ok": False, "valid": None, "message": "Could not reach OpenRouter to check the key."}
        if resp.status in (401, 403):
            return {"ok": True, "valid": False, "message": "OpenRouter rejected the key. Replace it with a new one."}
        data = _json(resp)
        if resp.status == 200 and isinstance(data, dict) and isinstance(data.get("data"), dict):
            return {"ok": True, "valid": True, "message": "OpenRouter accepted the key."}
        return {"ok": False, "valid": None,
                "message": f"Could not check the key (OpenRouter answered with HTTP {resp.status})."}


# === Ollama =================================================================

class OllamaProvider(ChatProvider):
    """Native API: ``GET /api/tags`` lists installed models, ``POST /api/show``
    reports one model's ``capabilities`` (``vision`` = takes images),
    ``POST /api/chat`` with ``stream: false`` returns one message. Images go
    on the user message as raw base64 strings (``images``)."""

    id = "ollama"
    label = "Ollama"
    kind = "local"
    chat_path = "/api/chat"
    models_path = "/api/tags"
    show_path = "/api/show"

    def chat_body(self, req: ChatRequest) -> dict[str, Any]:
        messages = req.messages()
        images = [p.b64() for p in req.media if p.kind == "image"]
        if images:
            messages[-1] = {**messages[-1], "images": images}
        # No sampling options: temperature, max tokens and the rest are set in
        # Ollama itself (the model's Modelfile and server settings).
        return {"model": req.model, "messages": messages, "stream": False}

    def model_accepts(self, transport: Transport, model: str, timeout: float) -> tuple[str, ...] | None:
        """The extra kinds one model takes, from ``capabilities``: ``("image",)``
        for ``vision``, else ``()``; ``()`` too when the answer has no usable
        ``capabilities`` list (older Ollama). None when the lookup failed
        (error status, timeout, not JSON), so the caller does not keep it."""
        body = json.dumps({"model": model}, ensure_ascii=False).encode("utf-8")
        try:
            resp = self._send(transport, "POST", self.show_path, body, timeout)
        except TransportError:
            return None
        data = _json(resp)
        if resp.status != 200 or not isinstance(data, dict):
            return None
        capabilities = data.get("capabilities")
        if not isinstance(capabilities, list):
            return ()
        return ("image",) if "vision" in capabilities else ()

    def reply_text(self, data: Any) -> str:
        message = data.get("message") if isinstance(data, dict) else None
        return clean_text(_message_text(message.get("content"))) if isinstance(message, dict) else ""

    def parse_models(self, data: Any) -> list[ModelInfo] | None:
        rows = data.get("models") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            return None
        out: list[ModelInfo] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            name = str(row.get("name") or row.get("model") or "").strip()
            if not name:
                continue
            details = row.get("details") if isinstance(row.get("details"), dict) else {}
            size = str(details.get("parameter_size") or "").strip()
            out.append(ModelInfo(name, f"{name} ({size})" if size else name))
        return out

    def empty_reason(self) -> str:
        return "Ollama is running but has no models installed"


# === LM Studio ==============================================================

class LMStudioProvider(ChatProvider):
    """OpenAI-compatible API: ``GET /v1/models`` and ``POST /v1/chat/completions``
    (images as ``image_url`` parts with a base64 data URL). The native
    ``GET /api/v1/models`` adds ``type`` and ``capabilities.vision`` per model;
    its ``key`` and ``loaded_instances[].id`` are the ids ``/v1/models`` lists
    and the chat call takes, so the ``/v1/models`` ids are kept as they are."""

    id = "lmstudio"
    label = "LM Studio"
    kind = "local"
    chat_path = "/v1/chat/completions"
    models_path = "/v1/models"
    native_models_path = "/api/v1/models"

    def chat_body(self, req: ChatRequest) -> dict[str, Any]:
        # No sampling fields: temperature, max tokens and the rest are set in
        # LM Studio itself (the model's load and inference settings).
        return {"model": req.model, "messages": openai_messages(req), "stream": False}

    def with_native_capabilities(self, transport: Transport, models: list[ModelInfo],
                                 timeout: float) -> list[ModelInfo]:
        """``models`` with image support marked and native embedding models
        removed. Unchanged when the native endpoint is missing (older LM
        Studio), slow or answers oddly. Never raises a TransportError."""
        try:
            resp = self._send(transport, "GET", self.native_models_path, None, timeout)
        except TransportError:
            return models
        data = _json(resp)
        rows = data.get("models") if resp.status == 200 and isinstance(data, dict) else None
        if not isinstance(rows, list):
            return models
        vision: set[str] = set()
        embedding: set[str] = set()
        for row in rows:
            if not isinstance(row, dict):
                continue
            ids = {row["key"]} if isinstance(row.get("key"), str) else set()
            instances = row.get("loaded_instances")
            if isinstance(instances, list):
                ids |= {i["id"] for i in instances if isinstance(i, dict) and isinstance(i.get("id"), str)}
            caps = row.get("capabilities")
            if row.get("type") == "embedding":
                embedding |= ids
            elif row.get("type") == "llm" and isinstance(caps, dict) and caps.get("vision") is True:
                vision |= ids
        return [replace(m, accepts=("image",)) if m.id in vision else m
                for m in models if m.id not in embedding]

    def parse_models(self, data: Any) -> list[ModelInfo] | None:
        rows = data.get("data") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            return None
        out: list[ModelInfo] = []
        for row in rows:
            model_id = str(row.get("id") or "").strip() if isinstance(row, dict) else ""
            # Embedding models are listed too but cannot chat.
            if model_id and "embed" not in model_id.lower():
                out.append(ModelInfo(model_id, model_id))
        return out

    def empty_reason(self) -> str:
        return "LM Studio is running but has no model loaded"
