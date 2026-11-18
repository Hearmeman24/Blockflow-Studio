"""Runs saved for MCP jobs (backend/mcp_runs.py).

A job submitted with ``source: "mcp"`` gets exactly one run in the Artifacts
history when it ends: COMPLETED -> a completed run with the outputs,
FAILED / TIMED_OUT -> a failed run (the pipeline records failed runs too),
CANCELLED -> no run (a cancelled pipeline run records no failure either).

The frontend snapshot fixture ``frontend/src/lib/byok/__fixtures__/mcp-run-snapshots.json``
is regenerated here and compared byte for byte; Vitest imports it through
``importFlowWithReport``. Refresh after a deliberate change:

    uv run python tests/test_mcp_runs.py
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend import (  # noqa: E402
    config,
    db,
    job_store,
    mcp_runs,
    output_folder,  # noqa: E402
)

FIXTURE = ROOT / "frontend" / "src" / "lib" / "byok" / "__fixtures__" / "mcp-run-snapshots.json"
CREATED = 1794748971.0


def _job(mode="text_to_image", *, status="COMPLETED", provider="kie", model="seedream-5-pro", refs=(),
         params=None, outputs=None, label=None, job_id="job0001", source="mcp", error=None, cost=None):
    output_kind = "video" if "video" in mode else "image"
    request = {"params": params if params is not None else {"prompt": "a lighthouse at dusk", "settings": {}},
               "references": list(refs), "client_request_id": f"mcp-{job_id}", "warnings": []}
    if label is not None:
        request["label"] = label
    return {
        "job_id": job_id, "source": source, "provider": provider, "model": model, "mode": mode,
        "status": status, "remote_job_id": "r1", "remote_status": "success", "progress": 1.0, "message": "Done",
        "error": error,
        "outputs": outputs if outputs is not None else (
            [{"kind": output_kind, "url": f"https://cdn.test/{job_id}.out",
              "local_url": f"/outputs/byok/{job_id}_1.{'mp4' if output_kind == 'video' else 'png'}"}]
            if status == "COMPLETED" else []),
        "request": request, "created_at": CREATED, "updated_at": CREATED + 20, "completed_at": CREATED + 20,
        "cancel_requested": False, "cost": cost, "price_check": None,
    }


# Fixture jobs: one per mode, covering every loader list and both frame roles.
FIXTURE_JOBS = {
    "text_to_image": _job("text_to_image", job_id="fx-t2i",
                          params={"prompt": "a lighthouse", "aspect_ratio": "16:9", "settings": {"quality": "high"}}),
    "image_to_image": _job("image_to_image", job_id="fx-i2i", model="seedream-5-flash",
                           refs=[{"kind": "image", "local": "/outputs/cat.png", "role": "reference",
                                  "width": 1024, "height": 1024, "size_bytes": 2048}],
                           params={"prompt": "make Image1 a watercolour", "resolution": "1.5K", "settings": {}}),
    "text_to_video": _job("text_to_video", job_id="fx-t2v", model="seedance-2",
                          params={"prompt": "a fox in snow", "duration": 5, "resolution": "720p",
                                  "aspect_ratio": "16:9", "settings": {"generate_audio": True}},
                          cost={"amount": 205.0, "unit": "credits", "usd_equivalent": 1.025}),
    "image_to_video": _job("image_to_video", job_id="fx-i2v", model="seedance-2",
                           refs=[{"kind": "image", "url": "https://img.test/last.jpg", "role": "last_frame"},
                                 {"kind": "image", "local": "/outputs/first.png", "role": "first_frame"}],
                           params={"prompt": "the camera pushes in", "duration": 5, "settings": {}}),
    "omni_reference_to_video": _job(
        "omni_reference_to_video", job_id="fx-omni", provider="piapi", model="seedance-2",
        refs=[{"kind": "video", "local": "/outputs/motion.mp4", "role": "reference", "duration_s": 4.2},
              {"kind": "image", "local": "/outputs/face.png", "role": "reference"},
              {"kind": "audio", "local": "/outputs/beat.mp3", "role": "reference", "duration_s": 6},
              {"kind": "voice", "local": "/outputs/anna.wav", "role": "reference", "name": "Anna"}],
        params={"prompt": "@image1 dances like @video1 while Anna sings", "duration": 5, "settings": {}},
        label="Omni test"),
}


def render_fixture() -> str:
    snapshots = {mode: mcp_runs.build_flow_snapshot(job) for mode, job in FIXTURE_JOBS.items()}
    return json.dumps(snapshots, ensure_ascii=False, indent=2) + "\n"


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "run_history.db")
    out = tmp_path / "output"
    out.mkdir()
    monkeypatch.setattr(output_folder, "_state", output_folder.pinned_state(out))
    db.init_db()
    yield db


# ------------------------------------------------------------------ snapshot


def test_snapshot_fixture_matches_builder():
    assert FIXTURE.is_file(), f"{FIXTURE} is missing; run `uv run python tests/test_mcp_runs.py`"
    assert FIXTURE.read_text(encoding="utf-8") == render_fixture(), (
        "mcp-run-snapshots.json is out of date; run `uv run python tests/test_mcp_runs.py`")


def test_snapshot_shape_text_to_video():
    snap = mcp_runs.build_flow_snapshot(FIXTURE_JOBS["text_to_video"])
    assert snap["schema_version"] == mcp_runs.FLOW_SCHEMA_VERSION == 6
    assert snap["version"] == 1
    assert [b["type"] for b in snap["blocks"]] == ["textToVideo", "videoViewer"]
    assert snap["blocks"][0]["config"] == {
        "provider": "kie", "model": "seedance-2", "prompt": "a fox in snow", "use_upstream_prompt": False,
        "params": {"duration": 5, "resolution": "720p", "aspect_ratio": "16:9",
                   "settings": {"generate_audio": True}},
    }


def test_snapshot_image_to_video_orders_first_frame_before_last():
    snap = mcp_runs.build_flow_snapshot(FIXTURE_JOBS["image_to_video"])
    assert [b["type"] for b in snap["blocks"]] == ["uploadImageToTmpfiles", "imageToVideo", "videoViewer"]
    items = snap["blocks"][0]["config"]["items"]
    assert [i.get("local") or i.get("url") for i in items] == ["/outputs/first.png", "https://img.test/last.jpg"]
    assert all(i["status"] == "ready" and i["id"] and i["label"] for i in items)
    assert items[0]["label"] == "first.png" and items[1]["label"] == "last.jpg"


def test_snapshot_omni_has_one_list_per_kind_and_a_former_voice_is_audio():
    snap = mcp_runs.build_flow_snapshot(FIXTURE_JOBS["omni_reference_to_video"])
    loader, gen, viewer = snap["blocks"]
    assert loader["type"] == "omniReferenceLoader" and gen["type"] == "omniReferenceToVideo"
    assert viewer["type"] == "videoViewer"
    cfg = loader["config"]
    assert list(cfg) == ["video_items", "image_items", "audio_items"]
    # A job stored before the merge holds a "voice": it is an audio item, in request order, without its name.
    assert [(i["id"], i["local"]) for i in cfg["audio_items"]] == [
        ("mcp-fx-omni-audio-0", "/outputs/beat.mp3"), ("mcp-fx-omni-audio-1", "/outputs/anna.wav")]
    assert all("name" not in i for i in cfg["audio_items"])
    assert cfg["video_items"][0]["duration_s"] == 4.2
    assert "name" not in cfg["image_items"][0]


def test_text_modes_have_no_loader_and_absolute_local_is_rewritten(temp_db):
    snap = mcp_runs.build_flow_snapshot(FIXTURE_JOBS["text_to_image"])
    assert [b["type"] for b in snap["blocks"]] == ["textToImage", "imageViewer"]
    (config.output_dir() / "sub").mkdir()
    absolute = str(config.output_dir() / "sub" / "a.png")
    job = _job("image_to_image", refs=[{"kind": "image", "local": absolute, "role": "reference"}])
    item = mcp_runs.build_flow_snapshot(job)["blocks"][0]["config"]["items"][0]
    assert item["local"] == "/outputs/sub/a.png"


# ------------------------------------------------------------------ run


def test_completed_run_shape():
    job = _job("text_to_video", model="seedance-2", job_id="abc123",
               cost={"amount": 3.0, "unit": "credits", "usd_equivalent": 0.015})
    run = mcp_runs.build_run(job)
    assert run["id"] == "run-mcp-abc123"
    assert run["status"] == "completed"
    assert run["duration_ms"] == 20000
    assert run["name"].startswith("MCP — Seedance 2 — ")
    gen, viewer = run["block_results"]
    ref = {"kind": "video-ref", "local": "/outputs/byok/abc123_1.mp4", "url": "https://cdn.test/abc123.out",
           "meta": {"job_id": "abc123", "provider": "kie", "model": "seedance-2",
                    "cost": {"amount": 3.0, "unit": "credits", "usd_equivalent": 0.015}}}
    assert gen == {"block_index": 0, "block_type": "textToVideo", "block_label": "Text to Video",
                   "status": "completed", "outputs": {"video": {"kind": "video", "value": ref}}}
    assert viewer["block_type"] == "videoViewer" and viewer["outputs"]["video"]["value"] == ref
    assert db._primary_media_kind(run["block_results"]) == "video"


def test_label_names_the_run_and_multiple_outputs_are_a_list():
    job = _job(label="Hero shots", outputs=[
        {"kind": "image", "url": "https://cdn.test/1.png", "local_url": "/outputs/byok/j_1.png"},
        {"kind": "image", "url": "https://cdn.test/2.png"},
    ])
    run = mcp_runs.build_run(job)
    assert run["name"] == "Hero shots"
    value = run["block_results"][0]["outputs"]["image"]["value"]
    assert [v["local"] for v in value] == ["/outputs/byok/j_1.png", "https://cdn.test/2.png"]


def test_loader_block_result_mirrors_loader_outputs():
    run = mcp_runs.build_run(FIXTURE_JOBS["image_to_image"])
    loader = run["block_results"][0]
    assert loader["block_type"] == "uploadImageToTmpfiles" and loader["status"] == "completed"
    assert loader["outputs"]["image"] == {"kind": "image", "value": {
        "kind": "image-ref", "local": "/outputs/cat.png", "label": "cat.png", "size_bytes": 2048,
        "width": 1024, "height": 1024}}


def test_omni_loader_outputs_have_no_voice_port():
    loader = mcp_runs.build_run(FIXTURE_JOBS["omni_reference_to_video"])["block_results"][0]
    assert set(loader["outputs"]) == {"video", "image", "audio"}
    audio = loader["outputs"]["audio"]
    assert audio["kind"] == "audio"
    assert [(v["kind"], v["local"], "name" in v) for v in audio["value"]] == [
        ("audio-ref", "/outputs/beat.mp3", False), ("audio-ref", "/outputs/anna.wav", False)]


@pytest.mark.parametrize("status", ["FAILED", "TIMED_OUT"])
def test_failed_job_gives_failed_run(status):
    job = _job(status=status, error={"kind": "content_rejected", "message": "Rejected by Kie."})
    run = mcp_runs.build_run(job)
    assert run["status"] == "failed"
    gen, viewer = run["block_results"]
    assert gen["status"] == "error" and gen["outputs"] == {} and gen["error"] == "Rejected by Kie."
    assert viewer["status"] == "skipped"


@pytest.mark.parametrize("job", [
    _job(status="CANCELLED"), _job(status="RUNNING"), _job(status="QUEUED"), _job(source="pipeline"),
    _job(mode="unknown_mode"),
])
def test_no_run_for_cancelled_active_pipeline_or_unknown(job):
    assert mcp_runs.build_run(job) is None


def test_save_is_exactly_once_and_survives_restart_and_delete(temp_db):
    job = _job(job_id="once1")
    assert mcp_runs.save_run_for_job(job) is True
    assert mcp_runs.save_run_for_job(job) is False
    assert [r["id"] for r in db.list_runs()] == ["run-mcp-once1"]
    # "Restart": a fresh init and another save attempt of the same job.
    db.init_db()
    mcp_runs.init_db()
    assert mcp_runs.save_run_for_job(job) is False
    # A run the user deleted is not brought back.
    assert db.delete_run("run-mcp-once1")
    assert mcp_runs.save_run_for_job(job) is False
    assert db.list_runs() == []


def test_saved_run_is_mcp_filtered_and_prompt_searchable(temp_db):
    mcp_runs.save_run_for_job(_job(job_id="s1", params={"prompt": "A Harsh Flash photo", "settings": {}}))
    db.save_run({"id": "run-1-x", "name": "p", "status": "completed", "flow_snapshot": {"blocks": []},
                 "block_results": [], "created_at": "2026-01-01T00:00:00Z"})
    assert [r["id"] for r in db.list_runs(source="mcp")] == ["run-mcp-s1"]
    assert [r["id"] for r in db.list_runs(prompt_query="flash")] == ["run-mcp-s1"]
    stored = db.get_run("run-mcp-s1")
    assert stored["flow_snapshot"]["blocks"][0]["config"]["prompt"] == "A Harsh Flash photo"


def test_event_hook_saves_terminal_mcp_jobs_only(temp_db):
    store = job_store.get_store()
    unsubscribe = mcp_runs.install(store)
    try:
        mcp = store.create_job(source="mcp", provider="kie", model="seedream-5-pro", mode="text_to_image",
                               request={"params": {"prompt": "hook test"}, "references": []})
        pipe = store.create_job(source="pipeline", provider="kie", model="seedream-5-pro", mode="text_to_image",
                                request={"params": {"prompt": "pipe"}, "references": []})
        cancelled = store.create_job(source="mcp", provider="kie", model="seedream-5-pro", mode="text_to_image",
                                     request={"params": {"prompt": "c"}, "references": []})
        store.update_job(mcp["job_id"], status="RUNNING")
        assert db.list_runs() == []
        done_out = [{"kind": "image", "url": "https://cdn.test/x.png", "local_url": "/outputs/byok/x.png"}]
        store.update_job(mcp["job_id"], status="COMPLETED", outputs=done_out)
        store.update_job(pipe["job_id"], status="COMPLETED", outputs=done_out)
        store.request_cancel(cancelled["job_id"])
        # A late update to a terminal job is ignored by the store; no second run.
        store.update_job(mcp["job_id"], status="COMPLETED", outputs=done_out)
    finally:
        unsubscribe()
    assert [r["id"] for r in db.list_runs()] == [f"run-mcp-{mcp['job_id']}"]


def test_sweep_saves_missed_jobs_once(temp_db):
    store = job_store.get_store()
    job = store.create_job(source="mcp", provider="kie", model="seedream-5-pro", mode="text_to_image",
                           request={"params": {"prompt": "missed"}, "references": []})
    store.update_job(job["job_id"], status="COMPLETED",
                     outputs=[{"kind": "image", "url": "https://cdn.test/m.png"}])
    assert mcp_runs.sweep(store) == [job["job_id"]]
    assert mcp_runs.sweep(store) == []
    assert len(db.list_runs()) == 1


def test_startup_sweeps_then_listens(temp_db, capsys):
    from backend import main

    store = job_store.get_store()
    before = store.create_job(source="mcp", provider="kie", model="seedream-5-pro", mode="text_to_image",
                              request={"params": {"prompt": "before start"}, "references": []})
    store.update_job(before["job_id"], status="COMPLETED", outputs=[{"kind": "image", "url": "https://cdn.test/b.png"}])
    unsubscribe = main._save_mcp_runs_on_startup()
    try:
        after = store.create_job(source="mcp", provider="kie", model="seedream-5-pro", mode="text_to_image",
                                 request={"params": {"prompt": "after start"}, "references": []})
        store.update_job(after["job_id"], status="FAILED", error={"kind": "auth", "message": "No key."})
    finally:
        unsubscribe()
    runs = {r["id"]: r["status"] for r in db.list_runs()}
    assert runs == {f"run-mcp-{before['job_id']}": "completed", f"run-mcp-{after['job_id']}": "failed"}
    assert "saved 1 MCP run" in capsys.readouterr().out


def test_startup_hook_never_raises(temp_db, monkeypatch, capsys):
    from backend import main

    def broken(store=None):
        raise RuntimeError("disk gone")

    monkeypatch.setattr(mcp_runs, "sweep", broken)
    unsubscribe = main._save_mcp_runs_on_startup()
    unsubscribe()
    assert "disk gone" in capsys.readouterr().out


def test_hook_never_raises_on_garbage(temp_db):
    for event in (None, {}, {"job": None}, {"job": {"source": "mcp", "status": "COMPLETED"}}, "x"):
        mcp_runs.on_job_event(event)
    assert db.list_runs() == []


def test_marker_table_lives_beside_runs(temp_db):
    mcp_runs.save_run_for_job(_job(job_id="m1"))
    conn = sqlite3.connect(str(db.DB_PATH))
    assert conn.execute(f"SELECT job_id, run_id FROM {mcp_runs.MARKER_TABLE}").fetchall() == [("m1", "run-mcp-m1")]
    conn.close()


# ------------------------------------------------------------------ job status -> run status


def test_run_mapping_is_exhaustive_over_job_statuses():
    from backend.statuses import JobStatus, RunStatus

    assert set(mcp_runs.RUN_FOR_JOB_STATUS) == set(JobStatus)
    assert mcp_runs.RUN_FOR_JOB_STATUS == {
        JobStatus.QUEUED: None, JobStatus.RUNNING: None, JobStatus.CANCELLED: None,
        JobStatus.COMPLETED: RunStatus.COMPLETED, JobStatus.FAILED: RunStatus.FAILED,
        JobStatus.TIMED_OUT: RunStatus.FAILED,
    }
    assert mcp_runs.RUN_RECORDED_STATUSES == (JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.TIMED_OUT)


@pytest.mark.parametrize("mode,outputs,kind", [
    ("text_to_image", [], "image"),
    ("text_to_video", [], "video"),
    ("text_to_image", [{"kind": "video", "url": "https://cdn.test/x.mp4"}], "image"),
])
def test_completed_job_without_an_output_of_its_kind_says_so(mode, outputs, kind):
    run = mcp_runs.build_run(_job(mode, outputs=outputs))
    assert run["status"] == "failed"
    gen = run["block_results"][0]
    assert gen["status"] == "error"
    assert gen["error"] != "Done"
    assert gen["error"] == f"The job finished but returned no {kind} output."


def test_failed_job_without_an_error_still_uses_its_message():
    run = mcp_runs.build_run(_job(status="FAILED", error=None))
    assert run["block_results"][0]["error"] == "Done"  # the job's own message, as before


def _finished_mcp_job(store, n):
    job = store.create_job(source="mcp", provider="kie", model="seedream-5-pro", mode="text_to_image",
                           request={"params": {"prompt": f"job {n}"}, "references": []})
    store.update_job(job["job_id"], status="COMPLETED",
                     outputs=[{"kind": "image", "url": f"https://cdn.test/{n}.png"}])
    return job["job_id"]


def test_sweep_pages_through_every_finished_job(temp_db, monkeypatch):
    monkeypatch.setattr(mcp_runs, "SWEEP_PAGE_SIZE", 2)
    store = job_store.get_store()
    ids = [_finished_mcp_job(store, n) for n in range(5)]
    assert sorted(mcp_runs.sweep(store)) == sorted(ids)
    assert len(db.list_runs()) == 5
    assert mcp_runs.sweep(store) == []


def test_sweep_skips_jobs_that_already_have_a_run_without_rewriting(temp_db, monkeypatch):
    store = job_store.get_store()
    first = _finished_mcp_job(store, 1)
    assert mcp_runs.sweep(store) == [first]
    saved: list[str] = []
    real = mcp_runs.save_run_for_job
    monkeypatch.setattr(mcp_runs, "save_run_for_job", lambda job: saved.append(job["job_id"]) or real(job))
    second = _finished_mcp_job(store, 2)
    assert mcp_runs.sweep(store) == [second]
    assert saved == [second]


def test_startup_installs_the_hook_and_sweeps_before_resuming_jobs():
    """main.py order is load-bearing: listen, sweep, then resume (a resumed job
    that ends at once must find the hook installed)."""
    import ast

    tree = ast.parse((ROOT / "backend" / "main.py").read_text(encoding="utf-8"))
    guard = next(n for n in tree.body if isinstance(n, ast.If) and "pytest" in ast.unparse(n.test))
    calls = [ast.unparse(s.value.func) for s in guard.body if isinstance(s, ast.Expr) and isinstance(s.value, ast.Call)]
    assert calls.index("_save_mcp_runs_on_startup") < calls.index("_resume_generation_jobs_on_startup")


if __name__ == "__main__":
    FIXTURE.write_text(render_fixture(), encoding="utf-8")
    print(f"wrote {FIXTURE}")
