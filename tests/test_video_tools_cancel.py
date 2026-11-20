"""Video FX and Video Stitcher stop their child processes when the client goes away.

The children are fakes: small Python scripts named ``ffmpeg``, ``ffprobe`` and
``rife`` put first on PATH (no real render, no real media). A "hanging" child
records its pid and sleeps; the request's ASGI receive channel reports a
disconnect once the child has started. The route must stop the child (it is
gone within a second or two, not after its sleep), remove the partial output
and return. Also covered: ``backend.cancellable`` on its own (cancel, timeout,
a child that ignores SIGTERM), one video at a time, and http sources streamed
to disk off the event loop.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI

from backend import cancellable, output_folder

ROOT = Path(__file__).resolve().parent.parent
HANG_S = 8  # a fake child sleeps this long; a stopped one is gone long before
posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals and shebang scripts")

FAKE_FFMPEG = r'''
import os, sys, time, json
args = sys.argv[1:]
mode = os.environ.get("FAKE_MODE", "quick")
log = os.environ.get("FAKE_LOG")
out = args[-1]
if "%08d" in out:  # RIFE frame extraction: make two frames and stop
    d = os.path.dirname(out)
    for i in (1, 2):
        open(os.path.join(d, "%08d.png" % i), "wb").write(b"png")
    sys.exit(0)
if log:
    with open(log, "a") as fh:
        fh.write(json.dumps({"event": "start", "t": time.time(), "out": out}) + "\n")
if mode == "hang":
    open(out, "wb").write(b"partial")
    open(os.path.join(os.environ["FAKE_PIDS"], str(os.getpid())), "w").write(out)
    time.sleep(%(hang)d)
else:
    time.sleep(0.3)
    open(out, "wb").write(b"video")
if log:
    with open(log, "a") as fh:
        fh.write(json.dumps({"event": "end", "t": time.time(), "out": out}) + "\n")
'''

FAKE_FFPROBE = r'''
import sys
args = " ".join(sys.argv[1:])
if "json" in args:
    print('{"streams": [{"width": 64, "height": 64}]}')
elif "format=duration" in args:
    print("2.0")
else:
    print("30/1")
'''

FAKE_RIFE = r'''
import os, stat, sys, time
pids = os.environ["FAKE_PIDS"]
mode = os.fstat(1).st_mode
open(os.path.join(pids, "rife_stdout"), "w").write("fifo" if stat.S_ISFIFO(mode) else "file")
open(os.path.join(pids, str(os.getpid())), "w").write("rife")
for _ in range(%(hang)d * 10):
    print("frame done", flush=True)
    time.sleep(0.1)
'''


def _script(path: Path, body: str) -> Path:
    path.write_text(f"#!{sys.executable}\n" + body.replace("%(hang)d", str(HANG_S)))
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


@pytest.fixture
def fakes(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    pids = tmp_path / "pids"
    pids.mkdir()
    _script(bin_dir / "ffmpeg", FAKE_FFMPEG)
    _script(bin_dir / "ffprobe", FAKE_FFPROBE)
    rife = _script(bin_dir / "rife", FAKE_RIFE)
    model = tmp_path / "rife-model"
    model.mkdir()
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setenv("FAKE_PIDS", str(pids))
    monkeypatch.setenv("FAKE_LOG", str(tmp_path / "ffmpeg.log"))
    monkeypatch.setenv("RIFE_BIN", str(rife))
    monkeypatch.setenv("RIFE_MODEL_DIR", str(model))
    out = tmp_path / "outputs"
    out.mkdir()
    monkeypatch.setattr(output_folder, "_state", output_folder.pinned_state(out))
    for name in ("a.mp4", "b.mp4"):
        (out / name).write_bytes(b"source")
    return {"pids": pids, "out": out, "log": tmp_path / "ffmpeg.log"}


def _load_sidecar(slug: str):
    path = ROOT / "custom_blocks" / slug / "backend.block.py"
    spec = importlib.util.spec_from_file_location(f"_test_cancel_sidecar_{slug}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _app(slug: str):
    app = FastAPI()
    app.include_router(_load_sidecar(slug).router, prefix=f"/api/blocks/{slug}")
    return app


def _child_pids(pids_dir: Path) -> list[int]:
    return [int(p.name) for p in pids_dir.iterdir() if p.name.isdigit()]


def _post(app, path: str, payload: dict, *, leave_when=None) -> tuple[int | None, dict | None, float]:
    """POST ``payload`` through the ASGI app. ``leave_when()``: once true, the
    receive channel reports that the client disconnected."""
    body = json.dumps(payload).encode()
    state = {"sent": False, "status": None, "body": b""}

    async def receive():
        if not state["sent"]:
            state["sent"] = True
            return {"type": "http.request", "body": body, "more_body": False}
        while True:
            if leave_when is not None and leave_when():
                return {"type": "http.disconnect"}
            await asyncio.sleep(0.05)

    async def send(message):
        if message["type"] == "http.response.start":
            state["status"] = message["status"]
        elif message["type"] == "http.response.body":
            state["body"] += message.get("body", b"")

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "http",
        "path": path, "raw_path": path.encode(), "root_path": "", "query_string": b"",
        "headers": [(b"content-type", b"application/json")], "client": ("127.0.0.1", 1),
        "server": ("127.0.0.1", 47301),
    }
    started = time.monotonic()
    asyncio.run(app(scope, receive, send))
    elapsed = time.monotonic() - started
    try:
        parsed = json.loads(state["body"]) if state["body"] else None
    except ValueError:
        parsed = None
    return state["status"], parsed, elapsed


def _gone(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


def _assert_children_gone(pids_dir: Path) -> None:
    pids = _child_pids(pids_dir)
    assert pids, "the fake child never started"
    deadline = time.monotonic() + 1.0
    while time.monotonic() < deadline and not all(_gone(p) for p in pids):
        time.sleep(0.05)
    assert all(_gone(p) for p in pids), f"children still running: {[p for p in pids if not _gone(p)]}"


# ------------------------------------------------------------------ the routes


@posix_only
@pytest.mark.parametrize("slug,payload,partial_dir", [
    ("video_fx", {"videos": ["/outputs/a.mp4"], "speed_enabled": True, "speed": 2.0}, "fx"),
    ("video_stitcher", {"videos": ["/outputs/a.mp4", "/outputs/b.mp4"], "transition": "none"}, "stitched"),
    ("video_stitcher", {"videos": ["/outputs/a.mp4", "/outputs/b.mp4"], "transition": "fade"}, "stitched"),
])
def test_a_disconnect_stops_ffmpeg_and_removes_the_partial_output(fakes, monkeypatch, slug, payload, partial_dir):
    monkeypatch.setenv("FAKE_MODE", "hang")
    status, body, elapsed = _post(_app(slug), f"/api/blocks/{slug}/run", payload,
                                  leave_when=lambda: bool(_child_pids(fakes["pids"])))
    assert elapsed < HANG_S / 2, f"the route waited {elapsed:.1f}s for a child it should have stopped"
    _assert_children_gone(fakes["pids"])
    assert not [p for p in (fakes["out"] / partial_dir).rglob("*") if p.is_file()], "partial output left behind"
    assert body is None or body.get("ok") is False


@posix_only
def test_a_disconnect_stops_rife_whose_output_goes_through_a_pipe(fakes, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "quick")
    payload = {"videos": ["/outputs/a.mp4"], "speed_enabled": True, "speed": 0.5, "smooth": True}
    status, body, elapsed = _post(_app("video_fx"), "/api/blocks/video_fx/run", payload,
                                  leave_when=lambda: bool(_child_pids(fakes["pids"])))
    assert elapsed < HANG_S / 2
    _assert_children_gone(fakes["pids"])
    # A pipe, not a log file: if the backend itself is killed, RIFE's next
    # progress line fails and it stops too.
    assert (fakes["pids"] / "rife_stdout").read_text() == "fifo"
    assert not [p for p in (fakes["out"] / "fx").rglob("*.mp4")]


@posix_only
def test_videos_are_processed_one_at_a_time_in_order(fakes, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "quick")
    payload = {"videos": ["/outputs/a.mp4", "/outputs/b.mp4", "/outputs/a.mp4"], "speed_enabled": True, "speed": 2.0}
    status, body, _ = _post(_app("video_fx"), "/api/blocks/video_fx/run", payload)
    assert status == 200 and body["ok"] is True
    assert len(body["videos"]) == 3
    assert [Path(v).name.split("_")[3] for v in body["videos"]] == ["00", "01", "02"]
    events = [json.loads(line) for line in fakes["log"].read_text().splitlines()]
    # start, end, start, end, ...: never two ffmpeg renders at once
    assert [e["event"] for e in events] == ["start", "end"] * 3
    assert [Path(e["out"]).name for e in events[::2]] == [Path(v).name for v in body["videos"]]


@posix_only
@pytest.mark.parametrize("slug", ["video_fx", "video_stitcher"])
def test_a_finished_run_keeps_its_response(fakes, monkeypatch, slug):
    monkeypatch.setenv("FAKE_MODE", "quick")
    status, body, _ = _post(_app(slug), f"/api/blocks/{slug}/run", {"videos": ["/outputs/a.mp4", "/outputs/b.mp4"]})
    assert status == 200 and body["ok"] is True
    if slug == "video_fx":
        assert set(body) == {"ok", "videos"} and len(body["videos"]) == 2
    else:
        assert set(body) == {"ok", "video_url", "local_video_url"}
        assert (fakes["out"] / body["video_url"].removeprefix("/outputs/")).read_bytes() == b"video"


@posix_only
def test_an_ffmpeg_timeout_stops_the_child_and_removes_the_partial_output(fakes, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "hang")
    module = _load_sidecar("video_fx")
    monkeypatch.setattr(module, "FFMPEG_TIMEOUT_S", 0.5)
    app = FastAPI()
    app.include_router(module.router, prefix="/api/blocks/video_fx")
    status, body, elapsed = _post(app, "/api/blocks/video_fx/run",
                                  {"videos": ["/outputs/a.mp4"], "speed_enabled": True, "speed": 2.0})
    assert status == 500 and "timed out" in body["error"]
    assert elapsed < HANG_S / 2
    _assert_children_gone(fakes["pids"])
    assert not list((fakes["out"] / "fx").glob("*.mp4"))


# ------------------------------------------------------------------ http sources


class _FakeResponse:
    def __init__(self, data: bytes, fail_after: int | None = None) -> None:
        self.data, self.pos, self.fail_after = data, 0, fail_after
        self.reads: list[int | None] = []
        self.on_loop: list[bool] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, amt=None):
        self.reads.append(amt)
        self.on_loop.append(_on_event_loop())
        if self.fail_after is not None and self.pos >= self.fail_after:
            raise OSError("connection reset")
        if amt is None:
            amt = len(self.data) - self.pos
        block = self.data[self.pos:self.pos + amt]
        self.pos += len(block)
        return block


def _on_event_loop() -> bool:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


@posix_only
@pytest.mark.parametrize("slug,payload", [
    ("video_fx", {"videos": ["https://cdn.test/clip.mp4"], "speed_enabled": True, "speed": 2.0}),
    ("video_stitcher", {"videos": ["https://cdn.test/clip.mp4"], "transition": "none"}),
])
def test_http_sources_stream_to_disk_off_the_event_loop(fakes, monkeypatch, slug, payload):
    monkeypatch.setenv("FAKE_MODE", "quick")
    data = os.urandom(3 * cancellable.DOWNLOAD_BLOCK + 17)
    response = _FakeResponse(data)
    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=None: response)
    status, body, _ = _post(_app(slug), f"/api/blocks/{slug}/run", payload)
    assert status == 200 and body["ok"] is True, body
    assert None not in response.reads, "the whole download was read at once"
    assert not any(response.on_loop), "the download ran on the event loop"
    folder = fakes["out"] / ("fx" if slug == "video_fx" else "stitched")
    sources = list(folder.glob("_src_*"))
    assert len(sources) == 1 and sources[0].read_bytes() == data
    assert not list(folder.glob("*.part"))


@posix_only
def test_a_failed_download_leaves_no_partial_source(fakes, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "quick")
    response = _FakeResponse(os.urandom(3 * cancellable.DOWNLOAD_BLOCK), fail_after=cancellable.DOWNLOAD_BLOCK)
    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=None: response)
    status, body, _ = _post(_app("video_stitcher"), "/api/blocks/video_stitcher/run",
                            {"videos": ["https://cdn.test/clip.mp4"]})
    assert status == 500 and body["ok"] is False
    assert [p for p in (fakes["out"] / "stitched").iterdir()] == []


# ------------------------------------------------------------------ the helper


def _sleeper(seconds: float, *, ignore_term: bool = False) -> list[str]:
    code = "import signal, time\n"
    if ignore_term:
        code += "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
    code += f"print('ready', flush=True)\ntime.sleep({seconds})\n"
    return [sys.executable, "-c", code]


def _wait_for(condition, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition() and time.monotonic() < deadline:
        time.sleep(0.02)


def _run_in_thread(fn):
    result: dict = {}

    def target():
        try:
            result["value"] = fn()
        except BaseException as exc:  # noqa: BLE001
            result["error"] = exc

    thread = threading.Thread(target=target)
    thread.start()
    return thread, result


@posix_only
def test_run_child_stops_the_child_when_cancelled(monkeypatch):
    seen: list[subprocess.Popen] = []
    real_popen = subprocess.Popen
    monkeypatch.setattr(subprocess, "Popen", lambda *a, **kw: seen.append(real_popen(*a, **kw)) or seen[-1])
    cancel = threading.Event()
    thread, result = _run_in_thread(lambda: cancellable.run_child(_sleeper(HANG_S), cancel=cancel, timeout=60))
    _wait_for(lambda: seen or "error" in result)
    assert seen, result.get("error")
    time.sleep(0.2)
    started = time.monotonic()
    cancel.set()
    thread.join(timeout=3)
    assert not thread.is_alive()
    assert isinstance(result.get("error"), cancellable.Cancelled)
    assert time.monotonic() - started < 1.0
    assert seen[0].returncode is not None and _gone(seen[0].pid)


@posix_only
def test_run_child_kills_a_child_that_ignores_sigterm(monkeypatch):
    monkeypatch.setattr(cancellable, "GRACE_S", 0.3)
    cancel = threading.Event()
    seen: list[subprocess.Popen] = []
    real_popen = subprocess.Popen
    monkeypatch.setattr(subprocess, "Popen", lambda *a, **kw: seen.append(real_popen(*a, **kw)) or seen[-1])
    thread, result = _run_in_thread(
        lambda: cancellable.run_child(_sleeper(HANG_S, ignore_term=True), cancel=cancel, timeout=60))
    _wait_for(lambda: seen or "error" in result)
    assert seen, result.get("error")
    time.sleep(0.5)  # let it install the handler
    cancel.set()
    thread.join(timeout=3)
    assert isinstance(result.get("error"), cancellable.Cancelled)
    assert _gone(seen[0].pid)


@posix_only
def test_run_child_timeout_raises_like_subprocess_run_and_stops_the_child():
    started = time.monotonic()
    with pytest.raises(subprocess.TimeoutExpired):
        cancellable.run_child(_sleeper(HANG_S), cancel=None, timeout=0.5)
    assert time.monotonic() - started < 2.0


def test_run_child_returns_output_and_raises_on_failure():
    done = cancellable.run_child([sys.executable, "-c", "import sys; print('out'); print('err', file=sys.stderr)"],
                                 cancel=threading.Event(), timeout=30)
    assert done.returncode == 0 and done.stdout.strip() == b"out" and done.stderr.strip() == b"err"
    with pytest.raises(subprocess.CalledProcessError) as info:
        cancellable.run_child([sys.executable, "-c", "import sys; sys.stderr.write('bad'); sys.exit(3)"],
                              cancel=None, timeout=30)
    assert info.value.returncode == 3 and info.value.stderr == b"bad"


def test_run_child_copies_output_to_a_log_file(tmp_path):
    log = tmp_path / "child.log"
    cancellable.run_child([sys.executable, "-c", "print('line 1'); print('line 2')"], cancel=None, timeout=30,
                          log_path=log)
    assert log.read_text().splitlines() == ["line 1", "line 2"]
