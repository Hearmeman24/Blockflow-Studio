"""One normalised error type for every provider failure.

Messages are user-facing and safe: API keys are redacted from anything that
came from a provider, and the key is never stored on the exception.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from backend.statuses import PROVIDER_ERROR_KINDS, ErrorKind

# The kinds a ProviderError may carry, as plain strings (``interrupted`` is a
# job-store-only kind and is not one of them).
ERROR_KINDS: tuple[str, ...] = tuple(k.value for k in PROVIDER_ERROR_KINDS)



@dataclass(frozen=True)
class KindPolicy:
    """How one error kind is retried. The only declaration of retryability:

    - ``retryable_by_default``: ``ProviderError.retryable`` when the raiser
      does not say. The generation service re-polls a retryable poll error,
      up to ``service.MAX_POLL_ERRORS`` in a row.
    - ``http_retry``: ``http.with_retry`` retries it inside one idempotent
      call (polls, uploads, balance reads) when the error is also retryable.
      A submit is never retried: it is called with ``http.NO_RETRY``.
    - ``ambiguous_on_submit``: a submit that fails this way may still have
      created (and billed) a task, so the job's message says to check the
      provider dashboard before running again.
    """

    retryable_by_default: bool
    http_retry: bool
    ambiguous_on_submit: bool


_P = KindPolicy
RETRY_POLICY: Mapping[ErrorKind, KindPolicy] = {
    ErrorKind.AUTH: _P(False, False, False),
    ErrorKind.INSUFFICIENT_CREDITS: _P(False, False, False),
    ErrorKind.RATE_LIMITED: _P(True, True, False),
    ErrorKind.VALIDATION: _P(False, False, False),
    ErrorKind.CONTENT_REJECTED: _P(False, False, False),
    ErrorKind.UNSUPPORTED: _P(False, False, False),
    # Only a 5xx-style failure is marked retryable by the raiser (see _status_kind).
    ErrorKind.PROVIDER_FAILURE: _P(False, True, False),
    # A timeout uses one of the service's poll attempts rather than an in-call retry.
    ErrorKind.TIMEOUT: _P(True, False, True),
    ErrorKind.NETWORK: _P(True, True, True),
    ErrorKind.MALFORMED_RESPONSE: _P(False, False, True),
    # Written by the job store's restart recovery only; never raised or retried.
    ErrorKind.INTERRUPTED: _P(False, False, False),
}
del _P
if set(RETRY_POLICY) != set(ErrorKind):  # a new kind must state its policy
    raise RuntimeError("RETRY_POLICY must have exactly one entry per ErrorKind")


def kinds_where(flag: str) -> frozenset[str]:
    """The kinds (plain strings) whose policy has ``flag`` set."""
    return frozenset(k.value for k, p in RETRY_POLICY.items() if getattr(p, flag))


# Kinds that a caller may retry later. Automatic retry inside the provider
# layer is narrower: see ``http.RETRY_KINDS``.
_RETRYABLE_BY_DEFAULT = kinds_where("retryable_by_default")

_CONTENT_WORDS = ("content policy", "content review", "content violation", "content moderation", "sensitive",
                  "nsfw", "moderation", "violat", "inappropriate", "safety", "prohibited",
                  # Kie: "Content security audit did not pass. ... copyright restrictions."
                  "security audit", "audit did not pass", "copyright")

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


# ------------------------------------------------------------------ provider messages
#
# One builder for every message that carries provider text: ``classify``
# and the adapters' failed-task polls. A readable reason leads
# ("Kie: <the provider's words>."); our generic sentence is used only when
# the provider said nothing readable. The generation service then appends
# one action per kind with :func:`with_hint`.

REASON_LIMIT = 300
_TERMINAL = (".", "!", "?", "…")
_CLOSERS = ")]}\"'”’»"
_DANGLING = ",;:-–— "
_MARKUP = re.compile(r"<\s*(?:!doctype|/?[a-z][a-z0-9-]*)(?:\s[^>]*)?/?\s*>", re.IGNORECASE)
# Texts that say nothing beyond the status itself.
_PLACEHOLDERS = frozenset({"null", "none", "nil", "undefined", "nan", "true", "false", "ok", "success",
                           "error", "failed", "fail", "failure", "unknown", "unknown error"})


def _is_prose(text: str) -> bool:
    """False for what must never lead a message: nothing, an HTML page or
    tag, a JSON (or Python repr) object or list, a bare code or a placeholder."""
    if not text or not any(c.isalpha() for c in text):
        return False
    if text[0] == "{" or (text[0] == "[" and not text.startswith(REDACTED)):
        return False
    if _MARKUP.search(text):
        return False
    return text.strip(".!?: ").lower() not in _PLACEHOLDERS


def end_sentence(text: str) -> str:
    """``text`` ending in exactly one terminal mark: a missing full stop is
    added, a doubled one collapsed, an ellipsis, ``?`` or ``!`` kept, also
    inside a closing bracket or quote (``(see docs.)``)."""
    text = text.rstrip()
    core = text.rstrip(_CLOSERS)
    tail = text[len(core):]
    if not core:
        return text
    if core.endswith("..."):
        return text
    if core.endswith("."):
        return core.rstrip(".") + "." + tail
    if core.endswith(_TERMINAL):
        return text
    if tail:
        return text + "."
    return text.rstrip(_DANGLING) + "."


def provider_reason(text: Any, *secrets: str | None) -> str | None:
    """The provider's words, fit to lead a message: keys redacted, whitespace
    collapsed, capped at ``REASON_LIMIT`` characters (then "…"), ending in one
    terminal mark. None when there is nothing readable (see ``_is_prose``)."""
    cleaned = " ".join(redact(text, *secrets).split())
    if not _is_prose(cleaned):
        return None
    if len(cleaned) > REASON_LIMIT:
        return cleaned[:REASON_LIMIT].rstrip(_DANGLING + ".") + "…"
    return end_sentence(cleaned)


def provider_message(provider_name: str, text: Any, generic: str, *secrets: str | None) -> tuple[str, str | None]:
    """(message, reason): ``"<Provider>: <reason>"`` when the provider gave a
    readable reason, else ``generic``."""
    reason = provider_reason(text, *secrets)
    return (f"{provider_name}: {reason}" if reason else generic), reason


def with_hint(message: str, hint: str) -> str:
    """``message`` then ``hint``, one space apart, with ``message`` ending in
    one terminal mark. The hint is left out when empty or already said."""
    message = message.strip()
    if not hint or hint.lower() in message.lower():
        return message
    return f"{end_sentence(message)} {hint}" if message else hint


_USER_MESSAGES = {
    "auth": "The {p} API key was rejected.",
    "insufficient_credits": "Your {p} account does not have enough credits for this request.",
    "rate_limited": "{p} is rate limiting requests.",
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
    message, _ = provider_message(provider_name, detail, _USER_MESSAGES[kind].format(p=provider_name))
    return ProviderError(kind, message, provider=provider, retryable=retryable, http_status=http_status,
                         provider_code=provider_code if provider_code is not None else status)
