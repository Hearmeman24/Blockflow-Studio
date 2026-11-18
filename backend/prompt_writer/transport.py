"""A minimal injectable HTTP transport on stdlib ``urllib``.

HTTP error statuses come back as responses so adapters can read provider
error bodies. Only connection failures and timeouts raise, as
:class:`TransportError` with kind ``timeout``, ``refused`` (nothing listening)
or ``network`` (anything else). Messages never include headers or bodies.
"""
from __future__ import annotations

import errno
import socket
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes


class TransportError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


class Transport(Protocol):
    def __call__(self, method: str, url: str, headers: Mapping[str, str], body: bytes | None,
                 timeout: float) -> HttpResponse: ...


def _is_refused(exc: BaseException | None) -> bool:
    if isinstance(exc, ConnectionRefusedError):
        return True
    return isinstance(exc, OSError) and exc.errno in (errno.ECONNREFUSED, errno.EADDRNOTAVAIL)


class UrllibTransport:
    """``use_env_proxies=False`` is for local servers: a system HTTP proxy
    must not intercept requests meant for localhost or the LAN."""

    def __init__(self, *, use_env_proxies: bool = True) -> None:
        handlers = [] if use_env_proxies else [urllib.request.ProxyHandler({})]
        self._opener = urllib.request.build_opener(*handlers)

    def __call__(self, method: str, url: str, headers: Mapping[str, str], body: bytes | None,
                 timeout: float) -> HttpResponse:
        req = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
        try:
            with self._opener.open(req, timeout=timeout) as resp:
                return HttpResponse(resp.status, resp.read())
        except urllib.error.HTTPError as exc:
            data = exc.read() if exc.fp is not None else b""
            return HttpResponse(exc.code, data)
        except (TimeoutError, socket.timeout) as exc:
            raise TransportError("timeout", "The server did not respond in time.") from exc
        except urllib.error.URLError as exc:
            reason = exc.reason
            if isinstance(reason, (TimeoutError, socket.timeout)):
                raise TransportError("timeout", "The server did not respond in time.") from exc
            if _is_refused(reason if isinstance(reason, BaseException) else None):
                raise TransportError("refused", "Connection refused.") from exc
            name = type(reason).__name__ if isinstance(reason, BaseException) else "URLError"
            raise TransportError("network", f"Could not connect ({name}).") from exc
        except OSError as exc:
            if _is_refused(exc):
                raise TransportError("refused", "Connection refused.") from exc
            raise TransportError("network", f"Could not connect ({type(exc).__name__}).") from exc
