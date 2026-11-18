"""Run-history routes after the LoRA, CivitAI and dataset features were removed.

The LoRA usage and LoRA-pack routes are gone, the `lora` run filter is no
longer honoured, and removed media kinds are not valid filters. Old runs whose
metadata still carries `loras` keep loading and listing normally.
"""
from __future__ import annotations

import sqlite3
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


def _run(run_id: str, *, kind: str = "image", meta: dict | None = None) -> dict:
    outputs = {kind: {"kind": kind, "value": f"/outputs/{run_id}.png"}}
    if meta is not None:
        outputs["metadata"] = {"kind": "metadata", "value": meta}
    return {
        "id": run_id,
        "name": run_id,
        "status": "completed",
        "duration_ms": 1,
        "flow_snapshot": {"blocks": []},
        "block_results": [{"block_index": 0, "status": "ok", "outputs": outputs}],
        "created_at": "2026-01-01T00:00:00Z",
    }


@pytest.mark.parametrize("method,path", [
    ("get", "/api/loras/usage"),
    ("get", "/api/civitai/lora-packs"),
    ("post", "/api/civitai/lora-packs"),
    ("put", "/api/civitai/lora-packs/pack-1"),
    ("delete", "/api/civitai/lora-packs/pack-1"),
])
def test_removed_routes_are_not_served(client, method, path):
    kwargs = {"json": {"name": "x", "resources": [{"id": 1}]}} if method in ("post", "put") else {}
    assert getattr(client, method)(path, **kwargs).status_code in (404, 405)


def test_lora_query_param_is_ignored(client, temp_db):
    temp_db.save_run(_run("a", meta={"prompt": "p", "loras": ["alpha@1"]}))
    temp_db.save_run(_run("b", meta={"prompt": "p"}))
    body = client.get("/api/runs?lora=alpha").json()
    assert body["total"] == 2
    assert {r["id"] for r in body["runs"]} == {"a", "b"}


@pytest.mark.parametrize("removed_kind", ["lora", "dataset"])
def test_removed_media_kind_is_not_a_filter(client, temp_db, removed_kind):
    temp_db.save_run(_run("img", kind="image"))
    temp_db.save_run(_run("vid", kind="video"))
    body = client.get(f"/api/runs?media_kind={removed_kind}").json()
    assert body["total"] == 2


def test_db_list_runs_rejects_lora_keyword(temp_db):
    with pytest.raises(TypeError):
        temp_db.list_runs(lora="alpha")
    with pytest.raises(TypeError):
        temp_db.count_runs(lora="alpha")


def test_old_run_with_lora_metadata_still_reads_back(client, temp_db):
    temp_db.save_run(_run("old", meta={"prompt": "cat", "loras": ["krea2/x/alpha@1"]}))
    body = client.get("/api/runs/old").json()
    assert body["ok"] is True
    meta = body["run"]["block_results"][0]["outputs"]["metadata"]["value"]
    assert meta["loras"] == ["krea2/x/alpha@1"]
    assert client.get("/api/runs?q=cat").json()["total"] == 1


def test_init_db_leaves_legacy_jobs_table_untouched(tmp_path, monkeypatch):
    """The legacy `jobs` table is superseded by generation_jobs. A fresh
    database does not get it; an existing one keeps its rows."""
    fresh = tmp_path / "fresh.db"
    monkeypatch.setattr(db, "DB_PATH", fresh)
    db.init_db()
    conn = sqlite3.connect(str(fresh))
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    conn.close()
    assert "runs" in tables
    assert "jobs" not in tables

    legacy = tmp_path / "legacy.db"
    conn = sqlite3.connect(str(legacy))
    conn.executescript("""
        CREATE TABLE jobs (job_id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL,
                           created_at REAL NOT NULL, updated_at REAL NOT NULL);
        INSERT INTO jobs VALUES ('j1', 'COMPLETED', '{}', 0, 0);
    """)
    conn.commit()
    conn.close()
    monkeypatch.setattr(db, "DB_PATH", legacy)
    db.init_db()
    conn = sqlite3.connect(str(legacy))
    rows = conn.execute("SELECT job_id FROM jobs").fetchall()
    conn.close()
    assert rows == [("j1",)]
    for name in ("save_job", "get_job", "list_jobs", "count_jobs"):
        assert not hasattr(db, name), name
