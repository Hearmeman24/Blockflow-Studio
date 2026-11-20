"""Character store: named characters with image, video and audio files.

Rows live in the app database (`backend.db.DB_PATH`, resolved at call time).
Files live under `<output folder>/characters/<character_id>/` (the folder in
effect when they were added) so the `/outputs` route and `backend.byok.references.resolve_local` work on
them unchanged. Ids are validated against strict patterns before any path is
built, and stored file names never contain a path separator.

Sound is one kind, audio. A character has a default face (an image) and a
default audio clip. ``kind=voice`` from old clients is read as audio, and a
database from before the merge is migrated on first use (``_migrate``).
"""
from __future__ import annotations

import math
import re
import shutil
import sqlite3
import threading
import time
import unicodedata
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote

from backend import config, db, upload_stream

KINDS: tuple[str, ...] = ("image", "video", "audio")
# Old clients may still say ``voice``; it is the same kind as audio.
KIND_ALIASES: dict[str, str] = {"voice": "audio"}
KINDS_MESSAGE = "Kind must be one of image, video or audio."
ALLOWED_EXTENSIONS: dict[str, frozenset[str]] = {
    "image": frozenset({"jpg", "jpeg", "png", "webp", "bmp", "tiff", "tif", "gif", "heic", "heif"}),
    "video": frozenset({"mp4", "mov", "mkv", "webm", "m4v"}),
    "audio": frozenset({"mp3", "wav", "aac", "ogg", "flac", "m4a"}),
}
MAX_NAME_LENGTH = 80
MAX_DESCRIPTION_LENGTH = 4000
MAX_FILENAME_LENGTH = 120

_CHAR_ID_RE = re.compile(r"^char_[0-9a-f]{32}$")
_MEDIA_ID_RE = re.compile(r"^media_[0-9a-f]{32}$")
_lock = threading.RLock()


class CharacterError(Exception):
    """Base class; the message is a readable sentence."""


class NotFoundError(CharacterError):
    pass


class ValidationError(CharacterError):
    pass


