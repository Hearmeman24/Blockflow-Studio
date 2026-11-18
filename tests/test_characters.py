"""Character store: rows, files, defaults, path safety."""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import (  # noqa: E402
    characters,
    db,
    output_folder,  # noqa: E402
)
from backend.byok.references import resolve_local  # noqa: E402


@pytest.fixture
def env(tmp_path, monkeypatch):
    out = tmp_path / "outputs"
    out.mkdir()
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t.db")
    monkeypatch.setattr(output_folder, "_state", output_folder.pinned_state(out))
    characters.init_db()
    return out


def _add(cid, kind="image", name="a.png", data=b"x", **kw):
    return characters.add_media(cid, kind=kind, filename=name, data=data, **kw)


def test_create_trims_name_and_defaults(env):
    c = characters.create_character("  José  ", None)
    assert c["name"] == "José"
    assert c["description"] == ""
    assert c["default_face_id"] is None and c["default_audio_id"] is None
    assert c["media"] == []
    assert c["id"].startswith("char_")
    assert c["created_at"].endswith("Z") and c["updated_at"].endswith("Z")


@pytest.mark.parametrize("bad", ["", "   ", "x" * 81, None, 5, ["a"]])
def test_create_rejects_bad_names(env, bad):
    with pytest.raises(characters.ValidationError):
        characters.create_character(bad)
    assert characters.list_characters() == []


def test_description_validation(env):
    with pytest.raises(characters.ValidationError):
        characters.create_character("a", "d" * 4001)
    with pytest.raises(characters.ValidationError):
        characters.create_character("a", 7)
    assert characters.create_character("a", "d" * 4000)["description"] == "d" * 4000


def test_special_names_stored_verbatim(env):
    for name in ["../../etc", "a/b", "日本語 \U0001F600", "O'Brien \"x\""]:
        assert characters.create_character(name)["name"] == name
    # no path derived from a name
    assert not (env / "characters").exists() or not list((env / "characters").iterdir())


def test_list_in_creation_order(env):
    ids = [characters.create_character(f"c{i}")["id"] for i in range(4)]
    assert [c["id"] for c in characters.list_characters()] == ids


def test_unknown_and_malformed_ids_are_not_found(env):
    for bad in ["char_" + "0" * 32, "../x", "char_../..", "", "char_ABC"]:
        with pytest.raises(characters.NotFoundError):
            characters.get_character(bad)


def test_update_and_bump_updated_at(env, monkeypatch):
    c = characters.create_character("a")
    monkeypatch.setattr(characters, "_now", lambda: "2099-01-01T00:00:00Z")
    u = characters.update_character(c["id"], name=" b ", description="d")
    assert (u["name"], u["description"]) == ("b", "d")
    assert u["updated_at"] == "2099-01-01T00:00:00Z"
    with pytest.raises(characters.ValidationError):
        characters.update_character(c["id"], name="")
    assert characters.get_character(c["id"])["name"] == "b"


def test_upload_writes_file_and_resolves(env):
    c = characters.create_character("a")
    media, char = _add(c["id"], name="José's face (1).png", data=b"\x89PNGdata", width=640, height="480")
    path = resolve_local(media["local"])
    assert path.read_bytes() == b"\x89PNGdata"
    assert path.parent == (env / "characters" / c["id"]).resolve()
    assert media["label"] == "José's face (1).png"
    assert media["size_bytes"] == 8
    assert (media["width"], media["height"], media["duration_s"]) == (640, 480, None)
    assert media["position"] == 0
    assert char["media"] == [media]


def test_filename_sanitising(env):
    c = characters.create_character("a")
    media, _ = _add(c["id"], name="../../evil/..\\x\x00y.png")
    assert media["label"] == "y.png" or media["label"].endswith(".png")
    p = resolve_local(media["local"])
    assert p.parent == (env / "characters" / c["id"]).resolve()
    assert not (env / "evil").exists()
    long_name = "n" * 300 + ".png"
    m2, _ = _add(c["id"], name=long_name)
    assert len(m2["label"]) <= 120 and m2["label"].endswith(".png")
    assert resolve_local(m2["local"]).exists()


