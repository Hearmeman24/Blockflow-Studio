"""/api/runs takes several sources and media kinds at once (comma-separated).

The Artifacts filter menu lets the user tick any subset of Source (pipeline,
mcp) and Type (image, video, other). Filtering happens server-side, before
pagination, so `total` and pages are right. The old single-value form keeps
working; none or every value means no filter; unknown values are dropped.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import db, routes  # noqa: E402


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "runs.db")
    db.init_db()
    yield db


@pytest.fixture
def client(temp_db):
    app = FastAPI()
    app.include_router(routes.router)
    return TestClient(app)


def _run(run_id: str, kind: str | None, *, minute: int, status: str = "completed") -> dict:
    outputs = {} if kind is None else {"o": {"kind": kind, "value": f"/outputs/{run_id}.{'mp4' if kind == 'video' else 'png'}"}}
    if kind == "text":
        outputs = {"o": {"kind": "text", "value": "hello"}}
    return {
        "id": run_id, "name": run_id, "status": status, "duration_ms": 1,
        "flow_snapshot": {"blocks": []},
        "block_results": [{"block_index": 0, "block_label": "B", "block_type": "b", "status": "ok", "outputs": outputs}],
        "created_at": f"2026-01-01T00:{minute:02d}:00Z",
    }


@pytest.fixture
def seeded(temp_db):
    # Newest first by minute: p-video (5), mcp-image (4), p-image (3), mcp-text (2), p-other (1)
    temp_db.save_run(_run("run-p-other", None, minute=1))
    temp_db.save_run(_run("run-mcp-text", "text", minute=2))
    temp_db.save_run(_run("run-p-image", "image", minute=3))
    temp_db.save_run(_run("run-mcp-image", "image", minute=4))
    temp_db.save_run(_run("run-p-video", "video", minute=5))
    return temp_db


def ids(res) -> list[str]:
    assert res.status_code == 200, res.text
    return [r["id"] for r in res.json()["runs"]]


def test_several_media_kinds_filter_to_their_union_server_side(client, seeded):
    res = client.get("/api/runs", params={"media_kind": "image,video"})
    assert ids(res) == ["run-p-video", "run-mcp-image", "run-p-image"]
    assert res.json()["total"] == 3


def test_media_kind_union_is_paginated_after_filtering(client, seeded):
    res = client.get("/api/runs", params={"media_kind": "image,other", "limit": 2, "offset": 1})
    assert ids(res) == ["run-p-image", "run-mcp-text"]
    assert res.json()["total"] == 4


def test_single_values_still_work(client, seeded):
    assert ids(client.get("/api/runs", params={"media_kind": "video"})) == ["run-p-video"]
    assert ids(client.get("/api/runs", params={"source": "mcp"})) == ["run-mcp-image", "run-mcp-text"]


def test_several_sources(client, seeded):
    both = ids(client.get("/api/runs", params={"source": "pipeline,mcp"}))
    assert len(both) == 5


def test_every_value_means_no_filter(client, seeded):
    res = client.get("/api/runs", params={"media_kind": "video,image,other", "source": "mcp,pipeline"})
    assert res.json()["total"] == 5


def test_empty_items_and_spaces_are_ignored(client, seeded):
    assert ids(client.get("/api/runs", params={"media_kind": " video , "})) == ["run-p-video"]
    assert client.get("/api/runs", params={"media_kind": ""}).json()["total"] == 5


def test_sources_and_kinds_combine(client, seeded):
    assert ids(client.get("/api/runs", params={"source": "mcp", "media_kind": "image,video"})) == ["run-mcp-image"]


def test_unknown_values_are_dropped_like_the_removed_kinds_of_old_links(client, seeded):
    # Old bookmarks may carry kinds that no longer exist (lora, dataset): they
    # are ignored, and the known values in the same list still apply.
    assert ids(client.get("/api/runs", params={"media_kind": "video,dataset"})) == ["run-p-video"]
    assert client.get("/api/runs", params={"media_kind": "lora"}).json()["total"] == 5
    assert ids(client.get("/api/runs", params={"source": "mcp,runpod"})) == ["run-mcp-image", "run-mcp-text"]


def test_db_accepts_collections(seeded):
    assert seeded.count_runs(media_kind={"image", "video"}) == 3
    assert [r["id"] for r in seeded.list_runs(media_kind=["other"], source=["mcp"])] == ["run-mcp-text"]
    # A single string still works for older callers.
    assert seeded.count_runs(media_kind="image") == 2
