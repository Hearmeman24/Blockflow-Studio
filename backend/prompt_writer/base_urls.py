"""Base URLs of the local LLM servers, stored as app prefs.

A URL must be ``http``/``https`` with a host, no user name or password, no
query and no fragment. A trailing slash is removed and the scheme and host
are lowercased. An empty pref means "use the default". A stored value that
fails validation is never used.
"""
from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit

DEFAULT_BASE_URLS: dict[str, str] = {
    "ollama": "http://localhost:11434",
    "lmstudio": "http://localhost:1234",
}
PREF_NAMES: dict[str, str] = {
    "ollama": "ollama_base_url",
    "lmstudio": "lmstudio_base_url",
}
MAX_URL_LENGTH = 2048


class InvalidBaseUrl(ValueError):
    """The message is safe to show: it never contains the submitted value."""


def validate_base_url(raw: str) -> str:
    value = raw.strip()
    if len(value) > MAX_URL_LENGTH:
        raise InvalidBaseUrl(f"The URL is too long (at most {MAX_URL_LENGTH} characters).")
    if any(ch.isspace() for ch in value):
        raise InvalidBaseUrl("The URL must not contain spaces.")
    if not value.isascii() or any(ord(ch) < 0x21 or ord(ch) == 0x7F for ch in value):
        raise InvalidBaseUrl("The URL must use plain ASCII characters.")
    try:
        parts = urlsplit(value)
    except ValueError:
        raise InvalidBaseUrl("The URL could not be read. Use the form http://localhost:11434.") from None
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https") or not value.lower().startswith(f"{scheme}://"):
        raise InvalidBaseUrl("The URL must start with http:// or https://.")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise InvalidBaseUrl("The URL must not contain a user name or password.")
    if parts.query or value.rstrip("/").endswith("?") or "?" in value:
        raise InvalidBaseUrl("The URL must not contain a query (?...).")
    if parts.fragment or "#" in value:
        raise InvalidBaseUrl("The URL must not contain a fragment (#...).")
    try:
        host = parts.hostname
        port = parts.port
    except ValueError:
        raise InvalidBaseUrl("The URL has an invalid port.") from None
    if not host:
        raise InvalidBaseUrl("The URL needs a host, for example http://localhost:11434.")
    netloc = parts.netloc.lower()
    if port is not None and not (1 <= port <= 65535):
        raise InvalidBaseUrl("The URL has an invalid port.")
    path = parts.path.rstrip("/")
    return urlunsplit((scheme, netloc, path, "", ""))


def resolve_base_url(provider: str, stored: str | None) -> tuple[str | None, str | None]:
    """``(url, None)`` to use, or ``(None, message)`` when the pref is invalid."""
    if stored is None or not stored.strip():
        return DEFAULT_BASE_URLS[provider], None
    try:
        return validate_base_url(stored), None
    except InvalidBaseUrl as exc:
        return None, str(exc)
