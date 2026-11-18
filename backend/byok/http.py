"""A small injectable HTTP transport on stdlib ``urllib`` plus bounded retry.

Tests pass a fake transport; production uses :class:`UrllibTransport`.
HTTP error statuses are returned as responses (not raised) so adapters can
read provider error bodies. Only connection failures and timeouts raise.
"""

from __future__ import annotations

import json
import socket
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol, TypeVar

from backend.byok.errors import ProviderError, redact

# PiAPI sits behind Cloudflare, which blocks the default python-urllib agent.
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0 Safari/537.36"
)

# Automatic retry happens only for these kinds, and only on idempotent calls.
RETRY_KINDS = frozenset({"rate_limited", "network", "provider_failure"})


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes
    headers: Mapping[str, str] = field(default_factory=dict)


class Transport(Protocol):
    def __call__(self, method: str, url: str, headers: Mapping[str, str], body: bytes | None,
                 timeout: float) -> HttpResponse: ...


class UrllibTransport:
    def __call__(self, method: str, url: str, headers: Mapping[str, str], body: bytes | None,
                 timeout: float) -> HttpResponse:
        req = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return HttpResponse(resp.status, resp.read(), dict(resp.headers.items()))
        except urllib.error.HTTPError as exc:
            data = exc.read() if exc.fp is not None else b""
            return HttpResponse(exc.code, data, dict(exc.headers.items()) if exc.headers else {})
        except (TimeoutError, socket.timeout) as exc:
            raise ProviderError("timeout", "The provider did not respond in time.", retryable=True) from exc
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, (TimeoutError, socket.timeout)):
                raise ProviderError("timeout", "The provider did not respond in time.", retryable=True) from exc
            raise ProviderError("network", f"Could not reach the provider ({type(exc.reason).__name__}).",
                                retryable=True) from exc
        except OSError as exc:
            raise ProviderError("network", f"Could not reach the provider ({type(exc).__name__}).",
                                retryable=True) from exc


@dataclass(frozen=True)
class RetryPolicy:
    """Bounded exponential backoff. Tests set ``base_delay_s=0``."""

    max_attempts: int = 3
    base_delay_s: float = 1.0
    max_delay_s: float = 8.0
    sleep: Callable[[float], None] = time.sleep

    def delay(self, attempt: int) -> float:
        return min(self.max_delay_s, self.base_delay_s * (2 ** (attempt - 1)))


NO_RETRY = RetryPolicy(max_attempts=1, base_delay_s=0)

T = TypeVar("T")


def with_retry(fn: Callable[[], T], policy: RetryPolicy) -> T:
    attempt = 1
    while True:
        try:
            return fn()
        except ProviderError as err:
            if attempt >= policy.max_attempts or not err.retryable or err.kind not in RETRY_KINDS:
                raise
            policy.sleep(policy.delay(attempt))
            attempt += 1


def send(
    transport: Transport,
    method: str,
    url: str,
    headers: Mapping[str, str],
    body: bytes | None,
    *,
    timeout: float,
    provider: str,
    api_key: str | None,
) -> HttpResponse:
    """Call the transport and tag/redact any transport error."""
    try:
        return transport(method, url, headers, body, timeout)
    except ProviderError as err:
        err.provider = provider
        err.message = redact(err.message, api_key)
        err.args = (err.message,)
        raise
    except (TimeoutError, socket.timeout):
        raise ProviderError("timeout", "The provider did not respond in time.", provider=provider) from None
    except OSError as exc:
        raise ProviderError("network", f"Could not reach the provider ({type(exc).__name__}).",
                            provider=provider) from None


def parse_json(resp: HttpResponse, provider: str, provider_name: str, api_key: str | None) -> Any:
    try:
        return json.loads(resp.body.decode("utf-8")) if resp.body else None
    except (UnicodeDecodeError, json.JSONDecodeError):
        snippet = redact(resp.body[:120].decode("utf-8", errors="replace"), api_key)
        raise ProviderError("malformed_response", f"{provider_name} returned a response that is not valid JSON.",
                            provider=provider, retryable=resp.status >= 500, http_status=resp.status,
                            provider_code=None if not snippet else "invalid_json") from None


def lenient_json(resp: HttpResponse) -> Any:
    """Parse an error body if it is JSON; ``None`` otherwise (e.g. an HTML 502 page)."""
    try:
        return json.loads(resp.body.decode("utf-8")) if resp.body else None
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def json_body(payload: Mapping[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def multipart(fields: Mapping[str, str], file_field: str, filename: str, content: bytes,
              content_type: str) -> tuple[bytes, str]:
    boundary = f"----byok{uuid.uuid4().hex}"
    lines: list[bytes] = []
    for name, value in fields.items():
        lines += [f"--{boundary}".encode(), f'Content-Disposition: form-data; name="{name}"'.encode(), b"",
                  value.encode("utf-8")]
    safe_name = filename.replace('"', "_")
    lines += [f"--{boundary}".encode(),
              f'Content-Disposition: form-data; name="{file_field}"; filename="{safe_name}"'.encode(),
              f"Content-Type: {content_type}".encode(), b"", content, f"--{boundary}--".encode(), b""]
    return b"\r\n".join(lines), f"multipart/form-data; boundary={boundary}"
