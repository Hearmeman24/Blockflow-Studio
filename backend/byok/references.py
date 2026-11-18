"""Reference resolution (sandboxed to the output directory) and reference health.

A reference may carry a ``local`` value (an app ``/outputs/...`` URL path, or a
path under the output directory) and/or a remote ``url``. The local file is the
durable copy; remote URLs (tmpfiles, provider uploads, signed CDN links) expire.

Public API:

- ``resolve_local(value) -> Path``: the resolved file path, or ``UnsafePathError``
  for anything that escapes the output directory (``..``, symlinks out,
  absolute paths elsewhere, URLs with a scheme). Existence is not checked.
- ``local_file(value) -> Path | None``: the resolved path if it is a regular file.
- ``check_references(refs, transport=None) -> list[{index, status, detail}]``.
  Status is one of ``STATUSES``: ``ok`` (local file present, or URL answered
  2xx), ``missing_local``, ``expired`` (401/403/404/410), ``unreachable``
  (network error, timeout, 5xx), ``unchecked`` (a provider-side
  ``asset://`` reference, which cannot be probed), ``malformed`` (anything
  else: not http(s), not an asset ref, or a local path outside the output dir).
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote, urlsplit

from backend.byok.http import USER_AGENT, Transport, UrllibTransport

OUTPUTS_PREFIX = "/outputs/"
PROBE_TIMEOUT_S = 5.0
PROBE_WORKERS = 8
ASSET_PREFIX = "asset://"
STATUSES = ("ok", "missing_local", "unreachable", "expired", "malformed", "unchecked")

# Injectable default transport for probes (tests set this or pass ``transport``).
probe_transport: Transport | None = None

_EXPIRED = frozenset({401, 403, 404, 410})
# HEAD answers that mean "HEAD is not allowed here" (403 covers signed GET-only URLs).
_HEAD_REFUSED = frozenset({403, 405, 501})
_WINDOWS_DRIVE_RE = re.compile(r"^[A-Za-z]:[\\/]")


class UnsafePathError(ValueError):
    """A local reference that is malformed or points outside the output directory."""


def output_root() -> Path:
    """The output folder new files go to (resolved now, never cached)."""
    from backend import output_folder

    return output_folder.current()


def _roots() -> list[Path]:
    from backend import output_folder

    return output_folder.search_roots()


def _has_scheme(value: str) -> bool:
    if _WINDOWS_DRIVE_RE.match(value):
        return False
    return bool(urlsplit(value).scheme)


def is_local_value(value: Any) -> bool:
    """True when ``value`` looks like a local path rather than a URL."""
    return isinstance(value, str) and bool(value.strip()) and not _has_scheme(value.strip())


def resolve_local(value: str, root: Path | None = None) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise UnsafePathError("The reference has no local path.")
    text = value.strip()
    if "\x00" in text:
        raise UnsafePathError("The local path contains an invalid character.")
    if _has_scheme(text):
        raise UnsafePathError("The local path must be an /outputs/ path, not a URL.")
    if root is None:
        # The current output folder first, then earlier ones: the first folder
        # that has the file wins; otherwise the path in the current folder.
        fallback: Path | None = None
        error: UnsafePathError | None = None
        for folder in _roots():
            try:
                path = resolve_local(text, folder)
            except UnsafePathError as exc:
                error = error or exc
                continue
            if path.is_file():
                return path
            if fallback is None:
                fallback = path  # current folder when it is inside it, else the first that contains it
        if fallback is not None:
            return fallback
        raise error or UnsafePathError("The local path is outside the BlockFlow output folder.")
    base = root.resolve()
    if text.startswith(OUTPUTS_PREFIX):
        rel = unquote(text[len(OUTPUTS_PREFIX):].split("?", 1)[0].split("#", 1)[0])
        if "\x00" in rel:
            raise UnsafePathError("The local path contains an invalid character.")
        candidate = base / rel
    else:
        path = Path(text)
        candidate = path if path.is_absolute() else base / path
    try:
        resolved = candidate.resolve(strict=False)
    except (OSError, RuntimeError) as exc:  # symlink loops
        raise UnsafePathError("The local path could not be resolved.") from exc
    if resolved == base or not resolved.is_relative_to(base):
        raise UnsafePathError("The local path is outside the BlockFlow output folder.")
    return resolved


def local_file(value: str, root: Path | None = None) -> Path | None:
    try:
        path = resolve_local(value, root)
    except UnsafePathError:
        return None
    return path if path.is_file() else None


def is_http_url(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text or any(c.isspace() for c in text):
        return False
    try:
        parts = urlsplit(text)
        host = parts.hostname
    except ValueError:
        return False
    return parts.scheme.lower() in ("http", "https") and bool(host)


def is_asset_ref(value: Any) -> bool:
    """A provider-side ``asset://<id>`` reference (e.g. a private asset library entry)."""
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text.lower().startswith(ASSET_PREFIX):
        return False
    rest = text[len(ASSET_PREFIX):]
    return bool(rest) and not any(c.isspace() for c in rest)


