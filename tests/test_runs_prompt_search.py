"""Artifacts prompt search over BYOK runs.

A BYOK pipeline run keeps its prompt in the saved flow
(``flow_snapshot.blocks[].config.prompt``, also inside ``branches``), and a
Prompt Writer block keeps its idea in ``config.user_prompt`` and its result in
``config.output`` and its ``text`` output. Runs saved for MCP jobs use the same
shape. The legacy ``metadata`` output form keeps matching.
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


def _gen(prompt, block_type="imageToImage", **extra):
    return {"type": block_type, "config": {"provider": "kie", "model": "seedream-5-flash", "prompt": prompt}, **extra}


def _run(run_id, blocks, block_results=None, created_at="2026-01-01T00:00:00Z"):
    return {
        "id": run_id, "name": run_id, "status": "completed", "duration_ms": 1,
        "flow_snapshot": {"name": "Pipeline Run", "version": 1, "schema_version": 5, "blocks": blocks},
        "block_results": block_results or [],
        "created_at": created_at,
    }


def test_matches_generation_block_prompt_case_insensitively(temp_db):
    temp_db.save_run(_run("a", [{"type": "uploadImageToTmpfiles", "config": {"items": []}},
                                _gen("A harsh FLASH photograph"), {"type": "imageViewer"}]))
    temp_db.save_run(_run("b", [_gen("a quiet beach")]))
    assert [r["id"] for r in temp_db.list_runs(prompt_query="flash")] == ["a"]
    assert temp_db.count_runs(prompt_query="Flash") == 1
    assert temp_db.count_runs(prompt_query="beach") == 1
    assert temp_db.count_runs(prompt_query="mountain") == 0


def test_matches_prompts_inside_branches(temp_db):
    nested = _gen("root", "textToImage", branches=[[_gen("deep forest", "imageToVideo",
                                                         branches=[[_gen("deeper cave", "imageToImage")]])]])
    temp_db.save_run(_run("tree", [nested]))
    assert temp_db.count_runs(prompt_query="forest") == 1
    assert temp_db.count_runs(prompt_query="cave") == 1


def test_matches_prompt_writer_user_prompt_output_and_text_result(temp_db):
    writer = {"type": "promptWriter", "config": {"user_prompt": "an idea about owls", "output": "Owls in moonlight"}}
    temp_db.save_run(_run("w", [writer, _gen("")], block_results=[
        {"block_index": 0, "block_type": "promptWriter", "block_label": "Prompt Writer", "status": "completed",
         "outputs": {"prompt": {"kind": "text", "value": "Edited: herons at dawn"}}},
    ]))
    assert temp_db.count_runs(prompt_query="owls") == 1
    assert temp_db.count_runs(prompt_query="moonlight") == 1
    assert temp_db.count_runs(prompt_query="herons") == 1


def test_does_not_match_model_or_provider_names(temp_db):
    temp_db.save_run(_run("m", [_gen("a cat")]))
    assert temp_db.count_runs(prompt_query="seedream") == 0
    assert temp_db.count_runs(prompt_query="kie") == 0


def test_legacy_metadata_form_still_matches(temp_db):
    temp_db.save_run(_run("old", [], block_results=[
        {"block_index": 0, "status": "ok",
         "outputs": {"metadata": {"kind": "metadata", "value": [{"prompt": "Legacy Lighthouse"}]}}},
    ]))
    assert temp_db.count_runs(prompt_query="lighthouse") == 1


@pytest.mark.parametrize("snapshot", [
    None, "not a flow", [], {"blocks": "nope"}, {"blocks": [None, 3, "x"]},
    {"blocks": [{"type": "imageToImage", "config": "bad"}]},
    {"blocks": [{"type": "imageToImage", "config": {"prompt": 42}}]},
    {"blocks": [{"type": "textToImage", "config": {"prompt": "ok"}, "branches": "bad"}]},
    {"blocks": [{"type": "textToImage", "config": {"prompt": "ok"}, "branches": [None, "x", [None]]}]},
])
def test_malformed_snapshots_never_raise(snapshot):
    assert db._run_matches_prompt([], "needle", snapshot) is False
    assert db._run_matches_prompt([{"outputs": "bad"}, None], "needle", snapshot) is False


def test_runs_route_q_finds_byok_runs(client, temp_db):
    temp_db.save_run(_run("a", [_gen("harsh flash photograph")]))
    temp_db.save_run(_run("b", [_gen("soft light")]))
    body = client.get("/api/runs?q=flash").json()
    assert body["total"] == 1
    assert body["runs"][0]["id"] == "a"
