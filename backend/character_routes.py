"""HTTP API for characters (`/api/characters*`). Logic lives in backend.characters."""
from __future__ import annotations

from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from backend import characters

router = APIRouter()

NAME_AND_FACE_REQUIRED = "A character needs a name and a face image."


def _err(message: str, status: int) -> JSONResponse:
    return JSONResponse({"ok": False, "error": message}, status_code=status)


def _from_exc(exc: characters.CharacterError) -> JSONResponse:
    status = 404 if isinstance(exc, characters.NotFoundError) else 422
    return _err(str(exc), status)


async def _json_object(request: Request) -> dict[str, Any] | None:
    try:
        body = await request.json()
    except Exception:
        return None
    return body if isinstance(body, dict) else None


def decode_filename(raw: str | None) -> str:
    """X-Filename may be raw UTF-8 (read as latin-1 by the server) or percent-encoded."""
    if not raw:
        return ""
    text = raw
    try:
        text = text.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass
    if "%" in text:
        text = unquote(text, errors="replace")
    return text


@router.get("/api/characters")
def list_characters() -> JSONResponse:
    return JSONResponse({"ok": True, "characters": characters.list_characters()})


@router.post("/api/characters")
async def create_character(request: Request) -> JSONResponse:
    """`POST /api/characters?name=&width=&height=`: the face image is the raw
    body and its file name the `X-Filename` header. A character cannot exist
    without a name and a face, so the old JSON body is refused."""
    params = request.query_params
    body = await request.body()
    if body and request.headers.get("content-type", "").lower().startswith("application/json"):
        return _err(NAME_AND_FACE_REQUIRED, 422)
    try:
        name = characters.clean_name(params.get("name") or "")
    except characters.CharacterError as exc:
        return _from_exc(exc)
    if not body:
        return _err("A character needs a face image.", 400)
    try:
        character = characters.create_character_with_face(
            name,
            filename=decode_filename(request.headers.get("X-Filename")),
            data=body,
            width=params.get("width"),
            height=params.get("height"),
        )
    except characters.CharacterError as exc:
        return _from_exc(exc)
    except OSError as exc:
        return _err(f"The file could not be saved: {exc.strerror or 'disk error'}.", 500)
    return JSONResponse({"ok": True, "character": character})


@router.get("/api/characters/{character_id}")
def get_character(character_id: str) -> JSONResponse:
    try:
        return JSONResponse({"ok": True, "character": characters.get_character(character_id)})
    except characters.CharacterError as exc:
        return _from_exc(exc)


@router.patch("/api/characters/{character_id}")
async def patch_character(character_id: str, request: Request) -> JSONResponse:
    body = await _json_object(request)
    if body is None:
        return _err("Request body must be a JSON object.", 422)
    fields = {
        k: body[k]
        for k in ("name", "description", "default_face_id", "default_audio_id")
        if k in body
    }
    if "description" in fields and fields["description"] is None:
        fields["description"] = ""
    try:
        character = characters.update_character(character_id, **fields)
    except characters.CharacterError as exc:
        return _from_exc(exc)
    return JSONResponse({"ok": True, "character": character})


@router.delete("/api/characters/{character_id}")
def delete_character(character_id: str) -> JSONResponse:
    try:
        characters.delete_character(character_id)
    except characters.CharacterError as exc:
        return _from_exc(exc)
    return JSONResponse({"ok": True})


@router.post("/api/characters/{character_id}/media")
async def upload_media(character_id: str, request: Request) -> JSONResponse:
    params = request.query_params
    try:
        characters.get_character(character_id)
    except characters.CharacterError as exc:
        return _from_exc(exc)
    kind = characters.canonical_kind(params.get("kind"))  # "voice" is audio
    if kind not in characters.KINDS:
        return _err(characters.KINDS_MESSAGE, 422)
    body = await request.body()
    if not body:
        return _err("The file is empty.", 400)
    filename = decode_filename(request.headers.get("X-Filename"))
    try:
        media, character = characters.add_media(
            character_id,
            kind=kind,
            filename=filename,
            data=body,
            width=params.get("width"),
            height=params.get("height"),
            duration_s=params.get("duration_s"),
        )
    except characters.CharacterError as exc:
        return _from_exc(exc)
    except OSError as exc:
        return _err(f"The file could not be saved: {exc.strerror or 'disk error'}.", 500)
    return JSONResponse({"ok": True, "media": media, "character": character})


@router.put("/api/characters/{character_id}/media/order")
async def reorder_media(character_id: str, request: Request) -> JSONResponse:
    body = await _json_object(request)
    if body is None:
        return _err("Request body must be a JSON object.", 422)
    try:
        character = characters.reorder_media(character_id, body.get("kind"), body.get("ids"))
    except characters.CharacterError as exc:
        return _from_exc(exc)
    return JSONResponse({"ok": True, "character": character})


@router.delete("/api/characters/{character_id}/media/{media_id}")
def delete_media(character_id: str, media_id: str) -> JSONResponse:
    try:
        character = characters.delete_media(character_id, media_id)
    except characters.CharacterError as exc:
        return _from_exc(exc)
    return JSONResponse({"ok": True, "character": character})
