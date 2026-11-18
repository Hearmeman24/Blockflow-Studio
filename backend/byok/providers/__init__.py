"""Provider adapters. Blocks never call Kie or PiAPI directly; they go through these."""

from __future__ import annotations

from backend.byok.errors import ProviderError
from backend.byok.http import RetryPolicy, Transport
from backend.byok.providers.base import (
    KeyStatus,
    Output,
    PollResult,
    ProviderAdapter,
    ProviderRequest,
    SubmitResult,
)
from backend.byok.providers.kie import KieAdapter
from backend.byok.providers.piapi import PiAPIAdapter

ADAPTERS: dict[str, type[ProviderAdapter]] = {"kie": KieAdapter, "piapi": PiAPIAdapter}


def get_adapter(provider: str, transport: Transport | None = None, retry: RetryPolicy | None = None) -> ProviderAdapter:
    try:
        cls = ADAPTERS[provider]
    except KeyError:
        raise ProviderError("unsupported", f"Unknown provider '{provider}'.", retryable=False) from None
    return cls(transport=transport, retry=retry)


__all__ = [
    "ADAPTERS",
    "KeyStatus",
    "Output",
    "PollResult",
    "ProviderAdapter",
    "ProviderRequest",
    "SubmitResult",
    "get_adapter",
]
