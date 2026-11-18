"""The one HTTP client every tool group uses, plus the shared result helpers.

The MCP server only talks to the local BlockFlow backend (``BLOCKFLOW_URL``,
default ``http://127.0.0.1:47301``). It never reads, holds or sends a provider
key: the backend owns them.

Tests replace the process-wide client with ``set_client(BackendClient(...,
transport=fake))``; nothing here needs FastMCP.
"""

import functools
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from typing import Any

DEFAULT_URL = "http://127.0.0.1:47301"
URL_ENV = "BLOCKFLOW_URL"
DEFAULT_TIMEOUT_S = 60.0
USER_AGENT = "blockflow-mcp"

# (method, url, headers, body, timeout) -> (status, body bytes)
Transport = Callable[[str, str, dict[str, str], bytes | None, float], tuple[int, bytes]]


class BackendError(Exception):
    """A request the backend could not answer usefully (not running, bad reply)."""

    def __init__(self, kind: str, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.kind, self.message, self.status = kind, message, status


def urllib_transport(method: str, url: str, headers: dict[str, str], body: bytes | None,
                     timeout: float) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:  # noqa: S310 - local backend URL
            return resp.status, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


class BackendClient:
    def __init__(self, base_url: str | None = None, transport: Transport | None = None,
                 timeout: float = DEFAULT_TIMEOUT_S) -> None:
        self.base_url = (base_url or os.environ.get(URL_ENV) or DEFAULT_URL).rstrip("/")
        self.transport = transport or urllib_transport
        self.timeout = timeout

    def request(self, method: str, path: str, *, params: Mapping[str, Any] | None = None, json_body: Any = None,
                data: bytes | None = None, headers: Mapping[str, str] | None = None,
                timeout: float | None = None) -> tuple[int, Any]:
        """(status, parsed JSON body). Raises BackendError when the backend is
        unreachable or does not answer with JSON."""
        url = self.base_url + path
        if params:
            query = {k: v for k, v in params.items() if v is not None and v != ""}
            if query:
                url += "?" + urllib.parse.urlencode(query, doseq=True)
        sent_headers = {"Accept": "application/json", "User-Agent": USER_AGENT, **(headers or {})}
        body = data
        if json_body is not None:
            body = json.dumps(json_body).encode("utf-8")
            sent_headers["Content-Type"] = "application/json"
        try:
            status, raw = self.transport(method, url, sent_headers, body, timeout or self.timeout)
        except BackendError:
            raise
        except (OSError, ValueError) as exc:
            raise BackendError("backend_unreachable", unreachable_message(self.base_url, exc)) from None
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise BackendError("bad_response", f"BlockFlow answered {method} {path} with HTTP {status} and a body "
                                               "that is not JSON.", status) from None
        return status, parsed

    def get(self, path: str, **kw: Any) -> tuple[int, Any]:
        return self.request("GET", path, **kw)

    def post(self, path: str, **kw: Any) -> tuple[int, Any]:
        return self.request("POST", path, **kw)


def unreachable_message(base_url: str, exc: BaseException) -> str:
    return (f"BlockFlow Studio is not reachable at {base_url} ({type(exc).__name__}). Start the app with "
            f"`uv run app.py` in the repository folder, or set {URL_ENV} to where it runs.")


_client: BackendClient | None = None


def get_client() -> BackendClient:
    global _client
    if _client is None:
        _client = BackendClient()
    return _client


def set_client(client: BackendClient | None) -> None:
    """Replace the process-wide client (tests); None resets to the default."""
    global _client
    _client = client


# ------------------------------------------------------------------ results


def error(kind: str, message: str, **details: Any) -> dict[str, Any]:
    """A structured failure: ``{"ok": False, "error": {"kind", "message", ...}}``."""
    return {"ok": False, "error": {"kind": kind, "message": message, **details}}


class ToolFailure(Exception):
    """Raise inside a tool to return ``error(kind, message, **details)``."""

    def __init__(self, kind: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.result = error(kind, message, **details)


# Same rule as backend/job_store.py: a key whose last name segment is a secret word.
_SECRET_KEY_RE = re.compile(r"(^|_)(key|token|secret|authorization|password)$")


def _is_secret_name(name: str) -> bool:
    name = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", name))
    return bool(_SECRET_KEY_RE.search(re.sub(r"[-\s]", "_", name.lower())))


def scrub(value: Any) -> Any:
    """Deep copy without secret-named keys: no key ever reaches tool output.
    The bare name ``key`` is kept: it names a setting in the catalog."""
    if isinstance(value, Mapping):
        return {k: scrub(v) for k, v in value.items()
                if not (isinstance(k, str) and k != "key" and _is_secret_name(k))}
    if isinstance(value, (list, tuple)):
        return [scrub(v) for v in value]
    return value


def tool(*, read_only: bool, spends: bool = False) -> Callable[[Callable[..., dict[str, Any]]], Callable[..., dict[str, Any]]]:
    """Mark a tool function and turn failures into structured results.

    ``read_only`` / ``spends`` become the MCP tool annotations."""

    def decorate(fn: Callable[..., dict[str, Any]]) -> Callable[..., dict[str, Any]]:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> dict[str, Any]:
            try:
                return scrub(fn(*args, **kwargs))
            except ToolFailure as failure:
                return scrub(failure.result)
            except BackendError as err:
                return error(err.kind, err.message, **({"status": err.status} if err.status else {}))
            except Exception as exc:  # noqa: BLE001 - a tool answers, it never dumps a traceback
                return error("internal", f"The MCP server hit an unexpected error: {type(exc).__name__}: {exc}")

        wrapper.mcp_annotations = {  # type: ignore[attr-defined]
            "readOnlyHint": read_only,
            "destructiveHint": False,
            "idempotentHint": read_only,
            "openWorldHint": spends,
        }
        return wrapper

    return decorate


def backend_failure(status: int, body: Any, what: str) -> ToolFailure:
    """A ToolFailure from a backend error reply ({ok: false, error, kind, issues} or FastAPI {detail})."""
    body = body if isinstance(body, Mapping) else {}
    message = body.get("error") or body.get("message") or body.get("detail") or f"{what} failed (HTTP {status})."
    if not isinstance(message, str):
        message = json.dumps(message)
    details: dict[str, Any] = {"status": status}
    if body.get("issues"):
        details["issues"] = body["issues"]
    kind = body.get("kind") if isinstance(body.get("kind"), str) else ("not_found" if status == 404 else "backend")
    return ToolFailure(kind, message, **details)


def checked(status: int, body: Any, what: str) -> dict[str, Any]:
    """The body of a successful backend reply, else raise its ToolFailure."""
    if status >= 400 or not isinstance(body, Mapping) or body.get("ok") is False:
        raise backend_failure(status, body, what)
    return dict(body)