def display_url(url: str) -> str:
    """Host plus file name, without the query string (signed URLs carry secrets there)."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return "the URL"
    name = PurePosixPath(parts.path).name
    return f"{parts.hostname}/{name}" if name else str(parts.hostname)


def _result(index: int, status: str, detail: str) -> dict[str, Any]:
    return {"index": index, "status": status, "detail": detail}


def probe_url(url: str, transport: Transport) -> tuple[str, str]:
    """(status, detail) for one http(s) URL."""
    shown = display_url(url)
    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    try:
        resp = transport("HEAD", url, headers, None, PROBE_TIMEOUT_S)
        code = resp.status
        if code in _HEAD_REFUSED:
            resp = transport("GET", url, {**headers, "Range": "bytes=0-0"}, None, PROBE_TIMEOUT_S)
            code = resp.status
    except Exception as exc:  # noqa: BLE001 - every transport failure means "unreachable"
        kind = getattr(exc, "kind", None) or type(exc).__name__
        return "unreachable", f"Could not reach {shown} ({kind}). Check the connection or re-add the file."
    if 200 <= code < 300 or code == 416:
        return "ok", f"{shown} is reachable."
    if code in _EXPIRED:
        return "expired", f"{shown} answered HTTP {code}; the link has expired or is private. Re-add the file."
    return "unreachable", f"{shown} answered HTTP {code}. Try again later or re-add the file."


def _check_one(index: int, ref: Any, transport: Transport) -> dict[str, Any]:
    if not isinstance(ref, Mapping):
        return _result(index, "malformed", "The reference is not an object.")
    local, url = ref.get("local"), ref.get("url")
    missing_local: str | None = None

    local_candidates = [v for v in (local, url) if is_local_value(v)]
    if local is not None and not is_local_value(local):
        return _result(index, "malformed", "The local value must be an /outputs/ path.")
    for value in local_candidates:
        try:
            path = resolve_local(value)
        except UnsafePathError as exc:
            return _result(index, "malformed", str(exc))
        if path.is_file():
            return _result(index, "ok", f"Local file {path.name} is available.")
        missing_local = path.name

    if url is not None and not is_local_value(url):
        if is_asset_ref(url):
            detail = "Provider asset reference, not verified: BlockFlow cannot probe provider-side assets."
            if missing_local:
                detail = f"The local copy {missing_local} is missing. {detail}"
            return _result(index, "unchecked", detail)
        if not is_http_url(url):
            return _result(index, "malformed", "The URL must be a valid http:// or https:// address.")
        status, detail = probe_url(url.strip(), transport)
        if status == "ok" and missing_local:
            detail = f"The local copy {missing_local} is missing; using the remote URL. {detail}"
        return _result(index, status, detail)

    if missing_local:
        return _result(index, "missing_local",
                       f"The local file {missing_local} no longer exists. Re-add the file.")
    return _result(index, "malformed", "The reference has no file or URL.")


def check_references(refs: Sequence[Any], *, transport: Transport | None = None) -> list[dict[str, Any]]:
    refs = list(refs or [])
    if not refs:
        return []
    transport = transport or probe_transport or UrllibTransport()
    with ThreadPoolExecutor(max_workers=min(PROBE_WORKERS, len(refs))) as pool:
        return list(pool.map(lambda pair: _check_one(pair[0], pair[1], transport), enumerate(refs)))
