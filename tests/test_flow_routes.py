"""HTTP route tests for /api/flows (saved flows and workspaces).

The backend stores flows as opaque JSON. Migration and block validation happen
in the frontend, so the backend must round-trip ``schema_version`` and block
types it does not know about without touching them, keep reading legacy files,
and refuse bodies it cannot store with a clear 4xx.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import config, routes  # noqa: E402


@pytest.fixture
def flows_dir(tmp_path, monkeypatch):
    path = tmp_path / "flows"
    path.mkdir()
    monkeypatch.setattr(config, "FLOWS_DIR", path)
    return path


@pytest.fixture
def client(flows_dir):
    app = FastAPI()
    app.include_router(routes.router)
    return TestClient(app)


LEGACY_BLOCK = {
    "type": "comfyGen",
    "label": "My ComfyUI Gen",
    "disabled": True,
    "sources": {"prompt": 0},
    "source_modes": {"prompt": "closest"},
    "source_selections": {"image": [0]},
    "config": {
        "workflow": {"3": {"inputs": {"seed": 1}}},
        "prompt": "a red fox, ünïcødé ✓",
        "nested": [None, 1.5, {"deep": [True]}],
    },
    "some_future_field": {"kept": 1},
}


def _flow(**overrides):
    flow = {
        "name": "Round Trip",
        "version": 2,
        "schema_version": 3,
        "created_at": "2026-11-15T00:00:00Z",
        "blocks": [
            {"type": "promptFromTxt", "config": {"prompts": ["one"]}},
            LEGACY_BLOCK,
            {"type": "videoViewer", "branches": [[{"type": "unknownPrivateBlock"}]]},
        ],
    }
    flow.update(overrides)
    return flow


def test_save_then_get_round_trips_schema_version_and_unknown_blocks(client, flows_dir):
    flow = _flow()
    saved = client.post("/api/flows", json={"name": "Round Trip", "flow": flow})
    assert saved.status_code == 200
    assert saved.json()["ok"] is True

    on_disk = json.loads((flows_dir / "Round Trip.flow.json").read_text(encoding="utf-8"))
    assert on_disk == flow

    loaded = client.get("/api/flows/Round Trip")
    assert loaded.status_code == 200
    body = loaded.json()
    assert body["flow"] == flow
    assert body["flow"]["schema_version"] == 3
    assert body["flow"]["blocks"][1] == LEGACY_BLOCK
    assert body["flow"]["blocks"][2]["branches"][0][0]["type"] == "unknownPrivateBlock"


def test_round_trips_newer_schema_version_unchanged(client):
    flow = _flow(schema_version=99, future_top_level={"x": 1})
    assert client.post("/api/flows", json={"name": "future", "flow": flow}).status_code == 200
    assert client.get("/api/flows/future").json()["flow"] == flow


def test_round_trips_workspace_container(client):
    workspace = {"tabs": [{"label": "A", "flow": _flow()}, {"label": "B", "flow": _flow(version=1)}]}
    assert client.post("/api/flows", json={"name": "_workspace_mine", "flow": workspace}).status_code == 200
    assert client.get("/api/flows/_workspace_mine").json()["flow"] == workspace


def test_reads_legacy_json_file_without_schema_version(client, flows_dir):
    legacy = {
        "name": "Old",
        "version": 1,
        "created_at": "2025-01-01T00:00:00Z",
        "blocks": [{"type": "loraTrain", "config": {"trigger_word": "zzz"}}],
    }
    (flows_dir / "Old.json").write_text(json.dumps(legacy), encoding="utf-8")

    listed = client.get("/api/flows").json()["flows"]
    assert [f["name"] for f in listed] == ["Old"]

    loaded = client.get("/api/flows/Old")
    assert loaded.status_code == 200
    assert loaded.json()["flow"] == legacy
    assert "schema_version" not in loaded.json()["flow"]


def test_rejects_non_json_body_with_4xx(client, flows_dir):
    r = client.post(
        "/api/flows",
        content=b"{not json",
        headers={"content-type": "application/json"},
    )
    assert 400 <= r.status_code < 500
    assert list(flows_dir.iterdir()) == []


def test_rejects_non_object_body_with_4xx(client, flows_dir):
    r = client.post("/api/flows", json=[{"name": "x", "flow": {}}])
    assert 400 <= r.status_code < 500
    assert list(flows_dir.iterdir()) == []


@pytest.mark.parametrize("bad_flow", [None, [], "string", 3, True])
def test_rejects_non_object_flow_with_400(client, flows_dir, bad_flow):
    r = client.post("/api/flows", json={"name": "bad", "flow": bad_flow})
    assert r.status_code == 400
    assert r.json() == {"ok": False, "error": "flow must be a JSON object"}
    assert list(flows_dir.iterdir()) == []


def test_rejects_oversized_flow_with_413_and_writes_nothing(client, flows_dir):
    huge = "x" * (routes.MAX_FLOW_BYTES + 1)
    r = client.post(
        "/api/flows",
        json={"name": "huge", "flow": _flow(blocks=[{"type": "comfyGen", "config": {"prompt": huge}}])},
    )
    assert r.status_code == 413
    assert r.json()["ok"] is False
    assert "too large" in r.json()["error"]
    assert list(flows_dir.iterdir()) == []


def test_oversized_save_does_not_clobber_existing_flow(client, flows_dir):
    original = _flow()
    assert client.post("/api/flows", json={"name": "keep", "flow": original}).status_code == 200
    huge = "x" * (routes.MAX_FLOW_BYTES + 1)
    r = client.post("/api/flows", json={"name": "keep", "flow": {"blocks": [], "pad": huge}})
    assert r.status_code == 413
    assert client.get("/api/flows/keep").json()["flow"] == original


def test_get_corrupt_flow_file_returns_error_not_crash(client, flows_dir):
    (flows_dir / "broken.flow.json").write_text("{oops", encoding="utf-8")
    r = client.get("/api/flows/broken")
    assert r.status_code == 500
    assert r.json()["ok"] is False
    assert "failed reading flow" in r.json()["error"]
