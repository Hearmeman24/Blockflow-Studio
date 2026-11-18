"""Only the app's own pages may use the local API from a browser.

The backend listens on 127.0.0.1, but any web page the user visits can make
their browser send requests to it. Two layers stop that:

- CORS lists the app's own origins (never ``*``), so a foreign page cannot
  read answers.
- :class:`OriginGuard` refuses a state-changing request (POST, PUT, PATCH,
  DELETE) whose ``Origin`` is not allowed, before it reaches a route. Without
  an ``Origin`` header, ``Sec-Fetch-Site: cross-site`` is refused too. CORS
  alone would not stop a "simple" cross-site POST (a form, ``text/plain``
  fetch) from running.

Allowed: ``http://localhost|127.0.0.1|[::1]`` on the frontend port (the
Next.js app; browser calls through its ``/api`` proxy carry this Origin, and
``directBackendUrl`` calls go straight to the backend with it) and on the
backend port itself. People who serve the app under another address add
origins with ``BLOCKFLOW_ALLOWED_ORIGINS`` (comma separated) or the app pref
``allowed_origins``. Requests with no ``Origin`` (the MCP server, curl,
server-side code) are allowed: browsers always send one on these methods.
"""

from __future__ import annotations

import json
import os
import time
from typing import Iterable
from urllib.parse import urlsplit

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

ORIGINS_ENV = "BLOCKFLOW_ALLOWED_ORIGINS"
ORIGINS_PREF = "allowed_origins"
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
DEFAULT_FRONTEND_PORT = 47300
DEFAULT_BACKEND_PORT = 47301
_PREF_TTL_S = 5.0
REFUSED = ("This request came from a page that is not BlockFlow (Origin not allowed). "
           f"If you serve BlockFlow under another address, add it to {ORIGINS_ENV}.")


def _port(env: str, default: int) -> int:
    try:
        return int(os.environ.get(env, default))
    except ValueError:
        return default


def parse_origins(raw: str | Iterable[str] | None) -> list[str]:
    """Normalised ``scheme://host[:port]`` origins; wildcards and anything
    that is not http(s) are dropped."""
    if raw is None:
        return []
    items = raw.split(",") if isinstance(raw, str) else list(raw)
    out: list[str] = []
    for item in items:
        if not isinstance(item, str):
            continue
        value = item.strip()
        if not value or "*" in value:
            continue
        try:
            parts = urlsplit(value)
        except ValueError:
            continue
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
            continue
        origin = f"{parts.scheme}://{parts.netloc}".lower()
        if origin not in out:
            out.append(origin)
    return out


def allowed_origins(*, frontend_port: int, backend_port: int, extra: Iterable[str]) -> list[str]:
    hosts = ("localhost", "127.0.0.1", "[::1]")
    base = [f"http://{h}:{p}" for p in (frontend_port, backend_port) for h in hosts]
    return base + [o for o in parse_origins(list(extra)) if o not in base]


def _pref_origins() -> list[str]:
    from backend import settings_store

    try:
        raw = settings_store.get_app_pref(ORIGINS_PREF)
    except Exception:  # noqa: BLE001 - an unreadable settings DB means "none"
        return []
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except ValueError:
        value = raw
    return parse_origins(value if isinstance(value, (list, str)) else None)


class _Origins:
    """The static list plus the pref, re-read at most every few seconds."""

    def __init__(self, static: list[str]) -> None:
        self.static = static
        self._pref: list[str] = []
        self._read_at = float("-inf")

    def all(self) -> set[str]:
        now = time.monotonic()
        if now - self._read_at > _PREF_TTL_S:
            self._pref = _pref_origins()
            self._read_at = now
        return set(self.static) | set(self._pref)

    def allows(self, origin: str) -> bool:
        return origin.lower() in self.all()


class OriginGuard:
    """Pure ASGI middleware (keeps SSE and uploads streaming)."""

    def __init__(self, app, origins: _Origins) -> None:
        self.app = app
        self.origins = origins

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method", "GET").upper() not in UNSAFE_METHODS:
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        origin = headers.get("origin")
        if origin is not None:
            allowed = self.origins.allows(origin.strip())
        else:
            allowed = headers.get("sec-fetch-site", "").strip().lower() != "cross-site"
        if allowed:
            await self.app(scope, receive, send)
            return
        body = json.dumps({"detail": REFUSED}).encode()
        await send({"type": "http.response.start", "status": 403,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


class _DynamicCORS(CORSMiddleware):
    """CORSMiddleware whose allow-list includes the pref (re-read with a TTL)."""

    def __init__(self, app, origins: _Origins, **kwargs) -> None:
        super().__init__(app, allow_origins=list(origins.static), **kwargs)
        self._origins = origins

    def is_allowed_origin(self, origin: str) -> bool:  # noqa: D401 - Starlette hook
        return self._origins.allows(origin)


def install(app: FastAPI, *, frontend_port: int | None = None, backend_port: int | None = None) -> list[str]:
    """Add the guard and CORS to ``app``. Returns the static allow-list."""
    fport = frontend_port if frontend_port is not None else _port("FRONTEND_PORT", DEFAULT_FRONTEND_PORT)
    bport = backend_port if backend_port is not None else _port("BACKEND_PORT", DEFAULT_BACKEND_PORT)
    static = allowed_origins(frontend_port=fport, backend_port=bport,
                             extra=parse_origins(os.environ.get(ORIGINS_ENV)))
    origins = _Origins(static)
    # Added first = inner: CORS answers preflights, the guard runs before routes.
    app.add_middleware(OriginGuard, origins=origins)
    app.add_middleware(_DynamicCORS, origins=origins, allow_credentials=True,
                       allow_methods=["*"], allow_headers=["*"])
    return static
