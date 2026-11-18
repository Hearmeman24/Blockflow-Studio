"""HTTP routes for characters."""
from __future__ import annotations

import sys
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import (  # noqa: E402
    character_routes,
    characters,
    db,
    output_folder,  # noqa: E402
)
from backend.byok.references import resolve_local  # noqa: E402


@pytest.fixture
def out(tmp_path, monkeypatch):
    o = tmp_path / "outputs"
    o.mkdir()
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t.db")
    monkeypatch.setattr(output_folder, "_state", output_folder.pinned_state(o))
    return o


@pytest.fixture
def client(out):
    app = FastAPI()
    app.include_router(character_routes.router)
    return TestClient(app)


def _legacy(client, name="Ana", **extra):
    """A character made before the face rule: no images. Only the store can
    make one now; no HTTP route can."""
    return characters.create_character(name, extra.get("description"))


def _mk(client, name="Ana", face="face.png", data=b"FACE-BYTES", **params):
    """A character the new way: the name in the query, the face as the body."""
    h = {"X-Filename": face.encode("utf-8") if not face.isascii() else face}
    r = client.post("/api/characters", params={"name": name, **params}, content=data, headers=h)
    assert r.status_code == 200, r.text
    return r.json()["character"]


def _up(client, cid, kind="image", name="a.png", data=b"bytes", headers=None, **params):
    h = {"X-Filename": name.encode("utf-8") if not name.isascii() else name}
    h.update(headers or {})
    q = {"kind": kind, **params}
    return client.post(f"/api/characters/{cid}/media", params=q, content=data, headers=h)


def test_create_list_get(client, out):
    c = _mk(client, "  José  ", face="José.png", data=b"JOSE")
    assert c["name"] == "José" and c["description"] == ""
    assert len(c["media"]) == 1 and c["default_face_id"] == c["media"][0]["id"]
    r = client.get("/api/characters")
    assert r.json() == {"ok": True, "characters": [c]}
    assert client.get(f"/api/characters/{c['id']}").json() == {"ok": True, "character": c}


def test_list_empty(client):
    assert client.get("/api/characters").json() == {"ok": True, "characters": []}


def _nothing_left(client, out):
    assert client.get("/api/characters").json()["characters"] == []
    assert not (out / "characters").exists() or not any((out / "characters").iterdir())
    import sqlite3

    conn = sqlite3.connect(str(db.DB_PATH))
    try:
        assert conn.execute("SELECT COUNT(*) FROM character_media").fetchone()[0] == 0
    finally:
        conn.close()


def _post(client, params=None, content=b"x", headers=None):
    return client.post("/api/characters", params=params, content=content, headers=headers)


@pytest.mark.parametrize("name", ["", "   ", "x" * 81])
def test_create_bad_name_422(client, out, name):
    r = _post(client, {"name": name}, headers={"X-Filename": "a.png"})
    assert r.status_code == 422
    j = r.json()
    assert j["ok"] is False and isinstance(j["error"], str) and j["error"]
    _nothing_left(client, out)


def test_create_missing_name_422(client, out):
    r = _post(client, None, headers={"X-Filename": "a.png"})
    assert r.status_code == 422 and r.json()["ok"] is False
    _nothing_left(client, out)


def test_create_name_of_80_chars_is_fine(client):
    assert len(_mk(client, "x" * 80)["name"]) == 80


def test_create_empty_body_400_says_a_face_is_needed(client, out):
    r = _post(client, {"name": "Ana"}, content=b"", headers={"X-Filename": "a.png"})
    assert r.status_code == 400
    assert r.json()["ok"] is False and "face image" in r.json()["error"]
    _nothing_left(client, out)


@pytest.mark.parametrize("filename", ["a.exe", "a.mp4", "a.mp3", "noext", "a.png.txt"])
def test_create_non_image_extension_422_leaves_nothing(client, out, filename):
    r = _post(client, {"name": "Ana"}, headers={"X-Filename": filename})
    assert r.status_code == 422 and r.json()["ok"] is False
    _nothing_left(client, out)


