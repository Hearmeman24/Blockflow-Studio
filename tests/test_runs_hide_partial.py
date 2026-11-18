"""`hide_partial` on /api/runs hides only runs with nothing generated to show.

A run is saved as `partial` when any block fails, also a viewer placed after a
generation that finished and was paid for. Hiding every partial run hid that
output from the Artifacts page and from a character's Generated tab. The rule:
a partial or failed run is hidden only when no block result holds an image,
video or audio that a generation job made (a ref with `meta.job_id`, the marker
`readGenerationMeta` reads in the frontend). Loader files and plain URLs do not
count. Completed runs are never hidden.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import db, mcp_runs, routes  # noqa: E402

ANA = "char_" + "a" * 32
BEA = "char_" + "b" * 32


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


def generated(name: str, kind: str = "image") -> dict:
    """A ref as a generation block emits it."""
    return {"kind": f"{kind}-ref", "local": f"/outputs/byok/{name}",
            "meta": {"job_id": f"job-{name}", "provider": "kie", "model": "seedream-5-pro", "cost": None}}


def character_file(character: str) -> dict:
    return {"kind": "image-ref", "local": f"/outputs/characters/{character}/media_{'0' * 32}_face.png"}


def block(index: int, block_type: str, status: str, outputs: dict | None = None) -> dict:
    return {"block_index": index, "block_type": block_type, "block_label": block_type,
            "status": status, "outputs": outputs or {}}


def run(run_id: str, minute: int, status: str, results: list[dict]) -> dict:
    return {"id": run_id, "name": run_id, "status": status, "duration_ms": 1,
            "flow_snapshot": {"blocks": []}, "block_results": results,
            "created_at": f"2026-01-01T00:{minute:02d}:00Z"}


def loader(character: str = ANA) -> dict:
    return block(0, "loadCharacter", "completed", {"image": {"kind": "image", "value": character_file(character)}})


def reported_run(run_id: str = "run-reported", minute: int = 1, character: str = ANA) -> dict:
    """Load Character -> Image to Image (done) -> Video Viewer (failed): the reported case."""
    return run(run_id, minute, "partial", [
        loader(character),
        block(1, "imageToImage", "completed", {"image": {"kind": "image", "value": generated(f"{run_id}.png")}}),
        block(2, "videoViewer", "error"),
    ])


def generation_failed_run(run_id: str, minute: int, character: str = ANA) -> dict:
    """The loader finished, the generation failed: only loader files in the results."""
    return run(run_id, minute, "partial", [
        loader(character), block(1, "imageToImage", "error"), block(2, "imageViewer", "idle"),
    ])


def mcp_job(job_id: str, status: str) -> dict:
    done = status == "COMPLETED"
    return {
        "job_id": job_id, "source": "mcp", "provider": "kie", "model": "seedream-5-pro", "mode": "text_to_image",
        "status": status, "error": None if done else {"kind": "provider", "message": "It failed."},
        "outputs": [{"kind": "image", "url": f"https://cdn.test/{job_id}.png",
                     "local_url": f"/outputs/byok/{job_id}_1.png"}] if done else [],
        "request": {"params": {"prompt": "a lighthouse", "settings": {}}, "references": [],
                    "client_request_id": f"mcp-{job_id}", "warnings": []},
        "created_at": 1794748971.0, "updated_at": 1794748991.0, "completed_at": 1794748991.0,
        "cancel_requested": False, "cost": None, "price_check": None,
    }


def names(rows: list[dict]) -> list[str]:
    return [r["id"] for r in rows]


def ids(res) -> list[str]:
    assert res.status_code == 200, res.text
    return [r["id"] for r in res.json()["runs"]]


# ---- the rule ----

def test_partial_run_with_a_finished_generation_is_shown(temp_db):
    temp_db.save_run(reported_run())
    assert names(temp_db.list_runs(hide_partial=True)) == ["run-reported"]
    assert temp_db.count_runs(hide_partial=True) == 1


def test_partial_run_with_only_loader_files_is_hidden(temp_db):
    temp_db.save_run(generation_failed_run("run-gen-failed", 1))
    assert temp_db.list_runs(hide_partial=True) == []
    assert temp_db.count_runs(hide_partial=True) == 0
    # Still there when the filter is off.
    assert names(temp_db.list_runs(hide_partial=False)) == ["run-gen-failed"]


def test_run_with_no_outputs_is_hidden(temp_db):
    temp_db.save_run(run("run-empty-partial", 1, "partial", [block(0, "textToImage", "error")]))
    temp_db.save_run(run("run-no-results", 2, "partial", []))
    assert temp_db.list_runs(hide_partial=True) == []
    assert temp_db.count_runs(hide_partial=True) == 0


def test_fully_failed_run_is_hidden(temp_db):
    temp_db.save_run(run("run-failed", 1, "failed", [loader(), block(1, "imageToImage", "error")]))
    assert temp_db.list_runs(hide_partial=True) == []
    assert temp_db.count_runs(hide_partial=True) == 0


def test_completed_run_is_shown_whatever_its_outputs(temp_db):
    temp_db.save_run(run("run-plain", 1, "completed", [
        block(0, "imageInspector", "completed", {"image": {"kind": "image", "value": "/outputs/a.png"}}),
    ]))
    temp_db.save_run(run("run-nothing", 2, "completed", [block(0, "promptWriter", "completed")]))
    assert names(temp_db.list_runs(hide_partial=True)) == ["run-nothing", "run-plain"]


@pytest.mark.parametrize("kind", ["image", "video", "audio"])
def test_every_generated_media_kind_counts(temp_db, kind):
    temp_db.save_run(run("run-kind", 1, "partial", [
        block(0, "gen", "completed", {kind: {"kind": kind, "value": generated(f"out.{kind}", kind)}}),
        block(1, "viewer", "error"),
    ]))
    assert names(temp_db.list_runs(hide_partial=True)) == ["run-kind"]


def test_one_generated_ref_in_a_list_is_enough(temp_db):
    """Several outputs where some failed: the port holds a list, also nested by an iterator."""
    temp_db.save_run(run("run-list", 1, "partial", [
        block(0, "textToImage", "completed",
              {"image": {"kind": "image", "value": ["/outputs/plain.png", [generated("b.png")]]}}),
    ]))
    assert names(temp_db.list_runs(hide_partial=True)) == ["run-list"]


def test_generation_after_a_generation_that_failed(temp_db):
    """The first generation finished, the second failed: the first output is shown."""
    temp_db.save_run(run("run-second-failed", 1, "partial", [
        block(0, "textToImage", "completed", {"image": {"kind": "image", "value": generated("first.png")}}),
        block(1, "imageToVideo", "error"),
    ]))
    assert names(temp_db.list_runs(hide_partial=True)) == ["run-second-failed"]


@pytest.mark.parametrize("value", [
    "/outputs/byok/plain.png",                                    # bare URL (old runs, Image Inspector)
    {"kind": "image-ref", "local": "/outputs/x.png"},             # ref without metadata (loaders, Video FX)
    {"kind": "image-ref", "local": "/outputs/x.png", "meta": {}},
    {"kind": "image-ref", "local": "/outputs/x.png", "meta": {"job_id": ""}},
    {"kind": "image-ref", "local": "/outputs/x.png", "meta": {"job_id": 7}},
    {"kind": "image-ref", "local": "/outputs/x.png", "meta": "job-1"},
    None,
])
def test_values_without_a_generation_job_do_not_count(temp_db, value):
    temp_db.save_run(run("run-not-generated", 1, "partial", [
        block(0, "videoFx", "completed", {"image": {"kind": "image", "value": value}}),
        block(1, "imageViewer", "error"),
    ]))
    assert temp_db.list_runs(hide_partial=True) == []


def test_generation_metadata_outside_a_media_port_does_not_count(temp_db):
    temp_db.save_run(run("run-metadata-port", 1, "partial", [
        block(0, "gen", "completed", {"metadata": {"kind": "metadata", "value": generated("x.png")}}),
    ]))
    assert temp_db.list_runs(hide_partial=True) == []


@pytest.mark.parametrize("results", [
    None, "nope", 7, {"a": 1}, [None, "x", 3],
    [{"outputs": None}], [{"outputs": "x"}], [{"outputs": {"image": None}}], [{"outputs": {"image": "x"}}],
    [{"outputs": {"image": {"kind": 3, "value": generated("x.png")}}}],
    [{"outputs": {"image": {"kind": "image"}}}],
])
def test_malformed_results_are_hidden_not_raised_on(temp_db, results):
    temp_db.save_run(run("run-malformed", 1, "partial", results))
    assert temp_db.list_runs(hide_partial=True) == []
    assert temp_db.count_runs(hide_partial=True) == 0


def test_status_is_matched_without_case(temp_db):
    temp_db.save_run(run("run-upper", 1, "PARTIAL", [block(0, "gen", "error")]))
    temp_db.save_run({**reported_run("run-upper-shown", 2), "status": "Partial"})
    assert names(temp_db.list_runs(hide_partial=True)) == ["run-upper-shown"]


# ---- MCP runs ----

def test_mcp_runs_failed_hidden_completed_shown(temp_db):
    done = mcp_runs.build_run(mcp_job("ok1", "COMPLETED"))
    failed = mcp_runs.build_run(mcp_job("bad1", "FAILED"))
    timed_out = mcp_runs.build_run(mcp_job("slow1", "TIMED_OUT"))
    assert done["status"] == "completed" and failed["status"] == "failed" and timed_out["status"] == "failed"
    for r in (done, failed, timed_out):
        temp_db.save_run(r)
    assert names(temp_db.list_runs(hide_partial=True)) == [done["id"]]
    assert names(temp_db.list_runs(hide_partial=True, source="mcp")) == [done["id"]]
    assert temp_db.count_runs(hide_partial=True, source="mcp") == 1
    assert temp_db.count_runs(hide_partial=False, source="mcp") == 3


def test_source_filter_combines_with_the_rule(temp_db):
    temp_db.save_run(reported_run("run-reported", 1))
    temp_db.save_run(mcp_runs.build_run(mcp_job("bad1", "FAILED")))
    assert names(temp_db.list_runs(hide_partial=True, source="pipeline")) == ["run-reported"]
    assert temp_db.list_runs(hide_partial=True, source="mcp") == []


# ---- the route: character filter, list and count ----

def test_character_filter_shows_the_reported_run_and_hides_runs_without_output(client, temp_db):
    temp_db.save_run(reported_run("run-ana-shown", 1, ANA))
    temp_db.save_run(generation_failed_run("run-ana-gen-failed", 2, ANA))
    temp_db.save_run(run("run-ana-failed", 3, "failed", [loader(ANA), block(1, "imageToImage", "error")]))
    temp_db.save_run(reported_run("run-bea-shown", 4, BEA))
    res = client.get("/api/runs", params={"character": ANA, "hide_partial": "1"})
    assert ids(res) == ["run-ana-shown"] and res.json()["total"] == 1
    res = client.get("/api/runs", params={"character": ANA, "hide_partial": "0"})
    assert ids(res) == ["run-ana-failed", "run-ana-gen-failed", "run-ana-shown"] and res.json()["total"] == 3


def test_route_list_and_total_agree_across_pages(client, temp_db):
    for i in range(3):
        temp_db.save_run(reported_run(f"run-shown-{i}", 2 * i))
        temp_db.save_run(generation_failed_run(f"run-hidden-{i}", 2 * i + 1))
    page1 = client.get("/api/runs", params={"hide_partial": "true", "limit": 2, "offset": 0})
    page2 = client.get("/api/runs", params={"hide_partial": "true", "limit": 2, "offset": 2})
    assert ids(page1) == ["run-shown-2", "run-shown-1"] and page1.json()["total"] == 3
    assert ids(page2) == ["run-shown-0"] and page2.json()["total"] == 3


def test_media_kind_filter_reads_the_shown_partial_run_as_an_image_run(client, temp_db):
    temp_db.save_run(reported_run())
    assert ids(client.get("/api/runs", params={"hide_partial": "true", "media_kind": "image"})) == ["run-reported"]
    assert ids(client.get("/api/runs", params={"hide_partial": "true", "media_kind": "video"})) == []
