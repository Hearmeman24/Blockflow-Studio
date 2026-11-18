"""/api/runs?character=<id>[,<id>...]: runs made with a character.

A run was made with a character when a reference that was sent comes from that
character's folder: a ref in the outputs of a block result (the Load Character
block's ports in a pipeline run, the loader block of an MCP run) whose `local`
is under `/outputs/characters/<character id>/`. The saved block config in
`flow_snapshot` is deliberately not read: it also lists files that were
selected but not sent.
"""
from __future__ import annotations

import sys
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import db, routes  # noqa: E402

ANA = "char_" + "a" * 32
BEA = "char_" + "b" * 32
CAL = "char_" + "c" * 32


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "runs.db")
    db.init_db()
    return db


@pytest.fixture
def client(temp_db):
    app = FastAPI()
    app.include_router(routes.router)
    return TestClient(app)


def ref(character: str, name: str = "face.png", kind: str = "image-ref") -> dict:
    local = f"/outputs/characters/{character}/media_{'0' * 32}_{quote(name, safe='')}"
    return {"kind": kind, "local": local, "label": name}


def pipeline_run(run_id: str, minute: int, *, loaded: dict[str, list[dict]] | None = None,
                 out_kind: str = "image", status: str = "completed", prompt: str = "a cat",
                 selected_only: list[str] | None = None) -> dict:
    """What the frontend saves: Load Character -> generation -> viewer."""
    loader_outputs = {
        port: {"kind": port, "value": refs if len(refs) != 1 else refs[0]}
        for port, refs in (loaded or {}).items()
    }
    ext = "mp4" if out_kind == "video" else "png"
    gen_out = {out_kind: {"kind": out_kind, "value": {"kind": f"{out_kind}-ref", "local": f"/outputs/{run_id}.{ext}"}}}
    # The saved config also lists files that were selected but not sent.
    config_files = [{"id": "x", "local": ref(c)["local"]} for c in (selected_only or [])]
    return {
        "id": run_id, "name": run_id, "status": status, "duration_ms": 1,
        "flow_snapshot": {"blocks": [
            {"type": "loadCharacter", "config": {"selection": {"image": config_files}}},
            {"type": "imageToImage", "config": {"prompt": prompt}},
        ]},
        "block_results": [
            {"block_index": 0, "block_type": "loadCharacter", "block_label": "Load Character",
             "status": "completed", "outputs": loader_outputs},
            {"block_index": 1, "block_type": "imageToImage", "block_label": "Image to Image",
             "status": "completed", "outputs": gen_out},
        ],
        "created_at": f"2026-01-01T00:{minute:02d}:00Z",
    }


def mcp_run(run_id: str, minute: int, refs: list[dict], out_kind: str = "image") -> dict:
    """What backend.mcp_runs.build_run saves: loader -> generation -> viewer."""
    value = {"kind": f"{out_kind}-ref", "local": f"/outputs/{run_id}.png"}
    return {
        "id": run_id, "name": run_id, "status": "completed", "duration_ms": 1,
        "flow_snapshot": {"blocks": []},
        "block_results": [
            {"block_index": 0, "block_type": "uploadImageToTmpfiles", "block_label": "Image Loader",
             "status": "completed", "outputs": {"image": {"kind": "image", "value": refs[0] if len(refs) == 1 else refs}}},
            {"block_index": 1, "block_type": "imageToImage", "block_label": "Image to Image",
             "status": "completed", "outputs": {out_kind: {"kind": out_kind, "value": value}}},
        ],
        "created_at": f"2026-01-01T00:{minute:02d}:00Z",
    }


def ids(res) -> list[str]:
    assert res.status_code == 200, res.text
    return [r["id"] for r in res.json()["runs"]]


@pytest.fixture
def seeded(temp_db):
    temp_db.save_run(pipeline_run("run-p-ana", 1, loaded={"image": [ref(ANA)]}))
    temp_db.save_run(pipeline_run("run-p-both", 2, loaded={"image": [ref(ANA), ref(BEA)]}))
    temp_db.save_run(pipeline_run("run-p-bea-video", 3, loaded={"image": [ref(BEA)]}, out_kind="video"))
    temp_db.save_run(mcp_run("run-mcp-ana", 4, [ref(ANA, "side view.png")]))
    temp_db.save_run(mcp_run("run-mcp-none", 5, [{"kind": "image-ref", "local": "/outputs/other.png"}]))
    temp_db.save_run(pipeline_run("run-p-selected-only", 6, loaded={}, selected_only=[ANA]))
    temp_db.save_run(pipeline_run("run-p-voice-ana", 7, loaded={"voice": [ref(ANA, "v.mp3", "voice-ref")]}))
    return temp_db


def test_single_character(client, seeded):
    res = client.get("/api/runs", params={"character": ANA})
    assert ids(res) == ["run-p-voice-ana", "run-mcp-ana", "run-p-both", "run-p-ana"]
    assert res.json()["total"] == 4


def test_several_ids_mean_any_of_them(client, seeded):
    res = client.get("/api/runs", params={"character": f"{BEA},{CAL}"})
    assert ids(res) == ["run-p-bea-video", "run-p-both"]
    assert res.json()["total"] == 2
    res = client.get("/api/runs", params={"character": f"{ANA},{BEA}"})
    assert ids(res) == ["run-p-voice-ana", "run-mcp-ana", "run-p-bea-video", "run-p-both", "run-p-ana"]


def test_selected_but_not_sent_does_not_match(client, seeded):
    assert "run-p-selected-only" not in ids(client.get("/api/runs", params={"character": ANA}))


