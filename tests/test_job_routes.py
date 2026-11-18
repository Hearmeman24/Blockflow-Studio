"""HTTP surface of the generic job store: /api/jobs (backend/job_routes.py)."""

from __future__ import annotations

import asyncio
import json
import sys
import threading
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import db, job_routes, job_store  # noqa: E402


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "run_history.db")
    monkeypatch.setattr(job_routes, "HEARTBEAT_SECONDS", 0.05)
    return job_store.get_store()


@pytest.fixture
def client(store):
    app = FastAPI()
    app.include_router(job_routes.router)
    with TestClient(app) as c:
        yield c


def _create(store, **overrides):
    fields = {"source": "pipeline", "provider": "piapi", "model": "gpt-image", "mode": "text_to_image",
              "request": {"prompt": "a lighthouse"}}
    fields.update(overrides)
    return store.create_job(**fields)


# ---------------------------------------------------------------- list


def test_list_returns_newest_first_with_filters(client, store, monkeypatch):
    clock = iter(range(100, 200))
    monkeypatch.setattr(job_store.time, "time", lambda: float(next(clock)))
    a = _create(store, source="pipeline")
    b = _create(store, source="mcp")
    c = _create(store, source="mcp")
    store.update_job(c["job_id"], status="FAILED", error={"kind": "provider", "message": "nope"})

    body = client.get("/api/jobs").json()
    assert body["ok"] is True
    assert [j["job_id"] for j in body["jobs"]] == [c["job_id"], b["job_id"], a["job_id"]]
    assert body["jobs"][0] == store.get_job(c["job_id"])

    mcp = client.get("/api/jobs", params={"source": "mcp"}).json()["jobs"]
    assert [j["job_id"] for j in mcp] == [c["job_id"], b["job_id"]]

    failed = client.get("/api/jobs", params={"status": "failed"}).json()["jobs"]
    assert [j["job_id"] for j in failed] == [c["job_id"]]

    limited = client.get("/api/jobs", params={"limit": 1}).json()["jobs"]
    assert [j["job_id"] for j in limited] == [c["job_id"]]


def test_list_empty_store(client):
    assert client.get("/api/jobs").json() == {"ok": True, "jobs": []}


def test_list_blank_filters_mean_no_filter(client, store):
    job = _create(store)
    body = client.get("/api/jobs", params={"source": "", "status": ""}).json()
    assert [j["job_id"] for j in body["jobs"]] == [job["job_id"]]


@pytest.mark.parametrize("params", [
    {"limit": "abc"},
    {"limit": "0"},
    {"limit": "-5"},
    {"limit": "501"},
    {"status": "DONE"},
    {"source": "runpod"},
])
def test_list_rejects_malformed_query_params(client, store, params):
    _create(store)
    res = client.get("/api/jobs", params=params)
    assert res.status_code == 422


# ---------------------------------------------------------------- get


def test_get_returns_snapshot(client, store):
    job = _create(store, request={"prompt": "灯台 🌊", "api_key": "sk-x"})
    res = client.get(f"/api/jobs/{job['job_id']}")
    assert res.status_code == 200
    assert res.json() == {"ok": True, "job": job}
    assert res.json()["job"]["request"] == {"prompt": "灯台 🌊"}
    assert "sk-x" not in res.text


def test_get_unknown_is_404(client):
    res = client.get("/api/jobs/does-not-exist")
    assert res.status_code == 404
    assert res.json() == {"ok": False, "error": "Job not found"}


# ---------------------------------------------------------------- cancel


def test_cancel_active_job_marks_it_cancelled(client, store):
    job = _create(store)
    store.update_job(job["job_id"], status="RUNNING", remote_job_id="task-1")
    res = client.post(f"/api/jobs/{job['job_id']}/cancel")
    assert res.status_code == 200
    snap = res.json()["job"]
    assert snap["status"] == "CANCELLED"
    assert snap["cancel_requested"] is True
    assert store.get_job(job["job_id"]) == snap
    assert store.is_cancel_requested(job["job_id"]) is True


def test_cancel_terminal_job_is_idempotent(client, store):
    job = _create(store)
    done = store.update_job(job["job_id"], status="COMPLETED",
                            outputs=[{"kind": "image", "url": "https://cdn/x.png"}])
    first = client.post(f"/api/jobs/{job['job_id']}/cancel")
    second = client.post(f"/api/jobs/{job['job_id']}/cancel")
    assert first.status_code == second.status_code == 200
    assert first.json()["job"] == second.json()["job"] == done
    assert store.get_job(job["job_id"])["status"] == "COMPLETED"


def test_cancel_unknown_is_404(client):
    res = client.post("/api/jobs/ghost/cancel")
    assert res.status_code == 404
    assert res.json() == {"ok": False, "error": "Job not found"}


# ---------------------------------------------------------------- SSE


class _SSEClient:
    """Drives the ASGI app directly. TestClient buffers the whole response
    body, so it can never read an endless event stream."""

    def __init__(self, app: FastAPI, path: str) -> None:
        self.app = app
        self.path = path
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.chunks: asyncio.Queue = asyncio.Queue()
        self.start: dict | None = None
        self._buffer = ""

    async def _receive(self):
        return await self.inbox.get()

    async def _send(self, message):
        if message["type"] == "http.response.start":
            self.start = message
        elif message["type"] == "http.response.body":
            await self.chunks.put(message.get("body", b"").decode())

    def open(self) -> asyncio.Task:
        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": "GET", "scheme": "http", "path": self.path, "raw_path": self.path.encode(),
            "query_string": b"", "headers": [], "server": ("test", 80), "client": ("test", 1),
            "root_path": "",
        }
        self.inbox.put_nowait({"type": "http.request", "body": b"", "more_body": False})
        return asyncio.create_task(self.app(scope, self._receive, self._send))

    async def next_frame(self, timeout: float = 5) -> str:
        while "\n\n" not in self._buffer:
            self._buffer += await asyncio.wait_for(self.chunks.get(), timeout=timeout)
        frame, self._buffer = self._buffer.split("\n\n", 1)
        return frame

    def disconnect(self) -> None:
        self.inbox.put_nowait({"type": "http.disconnect"})


