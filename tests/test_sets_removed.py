"""The Sets feature is removed from the backend.

The /api/sets routes, the sets functions in backend/db.py and the `set_id`
run filter are gone. Databases from older builds keep their `sets` /
`set_items` tables untouched; nothing reads them and a fresh database does not
create them.
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


def _run(run_id: str, url: str) -> dict:
    return {
        "id": run_id, "name": run_id, "status": "completed", "duration_ms": 1,
        "flow_snapshot": {"blocks": []},
        "block_results": [{"block_index": 0, "status": "completed",
                           "outputs": {"image": {"kind": "image", "value": url}}}],
        "created_at": "2026-01-01T00:00:00Z",
    }


@pytest.mark.parametrize("method,path", [
    ("get", "/api/sets"),
    ("post", "/api/sets"),
    ("get", "/api/sets/set-1"),
    ("patch", "/api/sets/set-1"),
    ("delete", "/api/sets/set-1"),
    ("post", "/api/sets/set-1/items"),
    ("delete", "/api/sets/set-1/items"),
])
def test_sets_routes_are_not_served(client, method, path):
    kwargs = {"json": {"name": "x", "items": [{"url": "/outputs/a.png"}], "url": "/outputs/a.png"}} \
        if method in ("post", "patch", "delete") else {}
    if method == "delete":
        response = client.request("DELETE", path, **kwargs)
    else:
        response = getattr(client, method)(path, **kwargs)
    assert response.status_code in (404, 405)


def test_sets_functions_are_gone_from_db():
    for name in ("create_set", "list_sets", "get_set", "set_urls", "rename_set", "delete_set",
                 "add_set_items", "remove_set_item", "media_kind_for_url"):
        assert not hasattr(db, name), name


def test_set_id_filter_is_gone(client, temp_db):
    temp_db.save_run(_run("a", "/outputs/a.png"))
    temp_db.save_run(_run("b", "/outputs/b.png"))
    body = client.get("/api/runs?set_id=set-anything").json()
    assert body["total"] == 2
    with pytest.raises(TypeError):
        temp_db.list_runs(set_id="set-1")
    with pytest.raises(TypeError):
        temp_db.count_runs(set_id="set-1")


def test_fresh_database_has_no_sets_tables(temp_db):
    conn = sqlite3.connect(str(temp_db.DB_PATH))
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    conn.close()
    assert "runs" in tables
    assert "sets" not in tables and "set_items" not in tables


def test_old_database_with_sets_tables_still_opens_and_keeps_them(tmp_path, monkeypatch):
    path = tmp_path / "old.db"
    conn = sqlite3.connect(str(path))
    conn.executescript("""
        CREATE TABLE runs (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, duration_ms INTEGER,
                           flow_snapshot TEXT NOT NULL, block_results TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE sets (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE set_items (set_id TEXT NOT NULL, url TEXT NOT NULL, kind TEXT NOT NULL, run_id TEXT,
                                added_at TEXT NOT NULL, PRIMARY KEY (set_id, url));
        INSERT INTO sets VALUES ('set-1', 'Summer drop', '2026-01-01T00:00:00Z');
        INSERT INTO set_items VALUES ('set-1', '/outputs/a.png', 'image', NULL, '2026-01-01T00:00:00Z');
    """)
    conn.commit()
    conn.close()

    monkeypatch.setattr(db, "DB_PATH", path)
    db.init_db()
    db.save_run(_run("a", "/outputs/a.png"))
    assert [r["id"] for r in db.list_runs()] == ["a"]
    assert db.count_runs(prompt_query="anything") == 0

    conn = sqlite3.connect(str(path))
    assert conn.execute("SELECT id, name FROM sets").fetchall() == [("set-1", "Summer drop")]
    assert conn.execute("SELECT set_id, url FROM set_items").fetchall() == [("set-1", "/outputs/a.png")]
    conn.close()