# ------------------------------------------------------------------ helpers


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(db.DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


_SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS characters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        default_face_id TEXT,
        default_audio_id TEXT,
        created_at TEXT,
        updated_at TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS character_media (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        filename TEXT NOT NULL,
        size_bytes INTEGER,
        width INTEGER,
        height INTEGER,
        duration_s REAL,
        position INTEGER NOT NULL,
        created_at TEXT
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_character_media_char ON character_media(character_id)",
)


def _migrate(conn: sqlite3.Connection) -> None:
    """Bring a database from before sound became one kind up to date. Safe to
    run any number of times; touches no file on disk.

    - ``characters.default_voice_id`` is renamed ``default_audio_id`` (the
      former default voice is the default audio clip).
    - Every ``voice`` row becomes ``audio``, placed after the character's
      existing audio clips in its old order (existing audio keeps 0..n-1).
    """
    columns = {r[1] for r in conn.execute("PRAGMA table_info(characters)")}
    if "default_voice_id" in columns and "default_audio_id" not in columns:
        conn.execute("ALTER TABLE characters RENAME COLUMN default_voice_id TO default_audio_id")
    rows = conn.execute(
        "SELECT id, character_id FROM character_media WHERE kind = 'voice' ORDER BY character_id, position, rowid"
    ).fetchall()
    if not rows:
        return
    next_position: dict[str, int] = {}
    for row in rows:
        cid = row["character_id"]
        if cid not in next_position:
            next_position[cid] = conn.execute(
                "SELECT COUNT(*) FROM character_media WHERE character_id = ? AND kind = 'audio'", (cid,)
            ).fetchone()[0]
        conn.execute("UPDATE character_media SET kind = 'audio', position = ? WHERE id = ?",
                     (next_position[cid], row["id"]))
        next_position[cid] += 1


def _prepare(conn: sqlite3.Connection) -> None:
    for stmt in _SCHEMA:
        conn.execute(stmt)
    _migrate(conn)
    conn.commit()


def init_db() -> None:
    with _lock:
        conn = _conn()
        try:
            _prepare(conn)
        finally:
            conn.close()


def _open() -> sqlite3.Connection:
    """Connection with tables guaranteed and migrated (cheap; makes first use safe)."""
    conn = _conn()
    try:
        _prepare(conn)
    except BaseException:
        conn.close()
        raise
    return conn


def canonical_kind(kind: Any) -> Any:
    """``kind`` with the ``voice`` alias read as ``audio``."""
    return KIND_ALIASES.get(kind, kind) if isinstance(kind, str) else kind


def _characters_root() -> Path:
    return config.output_dir() / "characters"


def _check_char_id(character_id: Any) -> str:
    if not isinstance(character_id, str) or not _CHAR_ID_RE.match(character_id):
        raise NotFoundError("Character not found.")
    return character_id


def _check_media_id(media_id: Any) -> str:
    if not isinstance(media_id, str) or not _MEDIA_ID_RE.match(media_id):
        raise NotFoundError("Media not found.")
    return media_id


def _char_dir(character_id: str) -> Path:
    _check_char_id(character_id)
    root = _characters_root().resolve()
    path = (root / character_id).resolve()
    if path.parent != root:
        raise NotFoundError("Character not found.")
    return path


def clean_name(value: Any) -> str:
    if not isinstance(value, str):
        raise ValidationError("Name must be text.")
    name = value.strip()
    if not name:
        raise ValidationError("Name is required.")
    if len(name) > MAX_NAME_LENGTH:
        raise ValidationError(f"Name must be at most {MAX_NAME_LENGTH} characters.")
    return name


def clean_description(value: Any) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValidationError("Description must be text.")
    if len(value) > MAX_DESCRIPTION_LENGTH:
        raise ValidationError(f"Description must be at most {MAX_DESCRIPTION_LENGTH} characters.")
    return value


def safe_filename(raw: Any) -> str:
    """Basename only; no separators, NUL or control characters; length capped."""
    text = raw if isinstance(raw, str) else ""
    text = text.replace("\x00", "")
    base = re.split(r"[\\/]", text)[-1]
    base = "".join(ch for ch in base if unicodedata.category(ch) not in ("Cc", "Cf", "Cs"))
    base = base.strip().lstrip(".").strip()
    if not base:
        return "file"
    if len(base) > MAX_FILENAME_LENGTH:
        stem, dot, ext = base.rpartition(".")
        if dot and 0 < len(ext) <= 16:
            keep = max(1, MAX_FILENAME_LENGTH - len(ext) - 1)
            base = f"{stem[:keep]}.{ext}"
        else:
            base = base[:MAX_FILENAME_LENGTH]
    return base


def _extension(name: str) -> str:
    return name.rpartition(".")[2].lower() if "." in name else ""


def _media_url(character_id: str, stored: str) -> str:
    return f"/outputs/characters/{character_id}/{quote(stored, safe='')}"


def _media_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "label": row["label"],
        "local": _media_url(row["character_id"], row["filename"]),
        "size_bytes": row["size_bytes"],
        "width": row["width"],
        "height": row["height"],
        "duration_s": row["duration_s"],
        "position": row["position"],
        "created_at": row["created_at"],
    }


def _load(conn: sqlite3.Connection, character_id: str) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM characters WHERE id = ?", (character_id,)).fetchone()
    if row is None:
        raise NotFoundError("Character not found.")
    media_rows = conn.execute(
        "SELECT * FROM character_media WHERE character_id = ?", (character_id,)
    ).fetchall()
    media_rows.sort(key=lambda r: (KINDS.index(r["kind"]) if r["kind"] in KINDS else 99, r["position"]))
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "default_face_id": row["default_face_id"],
        "default_audio_id": row["default_audio_id"],
        "media": [_media_dict(r) for r in media_rows],
    }


def _positive_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(num) or num <= 0:
        return None
    return num


def _positive_int(value: Any) -> int | None:
    num = _positive_number(value)
    if num is None:
        return None
    return int(round(num)) or None


# --------------------------------------------------------------- operations