def _sse_app() -> FastAPI:
    app = FastAPI()
    app.include_router(job_routes.router)
    return app


def test_events_stream_delivers_snapshot_after_update_and_cleans_up(store):
    job = _create(store)

    async def scenario():
        sse = _SSEClient(_sse_app(), "/api/jobs/events")
        task = sse.open()
        assert await sse.next_frame() == "retry: 3000"
        assert await sse.next_frame() == ": ping"  # heartbeat; generator is in its loop
        headers = dict((k.decode(), v.decode()) for k, v in sse.start["headers"])
        subscribed = store.subscriber_count()

        worker = threading.Thread(
            target=store.update_job, args=(job["job_id"],),
            kwargs={"status": "RUNNING", "progress": 0.5, "message": "Rendering ✨"},
        )
        worker.start()
        worker.join()
        frame = await sse.next_frame()
        while frame == ": ping":
            frame = await sse.next_frame()

        sse.disconnect()
        await asyncio.wait_for(task, timeout=5)
        return sse.start["status"], headers, subscribed, frame

    status, headers, subscribed, frame = asyncio.run(scenario())
    assert status == 200
    assert headers["content-type"].startswith("text/event-stream")
    # no-transform: the Next.js rewrite proxy's compression middleware skips the
    # response, so it is not gzipped and buffered (which held back every event).
    assert headers["cache-control"] == "no-cache, no-transform"
    assert headers["x-accel-buffering"] == "no"
    assert "content-encoding" not in headers
    assert subscribed == 1

    assert frame.startswith("data: ")
    event = json.loads(frame[len("data: "):])
    assert event["type"] == "job"
    assert event["job"]["job_id"] == job["job_id"]
    assert event["job"]["status"] == "RUNNING"
    assert event["job"]["progress"] == 0.5
    assert event["job"]["message"] == "Rendering ✨"
    assert event["job"] == store.get_job(job["job_id"])

    assert store.subscriber_count() == 0


def test_events_route_is_not_shadowed_by_job_id_route(store):
    # /events must be declared before /{job_id}, or it would 404 as an unknown job.
    async def scenario():
        sse = _SSEClient(_sse_app(), "/api/jobs/events")
        task = sse.open()
        first = await sse.next_frame()
        sse.disconnect()
        await asyncio.wait_for(task, timeout=5)
        return sse.start["status"], first

    assert asyncio.run(scenario()) == (200, "retry: 3000")
    assert store.subscriber_count() == 0


# ---------------------------------------------------------------- app wiring


def test_main_app_mounts_job_routes():
    from backend import main

    paths = {getattr(r, "path", None) for r in main.app.routes}
    assert {"/api/jobs", "/api/jobs/events", "/api/jobs/{job_id}", "/api/jobs/{job_id}/cancel"} <= paths

# Startup recovery + resume now lives in main._resume_generation_jobs_on_startup
# (byok_service.resume_pending); see tests/test_byok_api_routes.py.


# ---------------------------------------------------------------- phase (in memory only)


@pytest.fixture
def phased(store):
    """A RUNNING job whose (in-memory) phase is `polling`."""
    from backend.byok import service
    from backend.statuses import JobPhase

    job = _create(store)
    store.update_job(job["job_id"], status="RUNNING", remote_job_id="task-p")
    service._set_phase(job["job_id"], JobPhase.POLLING)
    yield job
    service._clear_phase(job["job_id"])


def test_get_and_list_report_the_phase_of_an_active_job(client, store, phased):
    got = client.get(f"/api/jobs/{phased['job_id']}").json()["job"]
    assert got["phase"] == "polling"
    assert {k: v for k, v in got.items() if k != "phase"} == store.get_job(phased["job_id"])
    listed = client.get("/api/jobs").json()["jobs"]
    assert [j.get("phase") for j in listed] == ["polling"]
    assert "phase" not in store.get_job(phased["job_id"])  # never stored


def test_a_terminal_job_reports_no_phase_even_with_a_stale_entry(client, store, phased):
    cancelled = client.post(f"/api/jobs/{phased['job_id']}/cancel").json()["job"]
    assert cancelled["status"] == "CANCELLED" and "phase" not in cancelled
    assert "phase" not in client.get(f"/api/jobs/{phased['job_id']}").json()["job"]


def test_events_carry_the_phase(store, phased):
    async def scenario():
        sse = _SSEClient(_sse_app(), "/api/jobs/events")
        task = sse.open()
        assert await sse.next_frame() == "retry: 3000"
        assert await sse.next_frame() == ": ping"
        worker = threading.Thread(target=store.update_job, args=(phased["job_id"],),
                                  kwargs={"progress": 0.3})
        worker.start()
        worker.join()
        frame = await sse.next_frame()
        while frame == ": ping":
            frame = await sse.next_frame()
        sse.disconnect()
        await asyncio.wait_for(task, timeout=5)
        return frame

    event = json.loads(asyncio.run(scenario())[len("data: "):])
    assert event["job"]["progress"] == 0.3 and event["job"]["phase"] == "polling"
