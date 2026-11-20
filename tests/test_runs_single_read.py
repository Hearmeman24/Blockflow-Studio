"""One /api/runs request reads the runs table once.

A filtered list (the Artifacts page always sends `hide_partial`) loads and
parses every run in Python. The count and the page used to do that twice per
request; now the page and the total come from one filtered list.
"""
from __future__ import annotations

import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import db, routes


@pytest.fixture
def statements(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "runs.db")
    db.init_db()
    for i in range(12):
        db.save_run({"id": f"run-{i:02d}", "name": f"r{i}", "status": "completed" if i % 3 else "partial",
                     "duration_ms": 1, "flow_snapshot": {"blocks": []}, "block_results": [],
                     "created_at": f"2026-11-20T10:{i:02d}:00Z"})
    seen: list[str] = []
    real = db._get_conn

    def traced() -> sqlite3.Connection:
        conn = real()
        conn.set_trace_callback(seen.append)
        return conn

    monkeypatch.setattr(db, "_get_conn", traced)
    return seen


def _run_reads(seen: list[str]) -> list[str]:
    return [s for s in seen if s.lstrip().upper().startswith("SELECT") and " FROM RUNS" in s.upper()]


@pytest.mark.parametrize("query", [
    {"hide_partial": "true"},
    {"hide_partial": "true", "source": "pipeline"},
    {"q": "anything"},
    {"media_kind": "image,video", "favorited": "true"},
])
def test_a_filtered_request_reads_the_table_once(statements, query):
    client = TestClient(_app())
    body = client.get("/api/runs", params={**query, "limit": 3, "offset": 2}).json()
    assert body["ok"] is True
    assert len(_run_reads(statements)) == 1, _run_reads(statements)


def test_page_and_total_come_from_the_same_filtered_list(statements):
    client = TestClient(_app())
    body = client.get("/api/runs", params={"hide_partial": "true", "limit": 3, "offset": 2}).json()
    # 12 runs, the 4 partial ones with nothing generated are hidden.
    assert body["total"] == 8
    assert [r["id"] for r in body["runs"]] == ["run-08", "run-07", "run-05"]
    assert (body["limit"], body["offset"]) == (3, 2)


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(routes.router)
    return app
