"""Saved prompts: one JSON list in the user data folder (`prompt_library.json`).

Entries are ``{id, name, type, content, created_at}``. Three types share the
file: ``generation`` (prompts in the generation blocks) and ``system`` /
``user`` (the Prompt Writer). The library starts empty; nothing is imported
from another app.

Writes are atomic (a temp file in the same folder, then ``os.replace``), so a
crash cannot truncate the library. A file that is not a JSON list is reported
as corrupt and never overwritten: the user fixes or moves it first.
"""
from __future__ import annotations

import json
import os
import secrets
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend import config

PROMPT_TYPES = ("generation", "system", "user")
MAX_NAME_LENGTH = 120
MAX_CONTENT_LENGTH = 20_000

_TYPE_NOUN = {"generation": "generation prompt", "system": "system prompt", "user": "user prompt"}
_lock = threading.Lock()


class LibraryError(Exception):
    """A request the library refuses. ``kind`` maps to the HTTP status."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


def _path() -> Path:
    # Read at call time so tests (and a changed data folder) take effect.
    return Path(config.PROMPT_LIBRARY_PATH)


def _corrupt() -> LibraryError:
    return LibraryError(
        "corrupt",
        f"The prompt library file ({_path().name}) in the BlockFlow data folder is not a valid list of prompts, "
        "so it was left untouched and nothing was saved. Fix or move the file, then try again.",
    )


def _read_raw() -> list[Any]:
    path = _path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise _corrupt() from None
    if not isinstance(data, list):
        raise _corrupt()
    return data


def _is_entry(item: Any) -> bool:
    return (
        isinstance(item, dict)
        and isinstance(item.get("id"), str)
        and isinstance(item.get("name"), str)
        and isinstance(item.get("content"), str)
        and item.get("type") in PROMPT_TYPES
    )


def _write(items: list[Any]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(items, indent=2, ensure_ascii=False) + "\n"
    fd, tmp = tempfile.mkstemp(prefix=".prompt_library.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise LibraryError(
            "write_failed",
            "Could not write the prompt library file, so nothing was saved. Check that the data folder is writable and has free space.",
        ) from None


def list_prompts() -> list[dict[str, Any]]:
    """Well-formed entries, in saved order. Others stay in the file untouched."""
    with _lock:
        return [item for item in _read_raw() if _is_entry(item)]


def _validated(payload: Any) -> tuple[str, str, str]:
    if not isinstance(payload, dict):
        raise LibraryError("validation", "Send the prompt as a JSON object with name, type and content.")
    ptype = payload.get("type")
    if ptype not in PROMPT_TYPES:
        raise LibraryError("validation", "The type must be generation, system or user.")
    name = payload.get("name")
    if not isinstance(name, str) or not name.strip():
        raise LibraryError("validation", "Give the saved prompt a name.")
    name = name.strip()
    if len(name) > MAX_NAME_LENGTH:
        raise LibraryError("validation", f"The name is too long: use at most {MAX_NAME_LENGTH} characters.")
    content = payload.get("content")
    if not isinstance(content, str) or not content.strip():
        raise LibraryError("validation", "The prompt is empty: write it first, then save it.")
    if len(content) > MAX_CONTENT_LENGTH:
        raise LibraryError(
            "validation", f"The prompt is too long to save: at most {MAX_CONTENT_LENGTH:,} characters."
        )
    return name, ptype, content


def add_prompt(payload: Any) -> dict[str, Any]:
    name, ptype, content = _validated(payload)
    with _lock:
        items = _read_raw()
        folded = name.casefold()
        for item in items:
            if _is_entry(item) and item["type"] == ptype and item["name"].strip().casefold() == folded:
                raise LibraryError(
                    "duplicate",
                    f'A saved {_TYPE_NOUN[ptype]} named "{item["name"]}" already exists. Choose another name.',
                )
        prompt: dict[str, Any] = {
            "id": f"prompt-{int(time.time())}-{secrets.token_hex(4)}",
            "name": name,
            "type": ptype,
            "content": content,
            "created_at": datetime.now(tz=timezone.utc).isoformat(),
        }
        _write([*items, prompt])
    return prompt


def delete_prompt(prompt_id: str) -> None:
    with _lock:
        items = _read_raw()
        kept = [item for item in items if not (isinstance(item, dict) and item.get("id") == prompt_id)]
        if len(kept) == len(items):
            raise LibraryError("not_found", "That saved prompt no longer exists. It may have been deleted already.")
        _write(kept)