def test_url_quoted_file_names_match(client, seeded):
    # run-mcp-ana's file is "side view.png", stored as side%20view.png
    assert "%20" in seeded.get_run("run-mcp-ana")["block_results"][0]["outputs"]["image"]["value"]["local"]
    assert "run-mcp-ana" in ids(client.get("/api/runs", params={"character": ANA}))


def test_unknown_and_malformed_ids(client, seeded):
    assert ids(client.get("/api/runs", params={"character": CAL})) == []
    assert client.get("/api/runs", params={"character": CAL}).json()["total"] == 0
    everything = ids(client.get("/api/runs"))
    for bad in ("", "nonsense", "char_xyz", "char_" + "A" * 32, "../x", ",,"):
        res = client.get("/api/runs", params={"character": bad})
        assert ids(res) == everything, bad
        assert res.json()["total"] == len(everything)
    # a malformed id beside a good one is ignored, the good one still filters
    assert ids(client.get("/api/runs", params={"character": f"nonsense,{BEA}"})) == ["run-p-bea-video", "run-p-both"]


def test_no_param_is_unchanged(client, seeded):
    res = client.get("/api/runs")
    assert res.json()["total"] == 7 and len(ids(res)) == 7


def test_combines_with_media_kind(client, seeded):
    res = client.get("/api/runs", params={"character": BEA, "media_kind": "video"})
    assert ids(res) == ["run-p-bea-video"] and res.json()["total"] == 1
    res = client.get("/api/runs", params={"character": BEA, "media_kind": "image"})
    assert ids(res) == ["run-p-both"]


def test_combines_with_source(client, seeded):
    assert ids(client.get("/api/runs", params={"character": ANA, "source": "mcp"})) == ["run-mcp-ana"]
    res = client.get("/api/runs", params={"character": ANA, "source": "pipeline"})
    assert ids(res) == ["run-p-voice-ana", "run-p-both", "run-p-ana"] and res.json()["total"] == 3


def test_combines_with_favorited(client, seeded):
    seeded.toggle_run_favorited("run-p-both")
    res = client.get("/api/runs", params={"character": ANA, "favorited": "true"})
    assert ids(res) == ["run-p-both"] and res.json()["total"] == 1


def test_combines_with_q(client, temp_db):
    temp_db.save_run(pipeline_run("run-p-1", 1, loaded={"image": [ref(ANA)]}, prompt="red fox"))
    temp_db.save_run(pipeline_run("run-p-2", 2, loaded={"image": [ref(ANA)]}, prompt="blue owl"))
    temp_db.save_run(pipeline_run("run-p-3", 3, loaded={"image": [ref(BEA)]}, prompt="red fox"))
    res = client.get("/api/runs", params={"character": ANA, "q": "fox"})
    assert ids(res) == ["run-p-1"] and res.json()["total"] == 1


def test_combines_with_hide_partial(client, temp_db):
    temp_db.save_run(pipeline_run("run-p-ok", 1, loaded={"image": [ref(ANA)]}))
    temp_db.save_run(pipeline_run("run-p-part", 2, loaded={"image": [ref(ANA)]}, status="partial"))
    temp_db.save_run(pipeline_run("run-p-fail", 3, loaded={"image": [ref(ANA)]}, status="failed"))
    res = client.get("/api/runs", params={"character": ANA, "hide_partial": "true"})
    assert ids(res) == ["run-p-ok"] and res.json()["total"] == 1


def test_pagination_with_total(client, temp_db):
    for i in range(5):
        temp_db.save_run(pipeline_run(f"run-p-a{i}", i, loaded={"image": [ref(ANA)]}))
        temp_db.save_run(pipeline_run(f"run-p-b{i}", i, loaded={"image": [ref(BEA)]}))
    page1 = client.get("/api/runs", params={"character": ANA, "limit": 2, "offset": 0})
    page3 = client.get("/api/runs", params={"character": ANA, "limit": 2, "offset": 4})
    assert ids(page1) == ["run-p-a4", "run-p-a3"] and page1.json()["total"] == 5
    assert ids(page3) == ["run-p-a0"] and page3.json()["total"] == 5


def test_malformed_run_data_is_skipped(temp_db):
    weird = [None, "x", {"outputs": None}, {"outputs": {"image": "str"}},
             {"outputs": {"image": {"kind": "image", "value": [None, 3, {"local": 5}, {"local": None}]}}},
             {"outputs": {"text": {"kind": "text", "value": f"/outputs/characters/{ANA}/x.png in a prompt"}}}]
    assert db._run_character_ids({"block_results": weird, "flow_snapshot": 3}) == set()
    assert db._run_character_ids({}) == set()
    assert db._run_character_ids({"block_results": "nope"}) == set()


def test_helper_only_accepts_the_character_folder_shape(temp_db):
    def run_with(local):
        return {"block_results": [{"outputs": {"image": {"kind": "image", "value": {"local": local}}}}]}
    assert db._run_character_ids(run_with(f"/outputs/characters/{ANA}/f.png")) == {ANA}
    assert db._run_character_ids(run_with(f"/outputs/characters/{ANA}/")) == set()
    assert db._run_character_ids(run_with(f"/outputs/characters/{ANA}x/f.png")) == set()
    assert db._run_character_ids(run_with(f"/outputs/characters/{ANA.upper()}/f.png")) == set()
    assert db._run_character_ids(run_with(f"/outputs/other/characters/{ANA}/f.png")) == set()