@pytest.mark.parametrize("value", [0, -1, float("nan"), float("inf"), "abc", None, True])
def test_bad_metadata_ignored(env, value):
    c = characters.create_character("a")
    media, _ = _add(c["id"], kind="video", name="v.mp4", width=value, height=value, duration_s=value)
    assert (media["width"], media["height"], media["duration_s"]) == (None, None, None)


def test_duration_kept(env):
    c = characters.create_character("a")
    media, _ = _add(c["id"], kind="video", name="v.mp4", duration_s="3.5")
    assert media["duration_s"] == 3.5


def test_upload_validation(env):
    c = characters.create_character("a")
    with pytest.raises(characters.ValidationError):
        _add(c["id"], name="a.exe")
    with pytest.raises(characters.ValidationError):
        _add(c["id"], kind="video", name="a.png")
    with pytest.raises(characters.ValidationError):
        _add(c["id"], name="noext")
    with pytest.raises(characters.ValidationError):
        _add(c["id"], data=b"")
    with pytest.raises(characters.ValidationError):
        _add(c["id"], kind="gif")
    with pytest.raises(characters.NotFoundError):
        _add("char_" + "1" * 32)
    assert characters.get_character(c["id"])["media"] == []
    assert not (env / "characters" / c["id"]).exists() or not list((env / "characters" / c["id"]).iterdir())


def test_extension_case_insensitive(env):
    c = characters.create_character("a")
    _add(c["id"], name="A.PNG")
    _add(c["id"], kind="audio", name="v.M4A")


def test_defaults_assigned_on_first_image_and_first_audio(env):
    c = characters.create_character("a")
    i1, _ = _add(c["id"], name="1.png")
    i2, _ = _add(c["id"], name="2.png")
    a1, _ = _add(c["id"], kind="audio", name="a.mp3")
    a2, char = _add(c["id"], kind="audio", name="w.mp3")
    assert char["default_face_id"] == i1["id"]
    assert char["default_audio_id"] == a1["id"]
    assert (i2["position"], a2["position"], a1["position"]) == (1, 1, 0)
    _add(c["id"], kind="video", name="v.mp4")
    assert [m["kind"] for m in characters.get_character(c["id"])["media"]] == [
        "image", "image", "video", "audio", "audio",
    ]


def test_video_never_becomes_a_default(env):
    c = characters.create_character("a")
    _, char = _add(c["id"], kind="video", name="a.mp4")
    assert char["default_audio_id"] is None and char["default_face_id"] is None


def test_patch_defaults_validated(env):
    c = characters.create_character("a")
    other = characters.create_character("b")
    i1, _ = _add(c["id"], name="1.png")
    i2, _ = _add(c["id"], name="2.png")
    v, _ = _add(c["id"], kind="audio", name="v.mp3")
    vid, _ = _add(c["id"], kind="video", name="v.mp4")
    foreign, _ = _add(other["id"], name="f.png")
    assert characters.update_character(c["id"], default_face_id=i2["id"])["default_face_id"] == i2["id"]
    with pytest.raises(characters.ValidationError, match="needs a face"):
        characters.update_character(c["id"], default_face_id=None)
    assert characters.get_character(c["id"])["default_face_id"] == i2["id"]
    for bad in (foreign["id"], v["id"], vid["id"], "nope", 5):
        with pytest.raises(characters.ValidationError):
            characters.update_character(c["id"], default_face_id=bad)
    for bad in (i1["id"], foreign["id"]):
        with pytest.raises(characters.ValidationError):
            characters.update_character(c["id"], default_audio_id=bad)
    assert characters.update_character(c["id"], default_audio_id=v["id"])["default_audio_id"] == v["id"]