def list_characters() -> list[dict[str, Any]]:
    with _lock:
        conn = _open()
        try:
            ids = [r["id"] for r in conn.execute("SELECT id FROM characters ORDER BY rowid")]
            return [_load(conn, i) for i in ids]
        finally:
            conn.close()


def get_character(character_id: str) -> dict[str, Any]:
    _check_char_id(character_id)
    with _lock:
        conn = _open()
        try:
            return _load(conn, character_id)
        finally:
            conn.close()


def create_character(name: Any, description: Any = None) -> dict[str, Any]:
    clean = clean_name(name)
    desc = clean_description(description)
    character_id = f"char_{uuid.uuid4().hex}"
    now = _now()
    with _lock:
        conn = _open()
        try:
            conn.execute(
                "INSERT INTO characters (id, name, description, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (character_id, clean, desc, now, now),
            )
            conn.commit()
            return _load(conn, character_id)
        finally:
            conn.close()


def upload_folder() -> Path:
    """Where an upload is received before ``source=`` moves it into a
    character's folder: the characters root, on the same file system."""
    root = _characters_root()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _store(dest: Path, data: bytes, source: Path | None) -> None:
    if source is not None:
        upload_stream.move_into_place(source, dest)
    else:
        dest.write_bytes(data)


def _size(data: bytes, source: Path | None) -> int:
    return source.stat().st_size if source is not None else len(data)


def create_character_with_face(
    name: Any,
    *,
    filename: Any,
    data: bytes = b"",
    source: Path | None = None,
    width: Any = None,
    height: Any = None,
) -> dict[str, Any]:
    """Create a character together with its first image, which is its default
    face. The image is ``data``, or the file ``source`` (moved into place, so a
    streamed upload is never read into memory). All or nothing: when the name
    or file is refused, or the write or the database fails, no row, file or
    folder is left behind."""
    clean = clean_name(name)
    size = _size(data, source)
    if not size:
        raise ValidationError("A character needs a face image.")
    label = safe_filename(filename)
    ext = _extension(label)
    if ext not in ALLOWED_EXTENSIONS["image"]:
        raise ValidationError(
            f"A .{ext or '(none)'} file is not a valid image file. "
            f"Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS['image']))}."
        )
    character_id = f"char_{uuid.uuid4().hex}"
    media_id = f"media_{uuid.uuid4().hex}"
    stored = f"{media_id}_{label}"
    now = _now()
    with _lock:
        folder = _char_dir(character_id)
        made_folder = not folder.exists()
        dest = folder / stored
        conn = _open()
        try:
            try:
                folder.mkdir(parents=True, exist_ok=True)
                _store(dest, data, source)
                conn.execute(
                    "INSERT INTO characters (id, name, description, default_face_id, created_at, updated_at) "
                    "VALUES (?, ?, '', ?, ?, ?)",
                    (character_id, clean, media_id, now, now),
                )
                conn.execute(
                    "INSERT INTO character_media (id, character_id, kind, label, filename, "
                    "size_bytes, width, height, duration_s, position, created_at) "
                    "VALUES (?, ?, 'image', ?, ?, ?, ?, ?, NULL, 0, ?)",
                    (media_id, character_id, label, stored, size,
                     _positive_int(width), _positive_int(height), now),
                )
                conn.commit()
            except BaseException:
                conn.rollback()
                dest.unlink(missing_ok=True)
                if made_folder:
                    shutil.rmtree(folder, ignore_errors=True)
                raise
            return _load(conn, character_id)
        finally:
            conn.close()


_UNSET = object()


