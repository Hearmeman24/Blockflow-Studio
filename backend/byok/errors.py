"""One normalised error type for every provider failure.

Messages are user-facing and safe: API keys are redacted from anything that
came from a provider, and the key is never stored on the exception.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from backend.statuses import PROVIDER_ERROR_KINDS, ErrorKind

# The kinds a ProviderError may carry, as plain strings (``interrupted`` is a
# job-store-only kind and is not one of them).
ERROR_KINDS: tuple[str, ...] = tuple(k.value for k in PROVIDER_ERROR_KINDS)

# Kinds that a caller may retry later. Automatic retry inside the provider
# layer is narrower: see ``http.RETRY_KINDS``.
_RETRYABLE_BY_DEFAULT = frozenset({ErrorKind.RATE_LIMITED, ErrorKind.NETWORK, ErrorKind.TIMEOUT})

_CONTENT_WORDS = ("content policy", "content review", "content violation", "content moderation", "sensitive",
                  "nsfw", "moderation", "violat", "inappropriate", "safety", "prohibited")

REDACTED = "[redacted]"


def redact(text: Any, *secrets: str | None) -> str:
    out = "" if text is None else str(text)
    for secret in secrets:
        if secret and len(secret) >= 4:
            out = out.replace(secret, REDACTED)
    return out


@dataclass(frozen=True)
class ErrorInfo:
    """Serialisable snapshot of a ProviderError (for job records / API)."""

    kind: str
    message: str
    retryable: bool
    http_status: int | None = None
    provider_code: str | None = None
    provider: str | None = None


class ProviderError(Exception):
    def __init__(
        self,
        kind: str,
        message: str,
        *,
        provider: str | None = None,
        retryable: bool | None = None,
        http_status: int | None = None,
        provider_code: str | int | None = None,
        issues: Sequence[Any] = (),
        cost: Any = None,
    ) -> None:
        """``cost``: the charge the provider reported for the task (a
        ``providers.base.Cost``) when the error was raised while reading a
        finished task's result, so the job can still record it; else None."""
        if kind not in ERROR_KINDS:
            raise ValueError(f"unknown error kind: {kind}")
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.provider = provider
        self.retryable = kind in _RETRYABLE_BY_DEFAULT if retryable is None else retryable
        self.http_status = http_status
        self.provider_code = None if provider_code is None else str(provider_code)
        self.issues = tuple(issues)
        self.cost = cost

    def info(self) -> ErrorInfo:
        return ErrorInfo(self.kind, self.message, self.retryable, self.http_status, self.provider_code,
                         self.provider)

    def __repr__(self) -> str:
        return (f"ProviderError(kind={self.kind!r}, message={self.message!r}, provider={self.provider!r}, "
                f"http_status={self.http_status!r}, provider_code={self.provider_code!r}, "
                f"retryable={self.retryable!r})")

    def __str__(self) -> str:
        return self.message


def mentions_content_rejection(text: str) -> bool:
    lowered = text.lower()
    return any(word in lowered for word in _CONTENT_WORDS)


def mentions_insufficient_credits(text: str) -> bool:
    lowered = text.lower()
    has_money_word = any(w in lowered for w in ("credit", "balance", "quota", "fund"))
    return has_money_word and any(w in lowered for w in ("insufficient", "not enough", "exhausted"))


def _status_kind(status: int) -> tuple[str, bool]:
    if status in (401, 403):
        return "auth", False
    if status == 402:
        return "insufficient_credits", False
    if status == 408:
        return "timeout", True
    if status == 429:
        return "rate_limited", True
    if status in (400, 404, 413, 422):
        return "validation", False
    if status >= 500:
        return "provider_failure", True
    return "provider_failure", False


_USER_MESSAGES = {
    "auth": "The {p} API key was rejected. Check the key in Settings.",
    "insufficient_credits": "Your {p} account does not have enough credits for this request.",
    "rate_limited": "{p} is rate limiting requests. Try again shortly.",
    "timeout": "{p} did not respond in time.",
    "provider_failure": "{p} could not complete the request.",
    "validation": "{p} rejected the request parameters.",
    "content_rejected": "{p} rejected the content of this request.",
    "unsupported": "{p} does not support this request.",
}


def classify(
    provider: str,
    provider_name: str,
    status: int,
    detail: str,
    *,
    api_key: str | None,
    provider_code: str | int | None = None,
    http_status: int | None = None,
    overrides: Mapping[int, tuple[str, bool]] | None = None,
) -> ProviderError:
    """Map a status code (HTTP or body) plus provider text to a ProviderError."""
    kind, retryable = (overrides or {}).get(status) or _status_kind(status)
    detail = redact(detail, api_key).strip()
    if kind in ("validation", "provider_failure") and detail and mentions_content_rejection(detail):
        kind, retryable = "content_rejected", False
    elif kind in ("validation", "provider_failure", "auth") and detail and mentions_insufficient_credits(detail):
        kind, retryable = "insufficient_credits", False
    base = _USER_MESSAGES[kind].format(p=provider_name)
    message = f"{base} ({detail[:300]})" if detail else base
    return ProviderError(kind, message, provider=provider, retryable=retryable, http_status=http_status,
                         provider_code=provider_code if provider_code is not None else status)
