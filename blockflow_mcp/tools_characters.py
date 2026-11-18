"""Tool group: characters (GET /api/characters). Read-only.

A character is a named set of image, video and audio files, kept on the
app's Characters page. These tools list and read them; `generate` takes their
files through the `character` reference form (see `references.py`).
"""

from typing import Any

from blockflow_mcp import character_lookup as lookup
from blockflow_mcp.client import get_client, tool


def _file_ref(file: dict[str, Any]) -> dict[str, Any]:
    return {"id": file.get("id"), "label": file.get("label"), "path": lookup.app_path(file)}


def _summary(character: dict[str, Any]) -> dict[str, Any]:
    face = lookup.default_media(character, "image")
    audio = lookup.default_media(character, "audio")
    return {
        "id": character.get("id"),
        "name": character.get("name"),
        "description": character.get("description") or "",
        "counts": {kind: len(lookup.media_of(character, kind)) for kind in lookup.KINDS},
        "default_face": _file_ref(face) if face else None,
        "default_audio": _file_ref(audio) if audio else None,
    }


def _file(file: dict[str, Any], default_id: Any) -> dict[str, Any]:
    return {"id": file.get("id"), "kind": file.get("kind"), "label": file.get("label"),
            "path": lookup.app_path(file), "size_bytes": file.get("size_bytes"), "width": file.get("width"),
            "height": file.get("height"), "duration_s": file.get("duration_s"),
            "is_default": bool(default_id) and file.get("id") == default_id}


@tool(read_only=True)
def list_characters() -> dict[str, Any]:
    """List the characters saved in BlockFlow (read-only).

    A character is a named person or subject with reference files: images (one
    is the default face), videos and audio clips (one is the default audio,
    e.g. the character's voice). They are created and edited on the app's
    Characters page, not here.

    Each entry has `id` (char_...), `name`, `description`, `counts` per kind
    (`image`, `video`, `audio`), and the `default_face` / `default_audio`
    ({id, label, path}) or null. `path` is the file's /outputs/... app path.

    Use a character in `generate` references by name or id:
    {kind: "image", character: "Mia"} (default face),
    {kind: "audio", character: "Mia"} (default audio),
    {kind: "video" | "audio" | "image", character: "Mia", media: "<label or id>"}.
    Audio is sent to the model as audio; the prompt says what to do with it.
    Next step: `get_character` for every file of one character."""
    return {"ok": True, "characters": [_summary(c) for c in lookup.fetch_characters(get_client())]}


@tool(read_only=True)
def get_character(character: str) -> dict[str, Any]:
    """Read one character with all its files (read-only).

    `character` is a character id (char_...) or its name (case-insensitive,
    surrounding space ignored). Characters are created and edited on the app's
    Characters page; these tools never change them.

    Returns `character`: `id`, `name`, `description`, `created_at`,
    `updated_at`, `default_face_id`, `default_audio_id` and `references`, the
    files per kind (`image`, `video`, `audio`) in the character's order. Each
    file has `id` (media_...), `kind`, `label`, `path` (its /outputs/... app
    path), `size_bytes`, `width`, `height`, `duration_s` (null when unknown)
    and `is_default` (the default face or default audio).

    Pass a file to `generate` as a reference with the character and the file's
    label or id:
    {kind: "image", character: "Mia", media: "side view.png"},
    {kind: "video", character: "Mia", media: "media_..."}.
    Without `media`, an image is the default face and an audio the default
    audio; video needs `media`."""
    found = lookup.find_character(get_client(), character)
    references: dict[str, list[dict[str, Any]]] = {}
    for kind in lookup.KINDS:
        field = lookup.DEFAULT_FIELDS.get(kind)
        default_id = found.get(field) if field else None
        references[kind] = [_file(f, default_id) for f in lookup.media_of(found, kind)]
    return {"ok": True, "character": {
        "id": found.get("id"), "name": found.get("name"), "description": found.get("description") or "",
        "created_at": found.get("created_at"), "updated_at": found.get("updated_at"),
        "default_face_id": found.get("default_face_id"), "default_audio_id": found.get("default_audio_id"),
        "references": references}}


TOOLS = [list_characters, get_character]