def test_delete_default_reassigns_and_repacks(env):
    c = characters.create_character("a")
    i1, _ = _add(c["id"], name="1.png")
    i2, _ = _add(c["id"], name="2.png")
    i3, _ = _add(c["id"], name="3.png")
    char = characters.delete_media(c["id"], i1["id"])
    assert char["default_face_id"] == i2["id"]
    assert [(m["id"], m["position"]) for m in char["media"]] == [(i2["id"], 0), (i3["id"], 1)]
    char = characters.delete_media(c["id"], i2["id"])
    assert char["default_face_id"] == i3["id"]
    with pytest.raises(characters.ValidationError, match="Add another image"):
        characters.delete_media(c["id"], i3["id"])
    assert characters.get_character(c["id"])["default_face_id"] == i3["id"]


def test_delete_default_audio_moves(env):
    c = characters.create_character("a")
    v1, _ = _add(c["id"], kind="audio", name="1.mp3")
    v2, _ = _add(c["id"], kind="audio", name="2.mp3")
    assert characters.delete_media(c["id"], v1["id"])["default_audio_id"] == v2["id"]


def test_delete_nondefault_keeps_default(env):
    c = characters.create_character("a")
    i1, _ = _add(c["id"], name="1.png")
    i2, _ = _add(c["id"], name="2.png")
    assert characters.delete_media(c["id"], i2["id"])["default_face_id"] == i1["id"]


def test_delete_media_removes_file_and_tolerates_missing(env):
    c = characters.create_character("a")
    m1, _ = _add(c["id"], name="1.png")
    m2, _ = _add(c["id"], name="2.png")
    m3, _ = _add(c["id"], name="3.png")
    p1, p2 = resolve_local(m1["local"]), resolve_local(m2["local"])
    characters.delete_media(c["id"], m1["id"])
    assert not p1.exists() and p2.exists()
    p2.unlink()
    char = characters.delete_media(c["id"], m2["id"])
    assert [m["id"] for m in char["media"]] == [m3["id"]]


def test_delete_media_unknown_or_foreign(env):
    a = characters.create_character("a")
    b = characters.create_character("b")
    mb, _ = _add(b["id"], name="b.png")
    with pytest.raises(characters.NotFoundError):
        characters.delete_media(a["id"], mb["id"])
    with pytest.raises(characters.NotFoundError):
        characters.delete_media(a["id"], "media_" + "0" * 32)
    with pytest.raises(characters.NotFoundError):
        characters.delete_media(a["id"], "../../x")
    assert resolve_local(mb["local"]).exists()
    assert len(characters.get_character(b["id"])["media"]) == 1


def test_characters_isolated(env):
    a = characters.create_character("a")
    b = characters.create_character("b")
    _add(a["id"], name="a.png")
    assert characters.get_character(b["id"])["media"] == []
    assert b["id"] != a["id"]


def test_delete_character_removes_only_its_folder(env):
    a = characters.create_character("a")
    b = characters.create_character("b")
    ma, _ = _add(a["id"], name="a.png")
    mb, _ = _add(b["id"], name="b.png")
    bystander = env / "other.png"
    bystander.write_bytes(b"k")
    characters.delete_character(a["id"])
    assert not (env / "characters" / a["id"]).exists()
    assert resolve_local(mb["local"]).exists() and bystander.exists()
    with pytest.raises(characters.NotFoundError):
        characters.get_character(a["id"])
    conn = sqlite3.connect(str(db.DB_PATH))
    assert conn.execute("SELECT COUNT(*) FROM character_media WHERE character_id=?", (a["id"],)).fetchone()[0] == 0
    assert ma["id"]
    with pytest.raises(characters.NotFoundError):
        characters.delete_character(a["id"])


def test_delete_traversal_id_touches_nothing(env):
    victim = env / "victim"
    victim.mkdir()
    (victim / "f").write_bytes(b"1")
    for bad in ["..", "../victim", "char_/../../victim", "."]:
        with pytest.raises(characters.NotFoundError):
            characters.delete_character(bad)
    assert (victim / "f").exists()


