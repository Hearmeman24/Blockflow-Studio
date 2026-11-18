"""The output folder takes effect immediately and earlier folders stay readable.

`backend.output_folder` is the single source of truth: `current()` is the
folder new files go to, `search_roots()` adds earlier folders (most recent
first) for reading, `locate()` maps an /outputs path to a file, and
`switch_to()` changes the folder at runtime. Every writer and reader asks it
at use time; nothing keeps a copy from import time.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import threading
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import config, output_folder, settings_routes, settings_store

ROOT = Path(__file__).resolve().parent.parent
posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlinks")


@pytest.fixture
def folders(tmp_path, monkeypatch):
    """Fresh settings DB, a default folder and two candidate folders."""
    monkeypatch.setattr(settings_store, "DB_PATH", tmp_path / "settings.db")
    settings_store.init_db()
    data = tmp_path / "data"
    (data / "output").mkdir(parents=True)
    monkeypatch.setattr(config, "USER_DATA_DIR", data)
    output_folder.reload()
    a, b = tmp_path / "A", tmp_path / "B"
    a.mkdir()
    b.mkdir()
    yield {"default": data / "output", "a": a, "b": b, "tmp": tmp_path}
    output_folder.reload()


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(settings_routes.router)
    app.mount("/outputs", output_folder.OutputsStaticFiles(), name="outputs")
    return TestClient(app)


def _load_sidecar(slug: str):
    path = ROOT / "custom_blocks" / slug / "backend.block.py"
    spec = importlib.util.spec_from_file_location(f"_test_sidecar_{slug}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# === resolver ===============================================================

def test_default_until_switched(folders):
    assert output_folder.current() == folders["default"]
    assert folders["default"].is_dir()
    assert output_folder.search_roots() == [folders["default"]]


def test_switch_takes_effect_immediately_and_remembers_the_previous_folder(folders):
    output_folder.switch_to(str(folders["a"]))
    assert output_folder.current() == folders["a"]
    assert settings_store.get_app_pref("output_dir") == str(folders["a"])
    assert output_folder.previous() == [folders["default"]]
    assert output_folder.search_roots() == [folders["a"], folders["default"]]

    output_folder.switch_to(str(folders["b"]))
    assert output_folder.previous() == [folders["a"], folders["default"]]
    assert json.loads(settings_store.get_app_pref("output_dir_previous")) == [
        str(folders["a"]), str(folders["default"])]


def test_switching_back_removes_the_folder_from_the_earlier_list(folders):
    output_folder.switch_to(str(folders["a"]))
    output_folder.switch_to(None)  # back to the default
    assert output_folder.current() == folders["default"]
    assert settings_store.get_app_pref("output_dir") == ""
    assert output_folder.previous() == [folders["a"]]


def test_earlier_list_is_capped(folders):
    for i in range(output_folder.MAX_PREVIOUS + 3):
        d = folders["tmp"] / f"f{i}"
        d.mkdir()
        output_folder.switch_to(str(d))
    assert len(output_folder.previous()) == output_folder.MAX_PREVIOUS


def test_state_survives_a_reload_from_prefs(folders):
    output_folder.switch_to(str(folders["a"]))
    output_folder.reload()
    assert output_folder.current() == folders["a"]
    assert output_folder.previous() == [folders["default"]]


def test_missing_current_folder_falls_back_to_default(folders):
    gone = folders["tmp"] / "unplugged"
    gone.mkdir()
    output_folder.switch_to(str(gone))
    gone.rmdir()
    assert output_folder.current() == folders["default"]
    status = output_folder.output_folder_status(settings_store, {"available": True, "reason": None})
    assert status["configured_unavailable"] is True
    assert status["in_use"] == str(folders["default"])
    assert "restart_required" not in status


def test_missing_earlier_folders_are_skipped_for_reading(folders):
    output_folder.switch_to(str(folders["a"]))
    output_folder.switch_to(str(folders["b"]))
    os.rmdir(folders["a"])
    assert output_folder.search_roots() == [folders["b"], folders["default"]]
    assert folders["a"] in output_folder.previous()  # kept in the list, just skipped


def test_windows_style_paths_in_the_stored_list(folders):
    settings_store.set_app_pref("output_dir_previous", json.dumps([r"D:\Renders\Old", r"\\nas\share\bf"]))
    output_folder.reload()
    assert [str(p) for p in output_folder.previous()] == [r"D:\Renders\Old", r"\\nas\share\bf"]
    status = output_folder.output_folder_status(settings_store, {"available": True, "reason": None})
    assert status["previous"] == [
        {"path": r"D:\Renders\Old", "available": False},
        {"path": r"\\nas\share\bf", "available": False},
    ]
    assert output_folder.search_roots() == [folders["default"]]


@pytest.mark.parametrize("raw", ["not json", "{}", "[1, 2]", '["", "  "]'])
def test_malformed_stored_list_is_ignored(folders, raw):
    settings_store.set_app_pref("output_dir_previous", raw)
    output_folder.reload()
    assert output_folder.previous() == []


def test_forget_previous(folders):
    output_folder.switch_to(str(folders["a"]))
    output_folder.switch_to(str(folders["b"]))
    assert output_folder.forget_previous(str(folders["a"])) is True
    assert output_folder.previous() == [folders["default"]]
    assert output_folder.forget_previous(str(folders["a"])) is False


# === locate =================================================================

def test_locate_prefers_the_current_folder(folders):
    (folders["default"] / "same.png").write_bytes(b"old")
    output_folder.switch_to(str(folders["a"]))
    (folders["a"] / "same.png").write_bytes(b"new")
    (folders["default"] / "only-old.png").write_bytes(b"x")
    assert output_folder.locate("/outputs/same.png") == folders["a"] / "same.png"
    assert output_folder.locate("/outputs/only-old.png") == folders["default"] / "only-old.png"
    # Not found anywhere: the would-be path in the current folder.
    assert output_folder.locate("/outputs/nope.png") == folders["a"] / "nope.png"


def test_locate_decodes_and_strips_query(folders):
    (folders["default"] / "a b.png").write_bytes(b"x")
    assert output_folder.locate("/outputs/a%20b.png?x=1#f") == folders["default"] / "a b.png"


@pytest.mark.parametrize("value", ["/outputs/../secret.txt", "/outputs/%2e%2e/secret.txt",
                                   "/outputs/sub/../../secret.txt", "/outputs/a\x00b"])
def test_locate_refuses_traversal(folders, value):
    (folders["tmp"] / "secret.txt").write_text("s")
    with pytest.raises(output_folder.UnsafeOutputPath):
        output_folder.locate(value)


@posix_only
def test_locate_refuses_symlink_escape_in_every_folder(folders):
    secret = folders["tmp"] / "secret.txt"
    secret.write_text("s")
    (folders["default"] / "leak.txt").symlink_to(secret)
    output_folder.switch_to(str(folders["a"]))
    (folders["a"] / "leak2.txt").symlink_to(secret)
    for value in ("/outputs/leak.txt", "/outputs/leak2.txt"):
        try:
            found = output_folder.locate(value)
        except output_folder.UnsafeOutputPath:
            continue
        # Skipped: at most a not-yet-existing path in the current folder.
        assert not found.exists()
        assert found.resolve() != secret.resolve()


def test_to_outputs_url_for_files_in_any_folder(folders):
    (folders["default"] / "old.png").write_bytes(b"x")
    output_folder.switch_to(str(folders["a"]))
    assert output_folder.to_outputs_url(folders["default"] / "old.png") == "/outputs/old.png"
    assert output_folder.to_outputs_url(folders["a"] / "sub" / "n.png") == "/outputs/sub/n.png"
    assert output_folder.to_outputs_url(folders["tmp"] / "elsewhere.png") is None


# === serving /outputs =======================================================

def test_serving_follows_the_switch_without_restart(folders):
    client = _client()
    (folders["default"] / "old.png").write_bytes(b"OLD")
    assert client.get("/outputs/old.png").content == b"OLD"

    output_folder.switch_to(str(folders["a"]))
    (folders["a"] / "new.png").write_bytes(b"NEW")
    assert client.get("/outputs/new.png").content == b"NEW"
    assert client.get("/outputs/old.png").content == b"OLD"  # earlier folder still served


def test_serving_precedence_and_content_type(folders):
    client = _client()
    (folders["default"] / "same.png").write_bytes(b"OLD")
    output_folder.switch_to(str(folders["a"]))
    (folders["a"] / "same.png").write_bytes(b"NEW")
    r = client.get("/outputs/same.png")
    assert r.content == b"NEW"
    assert r.headers["content-type"] == "image/png"
    assert "etag" in r.headers and "last-modified" in r.headers


def test_serving_stops_reading_a_forgotten_folder(folders):
    client = _client()
    (folders["default"] / "old.png").write_bytes(b"OLD")
    output_folder.switch_to(str(folders["a"]))
    output_folder.forget_previous(str(folders["default"]))
    assert client.get("/outputs/old.png").status_code == 404


def test_range_requests(folders):
    client = _client()
    (folders["default"] / "clip.mp4").write_bytes(bytes(range(100)))
    output_folder.switch_to(str(folders["a"]))
    r = client.get("/outputs/clip.mp4", headers={"Range": "bytes=10-19"})
    assert r.status_code == 206
    assert r.content == bytes(range(10, 20))
    assert r.headers["content-type"] == "video/mp4"


@pytest.mark.parametrize("path", ["/outputs/../settings.db", "/outputs/%2e%2e/settings.db",
                                  "/outputs/..%2fsettings.db"])
def test_serving_refuses_traversal(folders, path):
    client = _client()
    assert client.get(path).status_code == 404


@posix_only
def test_serving_refuses_symlink_escape_from_each_folder(folders):
    client = _client()
    secret = folders["tmp"] / "secret.txt"
    secret.write_text("TOP SECRET")
    (folders["default"] / "leak.txt").symlink_to(secret)
    output_folder.switch_to(str(folders["a"]))
    (folders["a"] / "leak2.txt").symlink_to(secret)
    for name in ("leak.txt", "leak2.txt"):
        r = client.get(f"/outputs/{name}")
        assert r.status_code == 404
        assert b"TOP SECRET" not in r.content


# === every writer and reader uses the resolver ==============================

def test_loader_sidecars_write_to_the_current_folder(folders):
    for slug, field in (("upload_image_to_tmpfiles", "image_url"), ("video_loader", "video_url")):
        module = _load_sidecar(slug)
        app = FastAPI()
        app.include_router(module.router, prefix=f"/api/blocks/{slug}")
        client = TestClient(app)

        output_folder.switch_to(str(folders["a"]))
        body = client.post(f"/api/blocks/{slug}/save-local", content=f"{slug}-1".encode(),
                           headers={"X-Filename": "x.bin"}).json()
        assert (folders["a"] / body[field].removeprefix("/outputs/")).read_bytes() == f"{slug}-1".encode()

        output_folder.switch_to(str(folders["b"]))
        body = client.post(f"/api/blocks/{slug}/save-local", content=f"{slug}-2".encode(),
                           headers={"X-Filename": "y.bin"}).json()
        assert (folders["b"] / body[field].removeprefix("/outputs/")).read_bytes() == f"{slug}-2".encode()


def test_video_fx_and_stitcher_follow_the_switch(folders):
    fx = _load_sidecar("video_fx")
    st = _load_sidecar("video_stitcher")
    output_folder.switch_to(str(folders["a"]))
    assert fx._fx_dir() == folders["a"] / "fx"
    assert st._stitched_dir() == folders["a"] / "stitched"
    (folders["a"] / "clip.mp4").write_bytes(b"x")
    output_folder.switch_to(str(folders["b"]))
    assert fx._fx_dir() == folders["b"] / "fx"
    assert st._stitched_dir() == folders["b"] / "stitched"
    # Sources saved in the earlier folder are still found.
    assert fx._resolve_to_local("/outputs/clip.mp4") == folders["a"] / "clip.mp4"
    assert st._resolve_to_local("/outputs/clip.mp4") == folders["a"] / "clip.mp4"
    with pytest.raises(ValueError):
        fx._resolve_to_local("/outputs/../escape.mp4")
    with pytest.raises(ValueError):
        st._resolve_to_local("/outputs/../escape.mp4")


def test_byok_download_and_reference_resolution_follow_the_switch(folders, monkeypatch):
    from backend.byok import references, service

    class Resp:
        status = 200
        headers = {"Content-Type": "image/png"}

        def __init__(self):
            self.chunks = [b"PNG"]

        def read(self, n):
            return self.chunks.pop() if self.chunks else b""

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(service, "open_url", lambda url, timeout: Resp())
    output_folder.switch_to(str(folders["a"]))
    url = service.download_output("https://cdn.example.com/x.png", "image", "job1")
    rel = url.removeprefix("/outputs/")
    assert (folders["a"] / rel).read_bytes() == b"PNG"

    output_folder.switch_to(str(folders["b"]))
    assert references.output_root() == folders["b"]
    assert references.resolve_local(url) == (folders["a"] / rel).resolve()
    assert references.local_file(url) == (folders["a"] / rel).resolve()
    checked = references.check_references([{"kind": "image", "local": url}])
    assert checked[0]["status"] == "ok"

    output_folder.forget_previous(str(folders["a"]))
    checked = references.check_references([{"kind": "image", "local": url}])
    assert checked[0]["status"] == "missing_local"


def test_switch_during_a_download_finishes_where_it_started(folders, monkeypatch):
    """In-flight downloads keep writing to the folder they started in, and the
    finished file is still served after the switch."""
    from backend.byok import service

    started, release = threading.Event(), threading.Event()

    class SlowResp:
        status = 200
        headers = {"Content-Type": "image/png"}

        def __init__(self):
            self.sent = False

        def read(self, n):
            if self.sent:
                return b""
            started.set()
            release.wait(5)
            self.sent = True
            return b"DATA"

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(service, "open_url", lambda url, timeout: SlowResp())
    output_folder.switch_to(str(folders["a"]))
    result: list[str] = []
    t = threading.Thread(target=lambda: result.append(
        service.download_output("https://cdn.example.com/x.png", "image", "slow")))
    t.start()
    assert started.wait(5)
    output_folder.switch_to(str(folders["b"]))
    release.set()
    t.join(5)

    rel = result[0].removeprefix("/outputs/")
    assert (folders["a"] / rel).read_bytes() == b"DATA"
    assert not (folders["b"] / rel).exists()
    assert not list((folders["a"] / service.OUTPUT_SUBDIR).glob("*.part"))
    assert _client().get(result[0]).content == b"DATA"


def test_media_tmpfiles_characters_and_mcp_follow_the_switch(folders):
    from backend import characters, mcp_runs, tmpfiles
    from backend.byok import media

    (folders["default"] / "old.png").write_bytes(b"x")
    output_folder.switch_to(str(folders["a"]))
    assert media.default_resolve_local("/outputs/old.png") == folders["default"] / "old.png"
    assert characters._characters_root() == folders["a"] / "characters"
    assert mcp_runs._app_local(str(folders["default"] / "old.png")) == "/outputs/old.png"

    captured = {}
    orig = tmpfiles.upload_to_tmpfiles
    tmpfiles.upload_to_tmpfiles = lambda p: captured.setdefault("path", p) and "https://tmpfiles.org/dl/1/x"
    try:
        tmpfiles.ensure_public_url("/outputs/old.png")
    finally:
        tmpfiles.upload_to_tmpfiles = orig
    assert captured["path"] == folders["default"] / "old.png"


def test_images_list_and_metadata_cover_every_folder(folders):
    from backend import routes

    (folders["default"] / "old.png").write_bytes(b"x")
    (folders["default"] / "same.png").write_bytes(b"old")
    output_folder.switch_to(str(folders["a"]))
    (folders["a"] / "new.png").write_bytes(b"x")
    (folders["a"] / "same.png").write_bytes(b"new")
    app = FastAPI()
    app.include_router(routes.router)
    client = TestClient(app)
    body = client.get("/api/images?limit=50").json()
    names = sorted(i["name"] for i in body["images"])
    assert names == ["new.png", "old.png", "same.png"]
    assert body["total"] == 3
    assert client.get("/api/file-metadata/old.png").status_code != 404
    assert client.get("/api/file-metadata/../settings.db").status_code == 404


def test_config_output_dir_is_the_resolver(folders):
    output_folder.switch_to(str(folders["a"]))
    assert config.output_dir() == folders["a"]
    assert config.LOCAL_OUTPUT_DIR == folders["a"]  # compatibility alias, resolved at access time
    output_folder.switch_to(str(folders["b"]))
    assert config.LOCAL_OUTPUT_DIR == folders["b"]


def test_no_module_keeps_an_import_time_copy():
    """Writers and readers must call the resolver, not hold a constant."""
    offenders = []
    files = [*(ROOT / "backend").rglob("*.py"), *(ROOT / "custom_blocks").rglob("*.py"),
             *(ROOT / "blockflow_mcp").rglob("*.py")]
    for path in files:
        if path.name == "output_folder.py":
            continue
        text = path.read_text()
        if "LOCAL_OUTPUT_DIR" in text and path.name != "config.py":
            offenders.append(str(path.relative_to(ROOT)))
        if path.name in ("backend.block.py",) and ("FX_DIR = " in text or "STITCHED_DIR = " in text):
            offenders.append(str(path.relative_to(ROOT)))
    assert offenders == []


# === routes =================================================================

def test_put_switches_immediately_and_status_lists_earlier_folders(folders):
    client = _client()
    (folders["default"] / "old.png").write_bytes(b"OLD")
    r = client.put("/api/settings/app-prefs/output_dir", json={"value": str(folders["a"])})
    assert r.status_code == 200
    assert output_folder.current() == folders["a"]
    body = client.get("/api/settings/output-folder").json()
    assert body["in_use"] == str(folders["a"])
    assert "restart_required" not in body
    assert body["previous"] == [{"path": str(folders["default"]), "available": True}]
    assert client.get("/outputs/old.png").content == b"OLD"


def test_forget_route(folders):
    client = _client()
    output_folder.switch_to(str(folders["a"]))
    r = client.post("/api/settings/output-folder/forget", json={"path": str(folders["default"])})
    assert r.status_code == 200
    assert r.json()["previous"] == []
    r = client.post("/api/settings/output-folder/forget", json={"path": "/not/in/list"})
    assert r.status_code == 404
    assert client.post("/api/settings/output-folder/forget", json={}).status_code == 422


def test_rejected_put_does_not_switch(folders):
    client = _client()
    f = folders["tmp"] / "file.txt"
    f.write_text("x")
    r = client.put("/api/settings/app-prefs/output_dir", json={"value": str(f)})
    assert r.status_code == 400
    assert output_folder.current() == folders["default"]
    assert output_folder.previous() == []