def test_create_missing_filename_header_422_leaves_nothing(client, out):
    r = _post(client, {"name": "Ana"})
    assert r.status_code == 422 and r.json()["ok"] is False
    _nothing_left(client, out)


def test_create_the_old_json_way_is_refused(client, out):
    r = client.post("/api/characters", json={"name": "Ana"})
    assert r.status_code == 422
    assert r.json() == {"ok": False, "error": "A character needs a name and a face image."}
    r = client.post("/api/characters", json={"name": "Ana"}, params={"name": "Ana"},
                    headers={"X-Filename": "a.png"})
    assert r.status_code == 422
    assert r.json() == {"ok": False, "error": "A character needs a name and a face image."}
    assert client.post("/api/characters", json=["a"]).status_code == 422
    _nothing_left(client, out)


def test_create_stores_the_face_at_the_returned_path(client, out):
    c = _mk(client, "Ana", face="face.png", data=b"PNG\x00\xff-face", width="640", height="480")
    m = c["media"][0]
    assert m["kind"] == "image" and m["label"] == "face.png" and m["position"] == 0
    assert (m["width"], m["height"], m["size_bytes"]) == (640, 480, len(b"PNG\x00\xff-face"))
    assert c["default_face_id"] == m["id"] and c["default_audio_id"] is None
    assert m["local"].startswith(f"/outputs/characters/{c['id']}/")
    p = resolve_local(m["local"])
    assert p.read_bytes() == b"PNG\x00\xff-face"
    assert p.parent == (out / "characters" / c["id"]).resolve()


@pytest.mark.parametrize("name", ["Zoë Rose", "李小龙", "Tom & Jerry", "Who? Me", "Ann #1", "  a b  c ", "100%", "a+b"])
def test_create_names_with_special_characters(client, name):
    # httpx URL-encodes the query value; the server must decode it back exactly
    c = _mk(client, name)
    assert c["name"] == name.strip()
    assert client.get(f"/api/characters/{c['id']}").json()["character"]["name"] == name.strip()


def test_create_name_url_encoded_by_hand(client):
    r = client.post("/api/characters?name=" + quote("Tom & Jerry? #1 李", safe=""),
                    content=b"x", headers={"X-Filename": "a.png"})
    assert r.status_code == 200 and r.json()["character"]["name"] == "Tom & Jerry? #1 李"


def test_create_bad_metadata_ignored(client):
    m = _mk(client, width="-3", height="abc")["media"][0]
    assert (m["width"], m["height"]) == (None, None)


def test_create_face_filename_is_sanitised(client, out):
    c = _mk(client, face=quote("../../evil.png"))
    m = c["media"][0]
    assert m["label"] == "evil.png"
    assert resolve_local(m["local"]).parent == (out / "characters" / c["id"]).resolve()
    assert not (out / "evil.png").exists()


def test_create_x_filename_percent_and_raw_utf8(client):
    assert _mk(client, face=quote("Zoë ✓.png"))["media"][0]["label"] == "Zoë ✓.png"
    assert _mk(client, "b", face="Zoë.png")["media"][0]["label"] == "Zoë.png"


def test_two_characters_get_separate_folders(client, out):
    a, b = _mk(client, "a"), _mk(client, "b")
    assert a["id"] != b["id"]
    assert len(list((out / "characters").iterdir())) == 2


def test_get_unknown_404(client):
    r = client.get("/api/characters/char_" + "0" * 32)
    assert r.status_code == 404 and r.json()["ok"] is False
    assert client.get("/api/characters/nonsense").status_code == 404