def test_reorder(env):
    c = characters.create_character("a")
    ms = [_add(c["id"], name=f"{i}.png")[0] for i in range(3)]
    ids = [ms[2]["id"], ms[0]["id"], ms[1]["id"]]
    char = characters.reorder_media(c["id"], "image", ids)
    assert [m["id"] for m in char["media"]] == ids
    assert [m["position"] for m in char["media"]] == [0, 1, 2]


def test_reorder_rejects_mismatches(env):
    a = characters.create_character("a")
    b = characters.create_character("b")
    m1, _ = _add(a["id"], name="1.png")
    m2, _ = _add(a["id"], name="2.png")
    mb, _ = _add(b["id"], name="b.png")
    v, _ = _add(a["id"], kind="audio", name="v.mp3")
    for ids in ([m1["id"]], [m1["id"], m1["id"]], [m1["id"], m2["id"], mb["id"]],
                [m1["id"], v["id"]], "x", [1, 2], []):
        with pytest.raises(characters.ValidationError):
            characters.reorder_media(a["id"], "image", ids)
    with pytest.raises(characters.ValidationError):
        characters.reorder_media(a["id"], "bogus", [])
    assert [m["id"] for m in characters.get_character(a["id"])["media"] if m["kind"] == "image"] == [m1["id"], m2["id"]]


def test_db_failure_removes_file(env, monkeypatch):
    c = characters.create_character("a")
    conn = sqlite3.connect(str(db.DB_PATH))
    conn.execute("DROP TABLE character_media")
    conn.execute("CREATE TABLE character_media (id TEXT PRIMARY KEY, character_id TEXT NOT NULL)")
    conn.commit()
    conn.close()
    monkeypatch.setattr(characters, "_SCHEMA", ())
    with pytest.raises(sqlite3.Error):
        _add(c["id"], name="a.png")
    folder = env / "characters" / c["id"]
    assert not folder.exists() or not list(folder.iterdir())


def test_tables_created_lazily(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "fresh.db")
    monkeypatch.setattr(output_folder, "_state", output_folder.pinned_state(tmp_path / "o"))
    assert characters.list_characters() == []
    assert characters.create_character("x")["name"] == "x"


# ---- Earlier output folders (the folder can be changed while the app runs) ----


def _switch(monkeypatch, new: Path, old: Path) -> None:
    new.mkdir(exist_ok=True)
    monkeypatch.setattr(output_folder, "_state", output_folder.pinned_state(new, [old]))


def test_delete_media_removes_the_file_from_an_earlier_output_folder(env, tmp_path, monkeypatch):
    c = characters.create_character("Mia")
    media, _ = characters.add_media(c["id"], kind="image", filename="a.png", data=b"old")
    characters.add_media(c["id"], kind="image", filename="keep.png", data=b"keep")
    old_file = resolve_local(media["local"])
    assert old_file.is_file()
    _switch(monkeypatch, tmp_path / "new-outputs", env)

    characters.delete_media(c["id"], media["id"])

    assert not old_file.exists()


def test_delete_character_removes_its_folder_in_every_output_folder(env, tmp_path, monkeypatch):
    c = characters.create_character("Mia")
    first, _ = characters.add_media(c["id"], kind="image", filename="a.png", data=b"old")
    old_dir = resolve_local(first["local"]).parent
    new_root = tmp_path / "new-outputs"
    _switch(monkeypatch, new_root, env)
    second, _ = characters.add_media(c["id"], kind="image", filename="b.png", data=b"new")
    new_dir = resolve_local(second["local"]).parent
    assert old_dir != new_dir and old_dir.is_dir() and new_dir.is_dir()
    bystander = env / "characters" / "keep.txt"
    bystander.write_text("x")

    characters.delete_character(c["id"])

    assert not old_dir.exists()
    assert not new_dir.exists()
    assert bystander.read_text() == "x"


