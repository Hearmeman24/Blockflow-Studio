"""The MCP server stops waiting when its client goes away.

`wait_for_jobs` and `generate(wait=true)` poll a job for up to `timeout_s`
(at most 3,600 s) in a worker thread the server waits for, so a server whose
client closed stdin stayed alive, polling, until the job ended. A stop signal
(`tools_jobs.STOP`, set when stdin reaches its end and at exit) ends the wait
between polls. Only the waiting stops: no job is cancelled.

The last test runs the real server (needs fastmcp: `uv run --with fastmcp
python -m pytest tests/test_mcp_*.py`) against a fake backend on localhost.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from blockflow_mcp import client as mcp_client  # noqa: E402
from blockflow_mcp import server, tools_jobs  # noqa: E402
from tests.mcp_fakes import FakeBackend, job  # noqa: E402


@pytest.fixture
def backend():
    fake = FakeBackend()
    mcp_client.set_client(fake.client())
    tools_jobs.STOP.clear()
    yield fake
    tools_jobs.STOP.clear()
    mcp_client.set_client(None)


def test_wait_for_returns_the_pending_jobs_at_once_when_stopped(backend):
    backend.on_job("j1", job("j1", "RUNNING"))
    tools_jobs.STOP.set()
    started = time.monotonic()
    jobs, pending = tools_jobs.wait_for(["j1"], 3600)
    assert time.monotonic() - started < 0.5
    assert pending == ["j1"] and jobs["j1"]["status"] == "RUNNING"
    assert "/api/jobs/j1/cancel" not in backend.paths()


def test_a_stop_during_the_pause_between_polls_ends_the_wait(backend):
    backend.on_job("j1", job("j1", "RUNNING"))
    threading.Timer(0.3, tools_jobs.STOP.set).start()
    started = time.monotonic()
    jobs, pending = tools_jobs.wait_for(["j1"], 3600)
    assert time.monotonic() - started < 1.5  # not the 3 s poll interval, not the hour
    assert pending == ["j1"]
    assert backend.paths("POST") == []  # nothing cancelled


def test_wait_for_jobs_result_is_unchanged_when_stopped(backend):
    backend.on_job("j1", job("j1", "RUNNING"))
    backend.on("GET", "/api/settings/output-folder", {"in_use": "/tmp", "previous": []})
    tools_jobs.STOP.set()
    result = tools_jobs.wait_for_jobs(["j1"], timeout_s=3600)
    assert result["ok"] is True and result["pending"] == ["j1"] and result["timed_out"] is True
    assert result["jobs"][0]["status"] == "RUNNING"


def test_stdin_relay_passes_bytes_through_and_signals_the_end():
    read_fd, write_fd = os.pipe()
    stop = threading.Event()
    stream = server.relay_stdin(read_fd, stop)
    os.write(write_fd, b'{"jsonrpc": "2.0"}\n')
    assert stream.readline() == '{"jsonrpc": "2.0"}\n'
    assert not stop.is_set()
    os.close(write_fd)
    assert stream.readline() == ""
    assert stop.wait(2.0)


# ------------------------------------------------------------------ the real server


class _Backend(BaseHTTPRequestHandler):
    """Answers every job read with a RUNNING job; records the paths it saw."""

    seen: list[str] = []

    def do_GET(self):  # noqa: N802
        self.seen.append(self.path)
        if self.path.startswith("/api/jobs/"):
            body = {"ok": True, "job": job("j1", "RUNNING")}
        else:
            body = {"ok": False, "error": "Not Found"}
        data = json.dumps(body).encode()
        self.send_response(200 if body["ok"] else 404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):  # noqa: N802
        self.seen.append("POST " + self.path)
        self.send_response(404)
        self.end_headers()

    def log_message(self, *args):
        pass


def _send(proc, message: dict) -> None:
    proc.stdin.write((json.dumps(message) + "\n").encode())
    proc.stdin.flush()


def _read_response(proc, request_id: int, timeout: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        message = json.loads(line)
        if message.get("id") == request_id:
            return message
    raise AssertionError("no response from the MCP server")


def test_the_server_exits_soon_after_its_client_closes_stdin_during_a_wait():
    pytest.importorskip("fastmcp", reason="run with `uv run --with fastmcp python -m pytest tests/test_mcp_*.py`")
    _Backend.seen = []
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Backend)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    env = {**os.environ, "BLOCKFLOW_URL": f"http://127.0.0.1:{httpd.server_address[1]}",
           "FASTMCP_SHOW_SERVER_BANNER": "false", "FASTMCP_LOG_LEVEL": "ERROR"}
    proc = subprocess.Popen([sys.executable, str(ROOT / "mcp_server.py")], cwd=ROOT, env=env,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        _send(proc, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}}})
        _read_response(proc, 1)
        _send(proc, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        _send(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                     "params": {"name": "wait_for_jobs", "arguments": {"job_ids": ["j1"], "timeout_s": 3600}}})
        deadline = time.monotonic() + 15
        while not any(p.startswith("/api/jobs/j1") for p in _Backend.seen) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert any(p.startswith("/api/jobs/j1") for p in _Backend.seen), "the wait never started"

        proc.stdin.close()
        closed = time.monotonic()
        proc.wait(timeout=10)
        assert time.monotonic() - closed < 5.0
        assert not [p for p in _Backend.seen if p.startswith("POST")], "a job was cancelled"
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        httpd.shutdown()