def update_character(
    character_id: str,
    *,
    name: Any = _UNSET,
    description: Any = _UNSET,
    default_face_id: Any = _UNSET,
    default_audio_id: Any = _UNSET,
) -> dict[str, Any]:
    _check_char_id(character_id)
    with _lock:
        conn = _open()
        try:
            current = _load(conn, character_id)
            sets: dict[str, Any] = {}
            if name is not _UNSET:
                sets["name"] = clean_name(name)
            if description is not _UNSET:
                sets["description"] = clean_description(description)
            for field, value, kind in (
                ("default_face_id", default_face_id, "image"),
                ("default_audio_id", default_audio_id, "audio"),
            ):
                if value is _UNSET:
                    continue
                if value is None and field == "default_face_id" and any(
                    m["kind"] == "image" for m in current["media"]
                ):
                    raise ValidationError("A character needs a face.")
                if value is not None:
                    owned = {m["id"] for m in current["media"] if m["kind"] == kind}
                    if not isinstance(value, str) or value not in owned:
                        raise ValidationError(
                            f"{field} must be null or the id of one of this character's {kind} files."
                        )
                sets[field] = value
            sets["updated_at"] = _now()
            cols = ", ".join(f"{k} = ?" for k in sets)
            conn.execute(f"UPDATE characters SET {cols} WHERE id = ?", (*sets.values(), character_id))
            conn.commit()
            return _load(conn, character_id)
        finally:
            conn.close()


def _char_dirs(character_id: str) -> list[Path]:
    """The character's folder in the current output folder and in every earlier
    one still on disk: a character keeps the files it had before the output
    folder was changed, so deleting must look in all of them."""
    from backend import output_folder

    _check_char_id(character_id)
    out: list[Path] = []
    for output_root in output_folder.search_roots():
        root = (output_root / "characters").resolve()
        path = (root / character_id).resolve()
        if path.parent == root and path not in out:
            out.append(path)
    return out


def _remove_tree(character_id: str) -> None:
    for folder in _char_dirs(character_id):
        if folder.is_dir() and not folder.is_symlink():
            shutil.rmtree(folder, ignore_errors=True)


def delete_character(character_id: str) -> None:
    _check_char_id(character_id)
    with _lock:
        conn = _open()
        try:
            if conn.execute("SELECT 1 FROM characters WHERE id = ?", (character_id,)).fetchone() is None:
                raise NotFoundError("Character not found.")
            conn.execute("DELETE FROM character_media WHERE character_id = ?", (character_id,))
            conn.execute("DELETE FROM characters WHERE id = ?", (character_id,))
            conn.commit()
        finally:
            conn.close()
        _remove_tree(character_id)