def test_patch(client):
    c = _legacy(client)
    r = client.patch(f"/api/characters/{c['id']}", json={"name": "Bea", "description": "x"})
    j = r.json()
    assert j["ok"] and j["character"]["name"] == "Bea" and j["character"]["description"] == "x"
    assert client.get(f"/api/characters/{c['id']}").json()["character"]["name"] == "Bea"
    assert client.patch(f"/api/characters/{c['id']}", json={"name": " "}).status_code == 422
    assert client.patch(f"/api/characters/{c['id']}", json={"name": 4}).status_code == 422
    assert client.patch("/api/characters/char_" + "0" * 32, json={"name": "a"}).status_code == 404
    assert client.patch(f"/api/characters/{c['id']}", content=b"x").status_code == 422


def test_patch_defaults(client):
    a, b = _legacy(client, "a"), _legacy(client, "b")
    i1 = _up(client, a["id"], name="1.png").json()["media"]
    i2 = _up(client, a["id"], name="2.png").json()["media"]
    v = _up(client, a["id"], kind="audio", name="v.mp3").json()["media"]
    foreign = _up(client, b["id"], name="f.png").json()["media"]
    r = client.patch(f"/api/characters/{a['id']}", json={"default_face_id": i2["id"]})
    assert r.json()["character"]["default_face_id"] == i2["id"]
    for bad in (foreign["id"], v["id"], "zzz", 1):
        r = client.patch(f"/api/characters/{a['id']}", json={"default_face_id": bad})
        assert r.status_code == 422, bad
    assert client.patch(f"/api/characters/{a['id']}", json={"default_audio_id": i1["id"]}).status_code == 422
    r = client.patch(f"/api/characters/{a['id']}", json={"default_audio_id": None})
    assert r.json()["character"]["default_audio_id"] is None
    assert r.json()["character"]["default_face_id"] == i2["id"]


FACE_REQUIRED = {"ok": False, "error": "A character needs a face."}
LAST_IMAGE = {"ok": False, "error": "A character needs a face. Add another image before removing this one."}


def test_patch_cannot_clear_the_face(client):
    c = _mk(client)
    r = client.patch(f"/api/characters/{c['id']}", json={"default_face_id": None})
    assert r.status_code == 422 and r.json() == FACE_REQUIRED
    assert client.get(f"/api/characters/{c['id']}").json()["character"]["default_face_id"] == c["default_face_id"]
    # the rest of the same patch is not applied either
    r = client.patch(f"/api/characters/{c['id']}", json={"name": "Zed", "default_face_id": None})
    assert r.status_code == 422
    assert client.get(f"/api/characters/{c['id']}").json()["character"]["name"] == "Ana"


def test_patch_null_face_on_a_character_without_images_is_a_noop(client):
    c = _legacy(client)
    r = client.patch(f"/api/characters/{c['id']}", json={"default_face_id": None})
    assert r.status_code == 200 and r.json()["character"]["default_face_id"] is None
    v = _up(client, c["id"], kind="audio", name="v.mp3").json()["media"]
    assert v and client.patch(f"/api/characters/{c['id']}", json={"default_face_id": None}).status_code == 200


def test_cannot_remove_the_last_image(client):
    c = _mk(client)
    face = c["media"][0]
    r = client.delete(f"/api/characters/{c['id']}/media/{face['id']}")
    assert r.status_code == 422 and r.json() == LAST_IMAGE
    got = client.get(f"/api/characters/{c['id']}").json()["character"]
    assert got["default_face_id"] == face["id"] and [m["id"] for m in got["media"]] == [face["id"]]
    assert resolve_local(face["local"]).read_bytes() == b"FACE-BYTES"


def test_removing_the_face_moves_the_default_while_other_images_exist(client):
    c = _mk(client)
    face = c["media"][0]
    second = _up(client, c["id"], name="2.png").json()["media"]
    third = _up(client, c["id"], name="3.png").json()["media"]
    r = client.delete(f"/api/characters/{c['id']}/media/{face['id']}")
    assert r.status_code == 200 and r.json()["character"]["default_face_id"] == second["id"]
    assert not resolve_local(face["local"]).exists()
    r = client.delete(f"/api/characters/{c['id']}/media/{second['id']}")
    assert r.json()["character"]["default_face_id"] == third["id"]
    assert client.delete(f"/api/characters/{c['id']}/media/{third['id']}").status_code == 422


