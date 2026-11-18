"""The local API answers only the app's own pages (backend/origin_guard.py).

A web page on the internet must not be able to start an update, submit a paid
generation or change settings on the user's machine. CORS stops it reading
answers; the origin guard stops state-changing requests from running at all.
Clients that send no Origin (the Next.js proxy for some requests, the MCP
server, curl) keep working.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from backend import origin_guard


@pytest.fixture
def calls():
    return []


@pytest.fixture
def client(calls, monkeypatch):
    monkeypatch.delenv(origin_guard.ORIGINS_ENV, raising=False)
    monkeypatch.setattr(origin_guard, "_pref_origins", lambda: [])
    app = FastAPI()

    @app.post("/api/thing")
    def post_thing():
        calls.append("post")
        return {"ok": True}

    @app.put("/api/thing")
    def put_thing():
        calls.append("put")
        return {"ok": True}

    @app.delete("/api/thing")
    def delete_thing():
        calls.append("delete")
        return {"ok": True}

    @app.get("/api/thing")
    def get_thing():
        calls.append("get")
        return {"ok": True}

    @app.get("/api/stream")
    def stream():
        def gen():
            yield b"data: one\n\n"
            yield b"data: two\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    origin_guard.install(app, frontend_port=47300, backend_port=47301)
    return TestClient(app)


def test_allowed_origins_cover_localhost_loopback_and_backend_itself():
    origins = origin_guard.allowed_origins(frontend_port=5000, backend_port=5001, extra=[])
    assert "http://localhost:5000" in origins
    assert "http://127.0.0.1:5000" in origins
    assert "http://[::1]:5000" in origins
    assert "http://localhost:5001" in origins
    assert "http://127.0.0.1:5001" in origins
    assert all("*" not in o for o in origins)


@pytest.mark.parametrize("origin", ["http://localhost:47300", "http://127.0.0.1:47300", "http://localhost:47301"])
def test_state_change_from_the_app_runs(client, calls, origin):
    r = client.post("/api/thing", headers={"Origin": origin})
    assert r.status_code == 200
    assert calls == ["post"]
    assert r.headers["access-control-allow-origin"] == origin


@pytest.mark.parametrize("method", ["post", "put", "delete"])
def test_state_change_from_a_foreign_site_is_refused_before_it_runs(client, calls, method):
    r = getattr(client, method)("/api/thing", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert calls == []
    assert "access-control-allow-origin" not in r.headers
    assert "origin" in r.json()["detail"].lower()


@pytest.mark.parametrize("origin", ["null", "http://localhost:3000", "http://localhost", "https://localhost:47300",
                                    "http://localhost:47300.evil.example", "http://127.0.0.1:47300/x"])
def test_lookalike_and_null_origins_are_refused(client, calls, origin):
    r = client.post("/api/thing", headers={"Origin": origin})
    assert r.status_code == 403
    assert calls == []


def test_no_origin_is_allowed_for_proxy_mcp_and_cli(client, calls):
    r = client.post("/api/thing")
    assert r.status_code == 200
    assert calls == ["post"]


def test_cross_site_fetch_metadata_without_origin_is_refused(client, calls):
    r = client.post("/api/thing", headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403
    assert calls == []
    ok = client.post("/api/thing", headers={"Sec-Fetch-Site": "same-origin"})
    assert ok.status_code == 200


def test_reads_are_not_blocked_but_do_not_get_cors_headers_for_foreign_sites(client, calls):
    r = client.get("/api/thing", headers={"Origin": "https://evil.example"})
    assert r.status_code == 200
    assert "access-control-allow-origin" not in r.headers


def test_preflight_from_the_app_is_answered(client):
    r = client.options("/api/thing", headers={
        "Origin": "http://localhost:47300", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type"})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "http://localhost:47300"


def test_preflight_from_a_foreign_site_is_refused(client):
    r = client.options("/api/thing", headers={
        "Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert r.status_code in (400, 403)
    assert "access-control-allow-origin" not in r.headers


def test_extra_origins_from_env_are_allowed(calls, monkeypatch):
    monkeypatch.setenv(origin_guard.ORIGINS_ENV, "https://studio.example.lan, http://box.local:8080/")
    monkeypatch.setattr(origin_guard, "_pref_origins", lambda: [])
    app = FastAPI()

    @app.post("/api/thing")
    def post_thing():
        calls.append("post")
        return {}

    origin_guard.install(app, frontend_port=47300, backend_port=47301)
    c = TestClient(app)
    assert c.post("/api/thing", headers={"Origin": "https://studio.example.lan"}).status_code == 200
    assert c.post("/api/thing", headers={"Origin": "http://box.local:8080"}).status_code == 200
    assert c.post("/api/thing", headers={"Origin": "https://other.example"}).status_code == 403


def test_extra_origins_from_the_pref_are_allowed(calls, monkeypatch):
    monkeypatch.delenv(origin_guard.ORIGINS_ENV, raising=False)
    monkeypatch.setattr(origin_guard, "_pref_origins", lambda: ["http://my-proxy.lan:9000"])
    app = FastAPI()

    @app.post("/api/thing")
    def post_thing():
        calls.append("post")
        return {}

    origin_guard.install(app, frontend_port=47300, backend_port=47301)
    c = TestClient(app)
    assert c.post("/api/thing", headers={"Origin": "http://my-proxy.lan:9000"}).status_code == 200


def test_parse_origins_ignores_wildcards_and_garbage():
    assert origin_guard.parse_origins("*, javascript:alert(1), ftp://x, http://ok.lan:1, https://a.b/") == [
        "http://ok.lan:1", "https://a.b"]


def test_streaming_responses_still_stream(client):
    with client.stream("GET", "/api/stream", headers={"Origin": "http://localhost:47300"}) as r:
        body = b"".join(r.iter_bytes())
    assert body == b"data: one\n\ndata: two\n\n"
    assert r.headers["access-control-allow-origin"] == "http://localhost:47300"


def test_main_app_uses_the_guard_not_a_wildcard():
    from backend import main

    c = TestClient(main.app)
    r = c.post("/api/settings/choose-folder", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    preflight = c.options("/api/settings/app-prefs/x", headers={
        "Origin": "https://evil.example", "Access-Control-Request-Method": "PUT"})
    assert preflight.headers.get("access-control-allow-origin") not in ("*", "https://evil.example")
