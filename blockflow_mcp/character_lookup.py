"""Read characters from the backend (``GET /api/characters``) and find one.

Shared by the character tools and the ``character`` reference source. It
imports nothing from either, so neither import cycles back. A character is the
backend's JSON object: ``{id, name, description, default_face_id,
default_audio_id, media: [{id, kind, label, local, size_bytes, width, height,
duration_s, ...}]}``.
"""

import re
from collections.abc import Mapping
from typing import Any

from blockflow_mcp.client import BackendClient, ToolFailure, checked

KINDS = ("image", "video", "audio")
DEFAULT_FIELDS = {"image": "default_face_id", "audio": "default_audio_id"}
MAX_LISTED = 20
OUTPUTS_PREFIX = "/outputs/"
_CHAR_ID_RE = re.compile(r"^char_[0-9a-f]{32}$")
_MEDIA_ID_RE = re.compile(r"^media_[0-9a-f]{32}$")
_METADATA = ("size_bytes", "width", "height", "duration_s")


def fetch_characters(client: BackendClient, cache: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Every character, read once per ``cache`` (pass one dict per tool call)."""
    if cache is not None and "characters" in cache:
        return cache["characters"]
    status, body = client.get("/api/characters")
    body = checked(status, body, "Reading the characters")
    found = body.get("characters")
    if not isinstance(found, list) or not all(isinstance(c, Mapping) for c in found):
        raise ToolFailure("backend", "BlockFlow answered the characters request with a reply this server does "
                                     "not understand.")
    characters = [dict(c) for c in found]
    if cache is not None:
        cache["characters"] = characters
    return characters


def _norm(text: str) -> str:
    return text.strip().casefold()


def _available(characters: list[dict[str, Any]]) -> str:
    if not characters:
        return "There are no characters yet; create one on the app's Characters page."
    names = [str(c.get("name")) for c in characters[:MAX_LISTED]]
    more = len(characters) - len(names)
    return "Available: " + ", ".join(names) + (f" (and {more} more; list_characters shows all)." if more > 0 else ".")


def find_character(client: BackendClient, value: Any, cache: dict[str, Any] | None = None) -> dict[str, Any]:
    """The backend character for an id (``char_<32 hex>``) or a name (exact,
    case-insensitive, surrounding space ignored)."""
    if not isinstance(value, str) or not value.strip():
        raise ToolFailure("invalid_character", "'character' must be a character id (char_...) or a name, "
                                               "as list_characters shows them.")
    text = value.strip()
    characters = fetch_characters(client, cache)
    if _CHAR_ID_RE.match(text):
        for c in characters:
            if c.get("id") == text:
                return c
    wanted = _norm(text)
    matches = [c for c in characters if isinstance(c.get("name"), str) and _norm(c["name"]) == wanted]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        ids = [str(c.get("id")) for c in matches]
        raise ToolFailure("ambiguous_character", f"{len(matches)} characters are named {text!r}: "
                                                 f"{', '.join(ids)}. Pass the id of the one you mean.",
                          candidates=ids)
    raise ToolFailure("unknown_character", f"No character matches {text!r}. {_available(characters)}",
                      available=[str(c.get("name")) for c in characters[:MAX_LISTED]])


def media_of(character: Mapping[str, Any], kind: str | None = None) -> list[dict[str, Any]]:
    files = [m for m in character.get("media") or [] if isinstance(m, Mapping)]
    return [dict(m) for m in files if kind is None or m.get("kind") == kind]


def default_media(character: Mapping[str, Any], kind: str) -> dict[str, Any] | None:
    """The default face (image) or default audio clip, None when unset or stale."""
    default_id = character.get(DEFAULT_FIELDS[kind]) if kind in DEFAULT_FIELDS else None
    if not default_id:
        return None
    return next((m for m in media_of(character, kind) if m.get("id") == default_id), None)


def app_path(file: Mapping[str, Any]) -> str:
    """The file's ``/outputs/...`` app path, exactly as the backend returned it."""
    path = file.get("local")
    if not isinstance(path, str) or not path.startswith(OUTPUTS_PREFIX):
        raise ToolFailure("backend", f"BlockFlow returned an unexpected path for {file.get('label')!r}; "
                                     "expected an /outputs/... app path.")
    return path


def metadata(file: Mapping[str, Any]) -> dict[str, Any]:
    """The size, dimensions and duration the character record has (non-null only)."""
    return {k: file[k] for k in _METADATA if file.get(k) is not None}


def find_media(character: Mapping[str, Any], kind: str, value: Any) -> dict[str, Any]:
    """A file of ``kind`` belonging to ``character``, by media id or label
    (exact first, then case-insensitive)."""
    name = character.get("name")
    if not isinstance(value, str) or not value.strip():
        raise ToolFailure("invalid_reference", "'media' must be a media id (media_...) or a file label.")
    text = value.strip()
    every = media_of(character)
    if _MEDIA_ID_RE.match(text):
        hit = next((m for m in every if m.get("id") == text), None)
        if hit is not None:
            if hit.get("kind") != kind:
                raise ToolFailure("wrong_media_kind", f"{text} is a {hit.get('kind')} file of {name}, not a {kind}.")
            return hit
    same_kind = [m for m in every if m.get("kind") == kind]
    exact = [m for m in same_kind if m.get("label") == text]
    loose = exact or [m for m in same_kind if isinstance(m.get("label"), str) and _norm(m["label"]) == _norm(text)]
    if len(loose) == 1:
        return loose[0]
    if len(loose) > 1:
        listed = ", ".join(f"{m.get('label')} ({m.get('id')})" for m in loose)
        raise ToolFailure("ambiguous_media", f"{len(loose)} {kind} files of {name} are named {text!r}: {listed}. "
                                             "Pass the media id of the one you mean.",
                          candidates=[m.get("id") for m in loose])
    other = [m for m in every if m.get("kind") != kind and isinstance(m.get("label"), str)
             and _norm(m["label"]) == _norm(text)]
    if other:
        raise ToolFailure("wrong_media_kind", f"{text!r} is a {other[0].get('kind')} file of {name}, not a {kind}. "
                                              f"{describe_files(character, kind)}")
    raise ToolFailure("unknown_media", f"{name} has no {kind} file {text!r}. {describe_files(character, kind)}")


def describe_files(character: Mapping[str, Any], kind: str) -> str:
    files = media_of(character, kind)
    if not files:
        return f"{character.get('name')} has no {kind} files."
    listed = ", ".join(f"{m.get('label')} ({m.get('id')})" for m in files)
    return f"{character.get('name')}'s {kind} files: {listed}."