def test_non_image_media_can_always_be_removed(client):
    c = _mk(client)
    v = _up(client, c["id"], kind="audio", name="v.mp3").json()["media"]
    clip = _up(client, c["id"], kind="video", name="v.mp4").json()["media"]
    assert client.delete(f"/api/characters/{c['id']}/media/{v['id']}").status_code == 200
    assert client.delete(f"/api/characters/{c['id']}/media/{clip['id']}").status_code == 200


def test_character_without_images_still_works_everywhere(client, out):
    c = _legacy(client, "Old")
    assert [x["id"] for x in client.get("/api/characters").json()["characters"]] == [c["id"]]
    assert client.get(f"/api/characters/{c['id']}").status_code == 200
    r = client.patch(f"/api/characters/{c['id']}", json={"name": "Older", "description": "d"})
    assert r.status_code == 200 and r.json()["character"]["name"] == "Older"
    m = _up(client, c["id"], name="first.png").json()
    assert m["character"]["default_face_id"] == m["media"]["id"]
    d = _legacy(client, "Gone")
    assert client.delete(f"/api/characters/{d['id']}").json() == {"ok": True}


def test_no_route_creates_a_faceless_character(client):
    for kwargs in ({"json": {"name": "A"}}, {"params": {"name": "A"}}, {"content": b"x"}):
        assert client.post("/api/characters", **kwargs).status_code in (400, 422)
    assert client.get("/api/characters").json()["characters"] == []


def test_create_failure_while_writing_leaves_nothing(client, out, monkeypatch):
    def boom(self, data):
        raise OSError(28, "No space left on device")

    with monkeypatch.context() as mp:
        mp.setattr(Path, "write_bytes", boom)
        r = _post(client, {"name": "Ana"}, headers={"X-Filename": "a.png"})
    assert r.status_code == 500 and r.json()["ok"] is False
    _nothing_left(client, out)


def test_create_failure_in_the_database_leaves_no_file(client, out, monkeypatch):
    with monkeypatch.context() as mp:
        mp.setattr(characters, "_positive_int", lambda v: (_ for _ in ()).throw(RuntimeError("db down")))
        with pytest.raises(RuntimeError):
            _post(client, {"name": "Ana", "width": "5"}, headers={"X-Filename": "a.png"})
    _nothing_left(client, out)


def test_upload_bytes_and_local(client, out):
    c = _legacy(client)
    r = _up(client, c["id"], name="José's face (1).png", data=b"PNG\x00\xffbytes",
            width="640", height="480")
    j = r.json()
    assert r.status_code == 200 and j["ok"]
    m = j["media"]
    assert m["kind"] == "image" and m["label"] == "José's face (1).png"
    assert m["local"].startswith(f"/outputs/characters/{c['id']}/")
    assert " " not in m["local"] and "%20" in m["local"]
    p = resolve_local(m["local"])
    assert p.read_bytes() == b"PNG\x00\xffbytes"
    assert p.parent == (out / "characters" / c["id"]).resolve()
    assert (m["width"], m["height"], m["size_bytes"]) == (640, 480, 10)
    assert j["character"]["default_face_id"] == m["id"]
    assert j["character"]["media"] == [m]


def test_x_filename_percent_and_raw_utf8(client):
    c = _legacy(client)
    m = _up(client, c["id"], name=quote("Zoë ✓.png")).json()["media"]
    assert m["label"] == "Zoë ✓.png"
    r = client.post(f"/api/characters/{c['id']}/media", params={"kind": "image"},
                    content=b"x", headers={"X-Filename": "Zoë.png".encode("utf-8")})
    assert r.json()["media"]["label"] == "Zoë.png"
    assert resolve_local(r.json()["media"]["local"]).exists()


