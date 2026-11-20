"""Uploads stream to disk: no route holds the whole body in memory.

Every save/upload route (Video Loader, Image Loader, Video FX LUT, Characters)
receives its body through ``backend.upload_stream``: chunks go to a temp file
next to the destination, which is renamed into place. A body that stops (the
client went away), passes a size limit or fails leaves no file behind. The
blocking work of these routes (hashing, the duplicate scan, image processing,
the tmpfiles upload, the character store) runs off the event loop.

The routes are driven through a fake ASGI receive channel that hands out the
body in many chunks, so the memory held is measured, not assumed.
"""
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
import pathlib
import tracemalloc
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect, Request

from backend import asset_uploads, character_routes, characters, db, image_payload, output_folder, upload_stream

ROOT = Path(__file__).resolve().parent.parent
CHUNK = 64 * 1024
N_CHUNKS = 128  # 8 MiB in all


def _load_sidecar(slug: str):
    path = ROOT / "custom_blocks" / slug / "backend.block.py"
    spec = importlib.util.spec_from_file_location(f"_test_upload_sidecar_{slug}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def out(tmp_path, monkeypatch):
    o = tmp_path / "outputs"
    o.mkdir()
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t.db")
    monkeypatch.setattr(output_folder, "_state", output_folder.pinned_state(o))
    return o


@pytest.fixture
def app(out):
    app = FastAPI()
    for slug in ("video_loader", "upload_image_to_tmpfiles", "video_fx"):
        app.include_router(_load_sidecar(slug).router, prefix=f"/api/blocks/{slug}")
    app.include_router(character_routes.router)
    return app


def _chunk(i: int) -> bytes:
    return i.to_bytes(2, "big") * (CHUNK // 2)


def _expected_sha(n: int = N_CHUNKS) -> str:
    h = hashlib.sha256()
    for i in range(n):
        h.update(_chunk(i))
    return h.hexdigest()


def _call(app, method: str, path: str, *, headers: dict[str, str], query: str = "", n_chunks: int = N_CHUNKS,
          disconnect_after: int | None = None) -> tuple[int | None, dict | None, int]:
    """Run one request through the ASGI app with a body sent in ``n_chunks``
    chunks, built lazily so the test never holds the body. Returns (status,
    JSON body, chunks handed out). ``disconnect_after``: the client goes away
    after that many chunks."""
    state = {"sent": 0, "status": None, "body": b"", "done": None}

    async def receive():
        i = state["sent"]
        if disconnect_after is not None and i >= disconnect_after:
            return {"type": "http.disconnect"}
        if i >= n_chunks:  # body finished: later reads wait for the end of the response
            await state["done"].wait()
            return {"type": "http.disconnect"}
        state["sent"] = i + 1
        return {"type": "http.request", "body": _chunk(i), "more_body": i + 1 < n_chunks}

    async def send(message):
        if message["type"] == "http.response.start":
            state["status"] = message["status"]
        elif message["type"] == "http.response.body":
            state["body"] += message.get("body", b"")

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method, "scheme": "http",
        "path": path, "raw_path": path.encode(), "root_path": "", "query_string": query.encode(),
        "headers": [(k.lower().encode(), v.encode("latin-1")) for k, v in headers.items()],
        "client": ("127.0.0.1", 1), "server": ("127.0.0.1", 47301),
    }

    async def run():
        state["done"] = asyncio.Event()
        try:
            await app(scope, receive, send)
        except ClientDisconnect:  # as with request.body(): the server drops the request
            pass
        finally:
            state["done"].set()

    asyncio.run(run())
    try:
        parsed = json.loads(state["body"]) if state["body"] else None
    except ValueError:  # a plain-text error page
        parsed = None
    return state["status"], parsed, state["sent"]


def _files(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*") if p.is_file())


def _make_character(out) -> str:
    client = TestClient(_app_with_characters())
    r = client.post("/api/characters", params={"name": "Ana"}, content=b"FACE", headers={"X-Filename": "f.png"})
    assert r.status_code == 200, r.text
    return r.json()["character"]["id"]


def _app_with_characters() -> FastAPI:
    app = FastAPI()
    app.include_router(character_routes.router)
    return app


def _routes(out) -> list[tuple[str, str, dict[str, str], str, callable]]:
    """(name, path, headers, query, saved-file getter from the JSON body)."""
    def outputs(field):
        return lambda body: out / body[field].removeprefix("/outputs/")

    def character_media(body):
        return _resolve(body["media"]["local"])

    def character_face(body):
        return _resolve(body["character"]["media"][0]["local"])

    return [
        ("video save-local", "/api/blocks/video_loader/save-local", {"X-Filename": "clip.mp4"}, "",
         outputs("video_url")),
        ("image save-local", "/api/blocks/upload_image_to_tmpfiles/save-local", {"X-Filename": "pic.png"}, "",
         outputs("image_url")),
        ("lut upload", "/api/blocks/video_fx/upload-lut", {"X-Filename": "look.cube"}, "",
         lambda body: Path(body["path"])),
        ("character create", "/api/characters", {"X-Filename": "face.png"}, "name=Ana", character_face),
        ("character media", "/api/characters/{cid}/media", {"X-Filename": "clip.mp4"}, "kind=video",
         character_media),
    ]


def _resolve(local: str) -> Path:
    from backend.byok.references import resolve_local

    return resolve_local(local)


@pytest.mark.parametrize("index", range(5), ids=[r[0] for r in _routes(Path("."))])
def test_route_streams_the_body_without_holding_it(app, out, index):
    name, path, headers, query, saved = _routes(out)[index]
    if "{cid}" in path:
        path = path.format(cid=_make_character(out))
    tracemalloc.start()
    try:
        tracemalloc.reset_peak()
        base = tracemalloc.get_traced_memory()[0]
        status, body, sent = _call(app, "POST", path, headers=headers, query=query)
        peak = tracemalloc.get_traced_memory()[1] - base
    finally:
        tracemalloc.stop()
    assert status == 200 and body and body.get("ok") is True, (status, body)
    assert sent == N_CHUNKS
    # 8 MiB went through; the route held at most a few chunks at a time.
    assert peak < 2 * 1024 * 1024, f"{name} held {peak / 1024 / 1024:.1f} MiB for an 8 MiB upload"
    file = saved(body)
    assert hashlib.sha256(file.read_bytes()).hexdigest() == _expected_sha()
    assert not [p for p in _files(out) if p.name.startswith(upload_stream.TEMP_PREFIX)]


@pytest.mark.parametrize("index", range(5), ids=[r[0] for r in _routes(Path("."))])
def test_an_aborted_upload_leaves_no_file(app, out, index):
    name, path, headers, query, _ = _routes(out)[index]
    if "{cid}" in path:
        path = path.format(cid=_make_character(out))
    before = _files(out)
    _call(app, "POST", path, headers=headers, query=query, disconnect_after=10)
    assert _files(out) == before, f"{name} left {set(_files(out)) - set(before)}"


# ------------------------------------------------------------------ the helper


def _request(n_chunks: int, *, content_length: int | None = None, fail_after: int | None = None):
    state = {"sent": 0}

    async def receive():
        i = state["sent"]
        if fail_after is not None and i >= fail_after:
            raise OSError("socket error")
        state["sent"] = i + 1
        return {"type": "http.request", "body": _chunk(i), "more_body": i + 1 < n_chunks}

    headers = [] if content_length is None else [(b"content-length", str(content_length).encode())]
    scope = {"type": "http", "method": "POST", "path": "/", "headers": headers, "query_string": b""}
    return Request(scope, receive), state


def test_helper_rejects_as_soon_as_the_limit_is_passed(tmp_path):
    request, state = _request(100)

    async def run():
        async with upload_stream.receive_upload(request, tmp_path, max_bytes=5 * CHUNK + 1):
            pass

    with pytest.raises(upload_stream.UploadTooLarge) as info:
        asyncio.run(run())
    assert info.value.limit == 5 * CHUNK + 1
    assert state["sent"] == 6  # the sixth chunk passed the limit; nothing more was read
    assert list(tmp_path.iterdir()) == []


def test_helper_refuses_a_declared_length_over_the_limit_without_reading(tmp_path):
    request, state = _request(100, content_length=100 * CHUNK)

    async def run():
        async with upload_stream.receive_upload(request, tmp_path, max_bytes=CHUNK):
            pass

    with pytest.raises(upload_stream.UploadTooLarge):
        asyncio.run(run())
    assert state["sent"] == 0
    assert list(tmp_path.iterdir()) == []


def test_helper_commits_by_rename_and_reports_size_and_hash(tmp_path):
    request, _ = _request(3)
    dest = tmp_path / "final.bin"

    async def run():
        async with upload_stream.receive_upload(request, tmp_path) as upload:
            assert upload.path.parent == tmp_path and upload.path.name.startswith(upload_stream.TEMP_PREFIX)
            assert upload.size == 3 * CHUNK
            assert upload.sha256 == _expected_sha(3)
            await upload.commit(dest)
        return upload

    upload = asyncio.run(run())
    assert hashlib.sha256(dest.read_bytes()).hexdigest() == _expected_sha(3)
    assert [p.name for p in tmp_path.iterdir()] == ["final.bin"]
    assert upload.size == 3 * CHUNK


@pytest.mark.parametrize("where", ["receive", "handler"])
def test_helper_removes_the_partial_file_on_an_error(tmp_path, where):
    request, _ = _request(10, fail_after=4 if where == "receive" else None)

    async def run():
        async with upload_stream.receive_upload(request, tmp_path):
            raise RuntimeError("handler failed")

    with pytest.raises((OSError, RuntimeError)):
        asyncio.run(run())
    assert list(tmp_path.iterdir()) == []


# ------------------------------------------------------------------ off the event loop


def _on_event_loop() -> bool:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


@pytest.fixture
def loop_guard(monkeypatch):
    """Wrap blocking calls so a call made on the event loop thread is recorded."""
    seen: dict[str, list[bool]] = {}

    def guard(owner, attr, label):
        original = getattr(owner, attr)

        def wrapper(*args, **kwargs):
            seen.setdefault(label, []).append(_on_event_loop())
            return original(*args, **kwargs)

        monkeypatch.setattr(owner, attr, wrapper)

    guard(pathlib.Path, "iterdir", "iterdir")
    guard(pathlib.Path, "write_bytes", "write")
    guard(pathlib.Path, "read_bytes", "read")
    guard(os, "replace", "write")
    guard(asset_uploads, "upload_asset", "upload_asset")
    guard(image_payload, "prepare_image_for_upload", "prepare_image")
    guard(characters, "create_character_with_face", "characters")
    guard(characters, "add_media", "characters")
    return seen


def test_blocking_work_runs_off_the_event_loop(app, out, loop_guard, monkeypatch):
    monkeypatch.setattr(asset_uploads, "get_asset_storage_mode", lambda: "tmpfiles")
    monkeypatch.setattr(asset_uploads, "_upload_to_tmpfiles", lambda data, name, ctype: "https://tmpfiles.test/dl/1")
    (out / "older.png").write_bytes(b"other")
    client = TestClient(app)
    png = (Path(__file__).parent / "fixtures").glob("*.png")
    png_bytes = next(iter(png), None)
    image = png_bytes.read_bytes() if png_bytes else _tiny_png()
    loop_guard.clear()

    assert client.post("/api/blocks/video_loader/save-local", content=b"v", headers={"X-Filename": "a.mp4"}).json()["ok"]
    assert client.post("/api/blocks/upload_image_to_tmpfiles/save-local", content=image,
                       headers={"X-Filename": "a.png"}).json()["ok"]
    assert client.post("/api/blocks/video_fx/upload-lut", content=b"LUT_3D_SIZE 2",
                       headers={"X-Filename": "a.cube"}).json()["ok"]
    assert client.post("/api/blocks/video_loader/upload", content=b"v", headers={"X-Filename": "a.mp4"}).json()["ok"]
    assert client.post("/api/blocks/upload_image_to_tmpfiles/upload", content=image,
                       headers={"X-Filename": "a.png", "X-Content-Type": "image/png"}).json()["ok"]
    made = client.post("/api/characters", params={"name": "Ana"}, content=b"FACE", headers={"X-Filename": "f.png"})
    cid = made.json()["character"]["id"]
    assert client.post(f"/api/characters/{cid}/media", params={"kind": "image"}, content=b"IMG",
                       headers={"X-Filename": "b.png"}).json()["ok"]

    for label in ("iterdir", "write", "upload_asset", "prepare_image", "characters"):
        assert loop_guard.get(label), f"{label} was never called"
    on_loop = {label: calls for label, calls in loop_guard.items() if any(calls)}
    assert on_loop == {}, f"blocking work ran on the event loop: {sorted(on_loop)}"


def _tiny_png() -> bytes:
    import struct
    import zlib

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    raw = b"\x00\xff\x00\x00"
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


# ------------------------------------------------------------------ behaviour kept


def test_image_duplicate_returns_the_first_file_and_ignores_the_upload_in_flight(app, out):
    client = TestClient(app)
    first = client.post("/api/blocks/upload_image_to_tmpfiles/save-local", content=b"SAME",
                        headers={"X-Filename": "a.png"}).json()
    again = client.post("/api/blocks/upload_image_to_tmpfiles/save-local", content=b"SAME",
                        headers={"X-Filename": "b.png"}).json()
    assert first["ok"] and again == {"ok": True, "image_url": first["image_url"]}
    assert [p.name for p in _files(out)] == [first["image_url"].removeprefix("/outputs/")]


@pytest.mark.parametrize("path,headers,expected", [
    ("/api/blocks/video_loader/save-local", {"X-Filename": "a.mp4"}, {"ok": False, "error": "empty body"}),
    ("/api/blocks/upload_image_to_tmpfiles/save-local", {"X-Filename": "a.png"}, {"ok": False, "error": "empty body"}),
    ("/api/blocks/video_fx/upload-lut", {"X-Filename": "a.cube"}, {"ok": False, "error": "Empty file"}),
    ("/api/blocks/video_loader/upload", {"X-Filename": "a.mp4"}, {"ok": False, "error": "empty body"}),
    ("/api/blocks/upload_image_to_tmpfiles/upload", {"X-Filename": "a.png"}, {"ok": False, "error": "empty body"}),
])
def test_empty_bodies_keep_their_answers_and_leave_nothing(app, out, path, headers, expected):
    r = TestClient(app).post(path, content=b"", headers=headers)
    assert r.status_code == 400 and r.json() == expected
    assert _files(out) == []
