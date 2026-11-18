"""Characters keep sound as one kind, ``audio``.

The store's kinds are image, video and audio. ``kind=voice`` (old clients) is
an alias for audio and is never stored. A character has a default audio clip
(``default_audio_id``) the way it has a default face. A database made before
the merge is migrated in place: voice rows become audio rows after the
character's existing audio, and ``default_voice_id`` becomes ``default_audio_id``.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import character_routes, characters, db, output_folder  # noqa: E402


@pytest.fixture
def out(tmp_path, monkeypatch):
    o = tmp_path / "outputs"
    o.mkdir()
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t.db")
    monkeypatch.setattr(output_folder, "_state", output_folder.pinned_state(o))
    return o


@pytest.fixture
def env(out):
    characters.init_db()
    return out


@pytest.fixture
def client(out):
    app = FastAPI()
    app.include_router(character_routes.router)
    return TestClient(app)


def _add(cid, kind="audio", name="a.mp3", data=b"x"):
    return characters.add_media(cid, kind=kind, filename=name, data=data)


def _columns(table):
    conn = sqlite3.connect(str(db.DB_PATH))
    try:
        return [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]
    finally:
        conn.close()


# ------------------------------------------------------------------ store


def test_kinds_are_image_video_audio():
    assert characters.KINDS == ("image", "video", "audio")
    assert "voice" not in characters.ALLOWED_EXTENSIONS
    assert not hasattr(characters, "speaker_name")


def test_character_json_has_default_audio_and_no_voice_fields(env):
    c = characters.create_character("Mia Rose")
    assert c["default_audio_id"] is None
    assert not {"voice_name", "default_voice_id"} & set(c)
    assert set(c) == {"id", "name", "description", "created_at", "updated_at", "default_face_id",
                      "default_audio_id", "media"}


def test_first_audio_becomes_the_default(env):
    c = characters.create_character("a")
    a1, char = _add(c["id"], name="1.mp3")
    assert char["default_audio_id"] == a1["id"]
    a2, char = _add(c["id"], name="2.mp3")
    assert char["default_audio_id"] == a1["id"] and a2["position"] == 1


def test_voice_kind_is_stored_as_audio(env):
    c = characters.create_character("a")
    a1, _ = _add(c["id"], name="song.mp3")
    v, char = _add(c["id"], kind="voice", name="hello.wav")
    assert v["kind"] == "audio" and v["position"] == 1
    assert [m["kind"] for m in char["media"]] == ["audio", "audio"]
    assert char["default_audio_id"] == a1["id"]
    assert sqlite3.connect(str(db.DB_PATH)).execute(
        "SELECT COUNT(*) FROM character_media WHERE kind = 'voice'").fetchone()[0] == 0


def test_media_is_ordered_image_video_audio(env):
    c = characters.create_character("a")
    _add(c["id"], name="a.mp3")
    _add(c["id"], kind="video", name="v.mp4")
    _add(c["id"], kind="image", name="i.png")
    assert [m["kind"] for m in characters.get_character(c["id"])["media"]] == ["image", "video", "audio"]


def test_removing_the_default_audio_moves_it(env):
    c = characters.create_character("a")
    a1, _ = _add(c["id"], name="1.mp3")
    a2, _ = _add(c["id"], name="2.mp3")
    a3, _ = _add(c["id"], name="3.mp3")
    assert characters.delete_media(c["id"], a2["id"])["default_audio_id"] == a1["id"]
    assert characters.delete_media(c["id"], a1["id"])["default_audio_id"] == a3["id"]
    assert characters.delete_media(c["id"], a3["id"])["default_audio_id"] is None


def test_patch_default_audio_is_null_or_own_audio(env):
    c = characters.create_character("a")
    other = characters.create_character("b")
    img, _ = _add(c["id"], kind="image", name="i.png")
    a1, _ = _add(c["id"], name="1.mp3")
    a2, _ = _add(c["id"], name="2.mp3")
    foreign, _ = _add(other["id"], name="f.mp3")
    assert characters.update_character(c["id"], default_audio_id=a2["id"])["default_audio_id"] == a2["id"]
    for bad in (img["id"], foreign["id"], "nope", 5):
        with pytest.raises(characters.ValidationError, match="default_audio_id"):
            characters.update_character(c["id"], default_audio_id=bad)
    assert characters.get_character(c["id"])["default_audio_id"] == a2["id"]
    assert characters.update_character(c["id"], default_audio_id=None)["default_audio_id"] is None
    with pytest.raises(TypeError):
        characters.update_character(c["id"], default_voice_id=a1["id"])


def test_reorder_accepts_the_voice_alias(env):
    c = characters.create_character("a")
    a1, _ = _add(c["id"], name="1.mp3")
    a2, _ = _add(c["id"], name="2.mp3")
    char = characters.reorder_media(c["id"], "voice", [a2["id"], a1["id"]])
    assert [m["id"] for m in char["media"]] == [a2["id"], a1["id"]]


# ------------------------------------------------------------------ routes


def _up(client, cid, kind, name, data=b"bytes"):
    return client.post(f"/api/characters/{cid}/media", params={"kind": kind}, content=data,
                       headers={"X-Filename": name})


def test_upload_voice_alias_is_audio(client, out):
    c = characters.create_character("Ana")
    r = _up(client, c["id"], "voice", "hello.mp3")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["media"]["kind"] == "audio"
    assert body["character"]["default_audio_id"] == body["media"]["id"]
    assert "voice_name" not in body["character"] and "default_voice_id" not in body["character"]


def test_upload_unknown_kind_lists_three(client, out):
    c = characters.create_character("Ana")
    r = _up(client, c["id"], "speech", "hello.mp3")
    assert r.status_code == 422 and r.json()["error"] == "Kind must be one of image, video or audio."


def test_patch_route_default_audio(client, out):
    c = characters.create_character("Ana")
    a = _up(client, c["id"], "audio", "a.mp3").json()["media"]
    b = _up(client, c["id"], "audio", "b.mp3").json()["media"]
    img = _up(client, c["id"], "image", "i.png").json()["media"]
    r = client.patch(f"/api/characters/{c['id']}", json={"default_audio_id": b["id"]})
    assert r.status_code == 200 and r.json()["character"]["default_audio_id"] == b["id"]
    assert client.patch(f"/api/characters/{c['id']}", json={"default_audio_id": img["id"]}).status_code == 422
    r = client.patch(f"/api/characters/{c['id']}", json={"default_audio_id": None})
    assert r.json()["character"]["default_audio_id"] is None
    assert a["id"] in {m["id"] for m in r.json()["character"]["media"]}


# ------------------------------------------------------------------ migration from the old shape

OLD_SCHEMA = (
    """CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
       default_face_id TEXT, default_voice_id TEXT, created_at TEXT, updated_at TEXT)""",
    """CREATE TABLE character_media (id TEXT PRIMARY KEY, character_id TEXT NOT NULL, kind TEXT NOT NULL,
       label TEXT NOT NULL, filename TEXT NOT NULL, size_bytes INTEGER, width INTEGER, height INTEGER,
       duration_s REAL, position INTEGER NOT NULL, created_at TEXT)""",
    "CREATE INDEX idx_character_media_char ON character_media(character_id)",
)


def _cid(n):
    return f"char_{n:032x}"


def _mid(n):
    return f"media_{n:032x}"


BOTH, VOICES, NONE, CLEARED = _cid(1), _cid(2), _cid(3), _cid(4)


def _old_db(out):
    conn = sqlite3.connect(str(db.DB_PATH))
    for stmt in OLD_SCHEMA:
        conn.execute(stmt)
    chars = [(BOTH, "Both", _mid(1), _mid(13)), (VOICES, "Voices", None, _mid(20)),
             (NONE, "None", _mid(30), None), (CLEARED, "Cleared", None, None)]
    for cid, name, face, voice in chars:
        conn.execute("INSERT INTO characters VALUES (?, ?, '', ?, ?, 't0', 't0')", (cid, name, face, voice))
    media = [
        # BOTH: a face, two audio clips, and two voices inserted out of position order.
        (_mid(1), BOTH, "image", "face.png", 0),
        (_mid(10), BOTH, "audio", "song.mp3", 0),
        (_mid(11), BOTH, "audio", "rain.mp3", 1),
        (_mid(13), BOTH, "voice", "angry.wav", 1),
        (_mid(12), BOTH, "voice", "hello.wav", 0),
        (_mid(20), VOICES, "voice", "only.mp3", 0),
        (_mid(30), NONE, "image", "face.png", 0),
        (_mid(40), CLEARED, "voice", "a.mp3", 0),
    ]
    for mid, cid, kind, label, pos in media:
        stored = f"{mid}_{label}"
        conn.execute("INSERT INTO character_media VALUES (?, ?, ?, ?, ?, 3, NULL, NULL, 2.5, ?, 't0')",
                     (mid, cid, kind, label, stored, pos))
        folder = out / "characters" / cid
        folder.mkdir(parents=True, exist_ok=True)
        (folder / stored).write_bytes(f"{kind}:{label}".encode())
    conn.commit()
    conn.close()


def _sound(c):
    return [(m["id"], m["kind"], m["position"]) for m in c["media"] if m["kind"] != "image"]


def _check_migrated(out):
    both = characters.get_character(BOTH)
    assert _sound(both) == [(_mid(10), "audio", 0), (_mid(11), "audio", 1),
                            (_mid(12), "audio", 2), (_mid(13), "audio", 3)]
    assert both["default_audio_id"] == _mid(13) and both["default_face_id"] == _mid(1)
    voices = characters.get_character(VOICES)
    assert _sound(voices) == [(_mid(20), "audio", 0)] and voices["default_audio_id"] == _mid(20)
    none = characters.get_character(NONE)
    assert _sound(none) == [] and none["default_audio_id"] is None
    cleared = characters.get_character(CLEARED)
    assert _sound(cleared) == [(_mid(40), "audio", 0)] and cleared["default_audio_id"] is None
    assert "default_voice_id" not in _columns("characters") and "default_audio_id" in _columns("characters")
    conn = sqlite3.connect(str(db.DB_PATH))
    assert conn.execute("SELECT COUNT(*) FROM character_media WHERE kind = 'voice'").fetchone()[0] == 0
    conn.close()
    # Files on disk are untouched and still where the rows point.
    hello = next(m for m in both["media"] if m["id"] == _mid(12))
    assert hello["local"] == f"/outputs/characters/{BOTH}/{_mid(12)}_hello.wav"
    assert (out / "characters" / BOTH / f"{_mid(12)}_hello.wav").read_bytes() == b"voice:hello.wav"


def test_migration_from_the_old_shape_on_init(out):
    _old_db(out)
    characters.init_db()
    _check_migrated(out)


def test_migration_runs_on_first_use_without_init(out):
    _old_db(out)
    assert [c["id"] for c in characters.list_characters()] == [BOTH, VOICES, NONE, CLEARED]
    _check_migrated(out)


def test_migration_is_idempotent(out):
    _old_db(out)
    characters.init_db()
    characters.init_db()
    characters.list_characters()
    _check_migrated(out)
    # New media after the migration keeps the numbering going.
    m, c = _add(BOTH, name="new.mp3")
    assert m["position"] == 4 and c["default_audio_id"] == _mid(13)


def test_fresh_database_has_default_audio_column(out):
    characters.init_db()
    assert "default_audio_id" in _columns("characters") and "default_voice_id" not in _columns("characters")