def test_filename_traversal(client, out):
    c = _legacy(client)
    m = _up(client, c["id"], name=quote("../../evil.png")).json()["media"]
    assert m["label"] == "evil.png"
    assert resolve_local(m["local"]).parent == (out / "characters" / c["id"]).resolve()
    assert not (out / "evil.png").exists()
    m = _up(client, c["id"], name="a/b\\c.png").json()["media"]
    assert m["label"] == "c.png"


def test_missing_filename_header_rejected(client):
    c = _legacy(client)
    r = client.post(f"/api/characters/{c['id']}/media", params={"kind": "image"}, content=b"x")
    assert r.status_code == 422


def test_upload_errors(client, out):
    c = _legacy(client)
    assert _up(client, c["id"], data=b"").status_code == 400
    assert _up(client, c["id"], kind="gif").status_code == 422
    assert client.post(f"/api/characters/{c['id']}/media", content=b"x",
                       headers={"X-Filename": "a.png"}).status_code == 422
    assert _up(client, c["id"], name="a.exe").status_code == 422
    assert _up(client, c["id"], kind="video", name="a.png").status_code == 422
    assert _up(client, "char_" + "0" * 32).status_code == 404
    assert _up(client, "../..").status_code in (404, 405)
    r = _up(client, c["id"], name="a.exe")
    assert r.json()["ok"] is False and r.json()["error"]
    assert client.get(f"/api/characters/{c['id']}").json()["character"]["media"] == []
    assert not any((out / "characters" / c["id"]).iterdir()) if (out / "characters" / c["id"]).exists() else True


def test_bad_metadata_ignored(client):
    c = _legacy(client)
    m = _up(client, c["id"], kind="video", name="v.mp4", width="-3", height="abc",
            duration_s="nan").json()["media"]
    assert (m["width"], m["height"], m["duration_s"]) == (None, None, None)
    m = _up(client, c["id"], kind="video", name="v2.mp4", duration_s="2.5").json()["media"]
    assert m["duration_s"] == 2.5


def test_defaults_and_audio(client):
    c = _legacy(client)
    a = _up(client, c["id"], kind="audio", name="a.wav").json()
    assert a["character"]["default_audio_id"] == a["media"]["id"]
    v1 = _up(client, c["id"], kind="voice", name="v.wav").json()
    v2 = _up(client, c["id"], kind="audio", name="w.wav").json()
    assert v1["media"]["kind"] == "audio" and v2["character"]["default_audio_id"] == a["media"]["id"]
    assert (v1["media"]["position"], v2["media"]["position"]) == (1, 2)


def test_delete_media_flow(client, out):
    c = _legacy(client)
    m1 = _up(client, c["id"], name="1.png").json()["media"]
    m2 = _up(client, c["id"], name="2.png").json()["media"]
    p1 = resolve_local(m1["local"])
    r = client.delete(f"/api/characters/{c['id']}/media/{m1['id']}")
    j = r.json()
    assert j["ok"] and j["character"]["default_face_id"] == m2["id"]
    assert [(m["id"], m["position"]) for m in j["character"]["media"]] == [(m2["id"], 0)]
    assert not p1.exists()
    assert client.delete(f"/api/characters/{c['id']}/media/{m2['id']}").status_code == 422
    assert client.delete(f"/api/characters/{c['id']}/media/{m1['id']}").status_code == 404
    assert client.delete(f"/api/characters/nope/media/{m2['id']}").status_code == 404


def test_delete_media_other_characters_untouched(client):
    a, b = _legacy(client, "a"), _legacy(client, "b")
    mb = _up(client, b["id"], name="b.png").json()["media"]
    assert client.delete(f"/api/characters/{a['id']}/media/{mb['id']}").status_code == 404
    assert client.delete(f"/api/characters/{a['id']}/media/..%2F..%2Fx").status_code == 404
    assert resolve_local(mb["local"]).exists()
    assert len(client.get(f"/api/characters/{b['id']}").json()["character"]["media"]) == 1
    assert client.get(f"/api/characters/{a['id']}").json()["character"]["media"] == []