def add_media(
    character_id: str,
    *,
    kind: Any,
    filename: Any,
    data: bytes = b"",
    source: Path | None = None,
    width: Any = None,
    height: Any = None,
    duration_s: Any = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Store a file (``data``, or the file ``source`` moved into place) and its
    row. Returns (media, character)."""
    _check_char_id(character_id)
    with _lock:
        conn = _open()
        try:
            _load(conn, character_id)  # 404 first
            kind = canonical_kind(kind)
            if kind not in KINDS:
                raise ValidationError(KINDS_MESSAGE)
            size = _size(data, source)
            if not size:
                raise ValidationError("The file is empty.")
            label = safe_filename(filename)
            ext = _extension(label)
            if ext not in ALLOWED_EXTENSIONS[kind]:
                raise ValidationError(
                    f"A .{ext or '(none)'} file is not a valid {kind} file. "
                    f"Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS[kind]))}."
                )
            media_id = f"media_{uuid.uuid4().hex}"
            stored = f"{media_id}_{label}"
            folder = _char_dir(character_id)
            folder.mkdir(parents=True, exist_ok=True)
            dest = folder / stored
            _store(dest, data, source)
            try:
                position = conn.execute(
                    "SELECT COUNT(*) FROM character_media WHERE character_id = ? AND kind = ?",
                    (character_id, kind),
                ).fetchone()[0]
                now = _now()
                conn.execute(
                    "INSERT INTO character_media (id, character_id, kind, label, filename, "
                    "size_bytes, width, height, duration_s, position, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        media_id, character_id, kind, label, stored, size,
                        _positive_int(width), _positive_int(height), _positive_number(duration_s),
                        position, now,
                    ),
                )
                sets: dict[str, Any] = {"updated_at": now}
                char_row = conn.execute(
                    "SELECT default_face_id, default_audio_id FROM characters WHERE id = ?",
                    (character_id,),
                ).fetchone()
                if kind == "image" and not char_row["default_face_id"]:
                    sets["default_face_id"] = media_id
                if kind == "audio" and not char_row["default_audio_id"]:
                    sets["default_audio_id"] = media_id
                cols = ", ".join(f"{k} = ?" for k in sets)
                conn.execute(f"UPDATE characters SET {cols} WHERE id = ?", (*sets.values(), character_id))
                conn.commit()
            except Exception:
                conn.rollback()
                dest.unlink(missing_ok=True)
                raise
            character = _load(conn, character_id)
            media = next(m for m in character["media"] if m["id"] == media_id)
            return media, character
        finally:
            conn.close()


def _repack(conn: sqlite3.Connection, character_id: str, kind: str) -> list[str]:
    rows = conn.execute(
        "SELECT id FROM character_media WHERE character_id = ? AND kind = ? ORDER BY position, rowid",
        (character_id, kind),
    ).fetchall()
    ids = [r["id"] for r in rows]
    for pos, mid in enumerate(ids):
        conn.execute("UPDATE character_media SET position = ? WHERE id = ?", (pos, mid))
    return ids


def delete_media(character_id: str, media_id: str) -> dict[str, Any]:
    _check_char_id(character_id)
    _check_media_id(media_id)
    with _lock:
        conn = _open()
        try:
            _load(conn, character_id)
            row = conn.execute(
                "SELECT * FROM character_media WHERE id = ? AND character_id = ?",
                (media_id, character_id),
            ).fetchone()
            if row is None:
                raise NotFoundError("Media not found.")
            kind = row["kind"]
            if kind == "image" and conn.execute(
                "SELECT COUNT(*) FROM character_media WHERE character_id = ? AND kind = 'image' AND id != ?",
                (character_id, media_id),
            ).fetchone()[0] == 0:
                raise ValidationError(
                    "A character needs a face. Add another image before removing this one."
                )
            conn.execute("DELETE FROM character_media WHERE id = ?", (media_id,))
            remaining = _repack(conn, character_id, kind)
            sets: dict[str, Any] = {"updated_at": _now()}
            char_row = conn.execute(
                "SELECT default_face_id, default_audio_id FROM characters WHERE id = ?",
                (character_id,),
            ).fetchone()
            if kind == "image" and char_row["default_face_id"] == media_id:
                sets["default_face_id"] = remaining[0] if remaining else None
            if kind == "audio" and char_row["default_audio_id"] == media_id:
                sets["default_audio_id"] = remaining[0] if remaining else None
            cols = ", ".join(f"{k} = ?" for k in sets)
            conn.execute(f"UPDATE characters SET {cols} WHERE id = ?", (*sets.values(), character_id))
            conn.commit()
            for folder in _char_dirs(character_id):
                target = (folder / row["filename"]).resolve()
                if target.parent == folder:
                    target.unlink(missing_ok=True)
            return _load(conn, character_id)
        finally:
            conn.close()


def reorder_media(character_id: str, kind: Any, ids: Any) -> dict[str, Any]:
    _check_char_id(character_id)
    with _lock:
        conn = _open()
        try:
            _load(conn, character_id)
            kind = canonical_kind(kind)
            if kind not in KINDS:
                raise ValidationError(KINDS_MESSAGE)
            if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
                raise ValidationError("ids must be a list of media ids.")
            existing = {
                r["id"]
                for r in conn.execute(
                    "SELECT id FROM character_media WHERE character_id = ? AND kind = ?",
                    (character_id, kind),
                )
            }
            if len(ids) != len(set(ids)) or set(ids) != existing:
                raise ValidationError(
                    f"ids must be exactly this character's {kind} media ids, each once."
                )
            for pos, mid in enumerate(ids):
                conn.execute("UPDATE character_media SET position = ? WHERE id = ?", (pos, mid))
            conn.execute("UPDATE characters SET updated_at = ? WHERE id = ?", (_now(), character_id))
            conn.commit()
            return _load(conn, character_id)
        finally:
            conn.close()
