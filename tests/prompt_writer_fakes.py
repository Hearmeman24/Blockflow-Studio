"""Fake HTTP transports for the Prompt Writer tests. No real network.

A route is keyed by ``(method, url)`` and maps to an ``HttpResponse``, an
exception to raise, or a callable ``(call) -> HttpResponse``. A request to a
URL with no route behaves like a server that is not running (connection
refused).
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.prompt_writer.transport import HttpResponse, TransportError  # noqa: E402


@dataclass
class Call:
    method: str
    url: str
    headers: dict[str, str]
    body: bytes | None
    timeout: float

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8")) if self.body else None


Handler = HttpResponse | BaseException | Callable[[Call], HttpResponse]


class FakeTransport:
    def __init__(self, routes: dict[tuple[str, str], Handler] | None = None) -> None:
        self.routes: dict[tuple[str, str], Handler] = dict(routes or {})
        self.calls: list[Call] = []

    def __call__(self, method: str, url: str, headers, body, timeout: float) -> HttpResponse:
        call = Call(method, url, dict(headers), body, timeout)
        self.calls.append(call)
        handler = self.routes.get((method, url))
        if handler is None:
            raise TransportError("refused", "Connection refused")
        if isinstance(handler, BaseException):
            raise handler
        if callable(handler):
            return handler(call)
        return handler

    def urls(self) -> list[str]:
        return [f"{c.method} {c.url}" for c in self.calls]


def ok(body: Any, status: int = 200) -> HttpResponse:
    return HttpResponse(status, json.dumps(body).encode("utf-8"))


def raw(text: str, status: int = 200) -> HttpResponse:
    return HttpResponse(status, text.encode("utf-8"))


OPENROUTER_MODELS = {
    "data": [
        {"id": "x-ai/grok-4.1-fast", "name": "xAI: Grok 4.1 Fast",
         "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]}},
        {"id": "anthropic/claude-sonnet", "name": "Anthropic: Claude Sonnet",
         "architecture": {"modality": "text+image->text"}},
        {"id": "black-forest/flux", "name": "FLUX image",
         "architecture": {"input_modalities": ["text"], "output_modalities": ["image"]}},
        {"id": "", "name": "no id", "architecture": {"modality": "text->text"}},
        "not-a-dict",
    ]
}

OLLAMA_TAGS = {"models": [
    {"name": "llama3.2:latest", "model": "llama3.2:latest", "details": {"parameter_size": "3.2B"}},
    {"name": "qwen3:8b", "model": "qwen3:8b", "details": {}},
]}

LMSTUDIO_MODELS = {"object": "list", "data": [
    {"id": "google/gemma-3-12b", "object": "model"},
    {"id": "text-embedding-nomic-embed-text-v1.5", "object": "model"},
]}