def test_delete_character(client, out):
    a, b = _legacy(client, "a"), _legacy(client, "b")
    _up(client, a["id"], name="a.png")
    mb = _up(client, b["id"], name="b.png").json()["media"]
    (out / "keep.txt").write_text("k")
    r = client.delete(f"/api/characters/{a['id']}")
    assert r.json() == {"ok": True}
    assert not (out / "characters" / a["id"]).exists()
    assert resolve_local(mb["local"]).exists() and (out / "keep.txt").exists()
    assert client.get(f"/api/characters/{a['id']}").status_code == 404
    assert client.delete(f"/api/characters/{a['id']}").status_code == 404
    assert [c["id"] for c in client.get("/api/characters").json()["characters"]] == [b["id"]]


def test_delete_traversal_id(client, out):
    victim = out / "victim"
    victim.mkdir()
    (victim / "f").write_bytes(b"1")
    for bad in ["..", "%2e%2e", "char_%2F..%2F..%2Fvictim"]:
        assert client.delete(f"/api/characters/{bad}").status_code in (404, 405)
    assert (victim / "f").exists()


def test_reorder(client):
    c = _legacy(client)
    ms = [_up(client, c["id"], name=f"{i}.png").json()["media"] for i in range(3)]
    ids = [ms[2]["id"], ms[1]["id"], ms[0]["id"]]
    r = client.put(f"/api/characters/{c['id']}/media/order", json={"kind": "image", "ids": ids})
    assert r.json()["ok"]
    assert [m["id"] for m in r.json()["character"]["media"]] == ids
    assert [m["position"] for m in r.json()["character"]["media"]] == [0, 1, 2]
    got = client.get(f"/api/characters/{c['id']}").json()["character"]["media"]
    assert [m["id"] for m in got] == ids


def test_reorder_mismatch(client):
    a, b = _legacy(client, "a"), _legacy(client, "b")
    m1 = _up(client, a["id"], name="1.png").json()["media"]
    m2 = _up(client, a["id"], name="2.png").json()["media"]
    mb = _up(client, b["id"], name="b.png").json()["media"]
    url = f"/api/characters/{a['id']}/media/order"
    for body in ({"kind": "image", "ids": [m1["id"]]},
                 {"kind": "image", "ids": [m1["id"], m2["id"], mb["id"]]},
                 {"kind": "image", "ids": [m1["id"], m1["id"]]},
                 {"kind": "video", "ids": [m1["id"]]},
                 {"kind": "image", "ids": "x"}, {"kind": "image"}, {"ids": []}):
        r = client.put(url, json=body)
        assert r.status_code == 422 and r.json()["ok"] is False, body
    assert client.put("/api/characters/char_" + "0" * 32 + "/media/order",
                      json={"kind": "image", "ids": []}).status_code == 404
    got = client.get(f"/api/characters/{a['id']}").json()["character"]["media"]
    assert [m["id"] for m in got] == [m1["id"], m2["id"]]


def test_main_wires_routes_and_cors():
    from backend import main

    paths = {r.path for r in main.app.routes}
    assert "/api/characters" in paths and "/api/characters/{character_id}/media" in paths
    # Media uploads go straight to the backend (directBackendUrl), so the app's
    # own origin must pass CORS; other sites must not (backend/origin_guard.py).
    from fastapi.testclient import TestClient

    c = TestClient(main.app)
    url = "/api/characters/char_x/media"
    ok = c.options(url, headers={"Origin": "http://localhost:47300", "Access-Control-Request-Method": "POST",
                                 "Access-Control-Request-Headers": "content-type"})
    assert ok.status_code == 200 and ok.headers["access-control-allow-origin"] == "http://localhost:47300"
    bad = c.options(url, headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in bad.headers