# ------------------------------------------------- create_character_with_face


def _folder(env, cid):
    return env / "characters" / cid


def _no_files(env):
    root = env / "characters"
    return not root.exists() or not any(root.iterdir())


def _row_counts():
    conn = sqlite3.connect(str(db.DB_PATH))
    try:
        return tuple(conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("characters", "character_media"))
    finally:
        conn.close()


def test_create_with_face_makes_the_character_and_its_default_face(env):
    c = characters.create_character_with_face(" Zoë ", filename="face one.png", data=b"FACE", width="64", height=32)
    assert c["name"] == "Zoë" and c["description"] == ""
    (m,) = c["media"]
    assert c["default_face_id"] == m["id"] and m["kind"] == "image" and m["label"] == "face one.png"
    assert (m["width"], m["height"], m["size_bytes"], m["position"]) == (64, 32, 4, 0)
    assert resolve_local(m["local"]).read_bytes() == b"FACE"
    assert characters.get_character(c["id"]) == c
    assert _row_counts() == (1, 1)


@pytest.mark.parametrize("name", ["", "  ", "x" * 81, None, 5])
def test_create_with_face_bad_name_leaves_nothing(env, name):
    with pytest.raises(characters.ValidationError):
        characters.create_character_with_face(name, filename="a.png", data=b"x")
    assert _row_counts() == (0, 0) and _no_files(env)


@pytest.mark.parametrize("filename,data", [("a.exe", b"x"), ("a.mp3", b"x"), ("noext", b"x"), (None, b"x"), ("a.png", b"")])
def test_create_with_face_refused_file_leaves_nothing(env, filename, data):
    with pytest.raises(characters.ValidationError):
        characters.create_character_with_face("Ana", filename=filename, data=data)
    assert _row_counts() == (0, 0) and _no_files(env)


def test_create_with_face_write_failure_leaves_nothing(env, monkeypatch):
    def boom(self, data):
        raise OSError(28, "No space left on device")

    with monkeypatch.context() as mp:
        mp.setattr(Path, "write_bytes", boom)
        with pytest.raises(OSError):
            characters.create_character_with_face("Ana", filename="a.png", data=b"x")
    assert _row_counts() == (0, 0) and _no_files(env)


def test_create_with_face_database_failure_leaves_no_file_and_no_folder(env, monkeypatch):
    def boom(value):
        raise sqlite3.OperationalError("database is locked")

    with monkeypatch.context() as mp:
        mp.setattr(characters, "_positive_int", boom)
        with pytest.raises(sqlite3.OperationalError):
            characters.create_character_with_face("Ana", filename="a.png", data=b"x", width=3)
    assert _row_counts() == (0, 0) and _no_files(env)
    ok = characters.create_character_with_face("Ana", filename="a.png", data=b"x")
    assert len(ok["media"]) == 1  # the store is still usable


def test_create_with_face_failure_keeps_other_characters_untouched(env, monkeypatch):
    first = characters.create_character_with_face("One", filename="a.png", data=b"1")
    with monkeypatch.context() as mp:
        mp.setattr(characters, "_positive_int", lambda v: (_ for _ in ()).throw(RuntimeError("x")))
        with pytest.raises(RuntimeError):
            characters.create_character_with_face("Two", filename="b.png", data=b"2")
    assert [c["id"] for c in characters.list_characters()] == [first["id"]]
    assert resolve_local(first["media"][0]["local"]).read_bytes() == b"1"
    assert [p.name for p in (env / "characters").iterdir()] == [first["id"]]


def test_create_character_without_a_face_is_still_a_store_operation(env):
    c = characters.create_character("Old")
    assert c["media"] == [] and c["default_face_id"] is None
    _, char = _add(c["id"], name="first.png")
    assert char["default_face_id"] == char["media"][0]["id"]
