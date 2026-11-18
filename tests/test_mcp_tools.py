"""MCP tool functions (blockflow_mcp/), against a fake backend transport.

No FastMCP, no network, no keys, no provider calls. The catalog is the real
ledger payload from the frontend fixture (Kie key saved, PiAPI not).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from blockflow_mcp import client as mcp_client  # noqa: E402
from blockflow_mcp import references as mcp_refs  # noqa: E402
from blockflow_mcp import tools_jobs  # noqa: E402
from blockflow_mcp.tools_account import get_balances  # noqa: E402
from blockflow_mcp.tools_catalog import get_model, list_models  # noqa: E402
from blockflow_mcp.tools_generation import estimate_cost, generate, validate_generation  # noqa: E402
from blockflow_mcp.tools_jobs import cancel_job, job_status, list_jobs, wait_for_jobs  # noqa: E402
from blockflow_mcp.tools_runs import get_run, list_runs, search_prompts  # noqa: E402
from tests.mcp_fakes import BASE, FakeBackend, job  # noqa: E402

CATALOG = json.loads((ROOT / "frontend/src/lib/byok/__fixtures__/catalog.kie.json").read_text())
SECRET = "kie-SECRET-0123456789abcdef"
ESTIMATE = {"amount": 205.0, "unit": "credits", "usd_equivalent": 1.025, "basis": "5 s x 41 credits/s",
            "confidence": "listed", "source": "https://kie.ai/pricing"}
T2I = {"provider": "kie", "model": "seedream-5-pro", "mode": "text_to_image", "prompt": "a lighthouse"}


@pytest.fixture
def backend(tmp_path, monkeypatch):
    fake = FakeBackend()
    out = tmp_path / "output"
    out.mkdir()
    earlier = tmp_path / "earlier-output"
    earlier.mkdir()
    fake.on("GET", "/api/settings/output-folder", {
        "in_use": str(out), "default": str(out), "configured": None, "configured_unavailable": False,
        "previous": [{"path": str(earlier), "available": True},
                     {"path": str(tmp_path / "gone"), "available": False}],
        "picker": {"available": False, "reason": "x"}})
    fake.on("GET", "/api/providers/catalog", CATALOG)
    fake.on("POST", "/api/generation/validate", {"ok": True, "issues": []})
    fake.on("POST", "/api/generation/estimate", {"ok": True, "estimate": ESTIMATE})
    fake.on("POST", "/api/generation/submit", lambda call: (200, {"ok": True, "job": job("j1")}))
    fake.out = out
    fake.earlier = earlier
    mcp_client.set_client(fake.client())
    monkeypatch.setattr(tools_jobs, "sleep", lambda s: fake.calls.append({"method": "SLEEP", "path": s}))
    mcp_refs._imported.clear()
    yield fake
    mcp_client.set_client(None)


def submits(fake):
    return fake.bodies("/api/generation/submit")


# ------------------------------------------------------------------ catalog


def test_list_models_compact_view_and_availability(backend):
    result = list_models()
    assert result["ok"] is True
    assert result["providers"] == {"kie": {"name": "Kie", "key_saved": True},
                                   "piapi": {"name": "PiAPI", "key_saved": False}}
    seedance = next(m for m in result["models"] if m["id"] == "seedance-2")
    assert seedance["kind"] == "video" and seedance["nsfw"] is False and seedance["name"] == "Seedance 2"
    assert "text_to_video" in seedance["modes"]
    assert seedance["providers"]["kie"]["available"] is True and seedance["providers"]["kie"]["reason"] is None
    assert seedance["providers"]["piapi"]["available"] is False
    assert "PiAPI" in seedance["providers"]["piapi"]["reason"]
    assert result["count"] == len(result["models"])


def test_list_models_filters_by_mode_and_provider(backend):
    images = list_models(mode="text_to_image")["models"]
    assert images and all(m["kind"] == "image" for m in images)
    only_piapi = list_models(provider="piapi")["models"]
    assert only_piapi and all(set(m["providers"]) == {"piapi"} for m in only_piapi)


def test_list_models_rejects_unknown_mode(backend):
    result = list_models(mode="image_to_audio")
    assert result["ok"] is False and result["error"]["kind"] == "unknown_mode"
    assert "text_to_video" in result["error"]["available"]


def test_get_model_full_spec(backend):
    result = get_model("seedance-2", "kie", "image_to_video")
    assert result["ok"] is True and result["available"] is True
    assert result["model"]["name"] == "Seedance 2"
    assert result["prompt"]["requirement"] == "required"
    assert result["references"][0]["kind"] == "image" and result["references"][0]["max_count"] == 9
    assert result["frames"] == {"first_frame_required": True, "last_frame_allowed": True}
    assert result["duration"]["default"] == 5 and "720p" in result["resolutions"]["values"]
    assert "16:9" in result["aspect_ratios"]["values"]
    assert {s["key"] for s in result["settings"]} >= {"generate_audio"}
    assert result["mentions"]["image"] == "Image{n}"
    assert "ids" not in result


@pytest.mark.parametrize("args,kind", [
    (("nope", "kie", "text_to_video"), "unknown_model"),
    (("seedance-2", "nope", "text_to_video"), "unknown_provider"),
    (("seedance-2", "kie", "text_to_image"), "unsupported_mode"),
])
def test_get_model_errors_are_structured(backend, args, kind):
    result = get_model(*args)
    assert result["ok"] is False and result["error"]["kind"] == kind and result["error"]["message"]


# ------------------------------------------------------------------ estimate / validate


def test_estimate_maps_parameters_and_returns_usd(backend):
    result = estimate_cost("kie", "seedance-2", "text_to_video", prompt="a fox", duration=5, resolution="720p",
                           aspect_ratio="16:9", settings={"generate_audio": False})
    assert result == {"ok": True, "estimate": ESTIMATE, "unavailable": None, "usd": 1.025}
    [body] = backend.bodies("/api/generation/estimate")
    assert body == {"provider": "kie", "model": "seedance-2", "mode": "text_to_video", "references": [],
                    "params": {"prompt": "a fox", "duration": 5, "resolution": "720p", "aspect_ratio": "16:9",
                               "settings": {"generate_audio": False}}}
    assert "/api/generation/submit" not in backend.paths()


def test_whole_second_duration_is_sent_as_an_integer(backend):
    # The backend prices and validates whole seconds; 5.0 (as JSON clients send it) is not priceable.
    estimate_cost("kie", "seedance-2", "text_to_video", prompt="a fox", duration=5.0)
    assert json.dumps(backend.bodies("/api/generation/estimate")[0]["params"]["duration"]) == "5"
    estimate_cost("kie", "seedance-2", "text_to_video", prompt="a fox", duration=5.5)
    assert backend.bodies("/api/generation/estimate")[1]["params"]["duration"] == 5.5


def test_estimate_without_estimate_returns_reason(backend):
    unavailable = {"code": "not_priceable_request", "message": "No price for this combination."}
    backend.on("POST", "/api/generation/estimate", {"ok": True, "estimate": None, "unavailable": unavailable})
    result = estimate_cost(**T2I)
    assert result["estimate"] is None and result["unavailable"] == unavailable and result["usd"] is None


def test_validate_splits_errors_and_warnings(backend):
    issues = [{"code": "prompt_too_long", "severity": "error", "field": "params.prompt", "message": "Too long."},
              {"code": "x", "severity": "warning", "field": "", "message": "Heads up."}]
    backend.on("POST", "/api/generation/validate", {"ok": False, "issues": issues})
    result = validate_generation(**T2I)
    assert result["ok"] is True and result["valid"] is False
    assert result["errors"] == issues[:1] and result["warnings"] == issues[1:]
    assert "/api/generation/submit" not in backend.paths()


# ------------------------------------------------------------------ generate


def test_generate_without_wait_validates_estimates_then_submits_as_mcp(backend):
    result = generate(**T2I, settings={"quality": "high"}, label="Hero")
    assert result["ok"] is True and result["job_id"] == "j1" and result["status"] == "QUEUED"
    assert result["estimate_usd"] == 1.025
    paths = [p for p in backend.paths("POST")]
    assert paths == ["/api/generation/validate", "/api/generation/estimate", "/api/generation/submit"]
    [body] = submits(backend)
    assert body["source"] == "mcp" and body["label"] == "Hero"
    assert body["client_request_id"].startswith("mcp-") and len(body["client_request_id"]) > 10
    assert body["params"] == {"prompt": "a lighthouse", "settings": {"quality": "high"}}
    assert not [c for c in backend.calls if c["path"].startswith("/api/jobs")]


def test_each_generate_uses_a_fresh_client_request_id(backend):
    generate(**T2I)
    generate(**T2I)
    ids = [b["client_request_id"] for b in submits(backend)]
    assert len(set(ids)) == 2


def test_generate_with_wait_polls_until_done_and_returns_outputs(backend):
    (backend.out / "byok").mkdir()
    (backend.out / "byok" / "j1_1.png").write_bytes(b"PNG")
    done = job("j1", "COMPLETED", outputs=[{"kind": "image", "url": "https://cdn.test/a.png",
                                            "local_url": "/outputs/byok/j1_1.png"}],
               cost={"amount": 3.24, "unit": "credits", "usd_equivalent": 0.0162}, completed_at=2.0)
    backend.on_job("j1", job("j1", "RUNNING"), done)
    result = generate(**T2I, wait=True)
    assert result["ok"] is True and result["status"] == "COMPLETED" and result["timed_out"] is False
    final = result["job"]
    assert final["cost"] == {"amount": 3.24, "unit": "credits", "usd_equivalent": 0.0162}
    assert final["outputs"] == [{"kind": "image", "local": "/outputs/byok/j1_1.png",
                                 "open_url": f"{BASE}/outputs/byok/j1_1.png",
                                 "file_path": str(backend.out / "byok" / "j1_1.png"),
                                 "provider_url": "https://cdn.test/a.png"}]
    assert final["artifacts_run_id"] == "run-mcp-j1"
    assert backend.paths("GET").count("/api/jobs/j1") == 2


def test_job_output_saved_in_an_earlier_output_folder_gets_its_file_path(backend):
    """After the output folder changes, older outputs live in an earlier folder."""
    (backend.earlier / "byok").mkdir()
    (backend.earlier / "byok" / "old_1.png").write_bytes(b"PNG")
    done = job("j9", "COMPLETED", outputs=[{"kind": "image", "url": "https://cdn.test/o.png",
                                            "local_url": "/outputs/byok/old_1.png"}])
    backend.on_job("j9", done)
    out = job_status("j9")["job"]["outputs"][0]
    assert out["file_path"] == str(backend.earlier / "byok" / "old_1.png")


def test_reference_inside_an_earlier_output_folder_is_not_copied(backend):
    f = backend.earlier / "ref.png"
    f.write_bytes(b"\x89PNG" + b"0" * 32)
    from blockflow_mcp.client import get_client
    from blockflow_mcp.references import normalize_references
    refs = normalize_references(get_client(), [{"kind": "image", "path": str(f)}])
    assert refs[0]["local"] == "/outputs/ref.png"
    assert not any(c["method"] == "POST" for c in backend.calls)


def test_generate_wait_reports_provider_failure(backend):
    failed = job("j1", "FAILED", error={"kind": "content_rejected", "message": "Kie rejected the prompt."})
    backend.on_job("j1", failed)
    result = generate(**T2I, wait=True)
    assert result["ok"] is True and result["status"] == "FAILED"
    assert result["job"]["error"] == {"kind": "content_rejected", "message": "Kie rejected the prompt."}


def test_generate_wait_timeout_returns_pending_job(backend, monkeypatch):
    now = [0.0]
    monkeypatch.setattr(tools_jobs, "clock", lambda: now[0])

    def tick(seconds):
        now[0] += 5

    monkeypatch.setattr(tools_jobs, "sleep", tick)
    backend.on_job("j1", job("j1", "RUNNING"))
    result = generate(**T2I, wait=True, timeout_s=12)
    assert result["ok"] is True and result["status"] == "RUNNING" and result["timed_out"] is True
    assert "wait_for_jobs" in result["next"]
    assert "/api/jobs/j1/cancel" not in backend.paths()


def test_generate_refuses_on_validation_errors(backend):
    issue = {"code": "prompt_required", "severity": "error", "field": "params.prompt", "message": "Add a prompt."}
    backend.on("POST", "/api/generation/validate", {"ok": False, "issues": [issue]})
    result = generate(**{**T2I, "prompt": ""})
    assert result == {"ok": False, "error": {"kind": "validation", "message": "Add a prompt.", "issues": [issue]}}
    assert submits(backend) == []


def test_generate_missing_key_is_structured(backend):
    backend.on("POST", "/api/generation/submit",
               {"ok": False, "kind": "auth", "issues": [],
                "error": "No Kie API key is saved. Add your Kie key in Settings, then run again."}, status=400)
    result = generate(**T2I)
    assert result["ok"] is False and result["error"]["kind"] == "auth"
    assert "Settings" in result["error"]["message"] and result["error"]["status"] == 400


def test_generate_refuses_over_max_cost(backend):
    result = generate(**T2I, max_cost_usd=1.0)
    assert result["ok"] is False and result["error"]["kind"] == "over_budget"
    assert result["error"]["usd"] == 1.025 and "1.0250" in result["error"]["message"]
    assert submits(backend) == []
    assert generate(**T2I, max_cost_usd=1.03)["ok"] is True


def test_usd_unit_estimate_counts_as_usd(backend):
    backend.on("POST", "/api/generation/estimate",
               {"ok": True, "estimate": {"amount": 0.5, "unit": "usd", "usd_equivalent": None}})
    assert generate(**T2I, max_cost_usd=0.4)["error"]["kind"] == "over_budget"
    assert generate(**T2I, max_cost_usd=0.6)["ok"] is True


@pytest.mark.parametrize("estimate_reply", [
    {"ok": True, "estimate": None, "unavailable": {"code": "not_priceable_request", "message": "No price."}},
    {"ok": True, "estimate": {"amount": 4, "unit": "credits", "usd_equivalent": None}},
])
def test_unknown_cost_refused_unless_allowed(backend, estimate_reply):
    backend.on("POST", "/api/generation/estimate", estimate_reply)
    refused = generate(**T2I)
    assert refused["ok"] is False and refused["error"]["kind"] == "unknown_cost"
    assert "allow_unknown_cost" in refused["error"]["message"]
    assert submits(backend) == []
    refused_capped = generate(**T2I, max_cost_usd=10)
    assert refused_capped["error"]["kind"] == "unknown_cost"
    allowed = generate(**T2I, allow_unknown_cost=True, max_cost_usd=10)
    assert allowed["ok"] is True and allowed["estimate_usd"] is None
    assert len(submits(backend)) == 1


@pytest.mark.parametrize("bad", [-1, "1", True])
def test_invalid_max_cost(backend, bad):
    assert generate(**T2I, max_cost_usd=bad)["error"]["kind"] == "invalid_max_cost"
    assert backend.calls == []


def test_keys_in_settings_are_refused_and_never_echoed(backend):
    result = generate(**T2I, settings={"api_key": SECRET})
    assert result["ok"] is False and result["error"]["kind"] == "key_in_request"
    assert SECRET not in json.dumps(result)
    assert backend.calls == []


def test_no_key_ever_appears_in_tool_output(backend):
    leaky = job("j1", "COMPLETED", request={"params": {"prompt": "p"}, "api_key": SECRET,
                                            "provider_request": {"headers": {"Authorization": f"Bearer {SECRET}"}}})
    backend.on_job("j1", leaky)
    backend.on("GET", "/api/providers/balances", {"ok": True, "balances": [{"provider": "kie", "api_key": SECRET}]})
    backend.on("GET", "/api/jobs", {"ok": True, "jobs": [leaky]})
    outputs = [job_status("j1"), get_balances(), list_jobs(), generate(**T2I, wait=True)]
    for out in outputs:
        assert SECRET not in json.dumps(out)


def test_backend_not_running_is_structured(backend):
    backend.on("GET", "/api/providers/catalog", ConnectionRefusedError("refused"))
    result = list_models()
    assert result["ok"] is False and result["error"]["kind"] == "backend_unreachable"
    assert BASE in result["error"]["message"] and "uv run app.py" in result["error"]["message"]


# ------------------------------------------------------------------ references


def _png(path: Path) -> Path:
    path.write_bytes(b"\x89PNG\r\n\x1a\nDATA")
    return path


def test_reference_outside_output_folder_is_copied_in_once(backend, tmp_path):
    src = _png(tmp_path / "my photo (1).png")
    backend.on("POST", "/api/blocks/upload_image_to_tmpfiles/save-local",
               {"ok": True, "image_url": "/outputs/20261115_my_photo_1_.png"})
    refs = [{"kind": "image", "path": str(src)}]
    estimate_cost(**{**T2I, "mode": "image_to_image", "model": "seedream-5-flash"}, references=refs)
    generate(**{**T2I, "mode": "image_to_image", "model": "seedream-5-flash"}, references=refs)
    uploads = [c for c in backend.calls if c["path"].endswith("/save-local")]
    assert len(uploads) == 1
    assert uploads[0]["body"] == src.read_bytes()
    assert uploads[0]["headers"]["X-Filename"] == "my_photo_1_.png"
    assert submits(backend)[0]["references"] == [
        {"kind": "image", "role": "reference", "local": "/outputs/20261115_my_photo_1_.png"}]


def test_reference_inside_output_folder_is_not_copied(backend):
    (backend.out / "sub").mkdir()
    inside = _png(backend.out / "sub" / "x.png")
    generate(**T2I, references=[{"kind": "image", "path": str(inside), "role": "first_frame"}])
    assert not [c for c in backend.calls if c["path"].endswith("/save-local")]
    assert submits(backend)[0]["references"] == [{"kind": "image", "role": "first_frame",
                                                  "local": "/outputs/sub/x.png"}]


def test_video_and_audio_use_the_video_loader_route_and_voice_is_audio(backend, tmp_path):
    backend.on("POST", "/api/blocks/video_loader/save-local",
               lambda call: (200, {"ok": True, "video_url": "/outputs/" + call["headers"]["X-Filename"]}))
    clip, song, voice = tmp_path / "c.mp4", tmp_path / "s.mp3", tmp_path / "v.wav"
    for p in (clip, song, voice):
        p.write_bytes(b"data")
    generate(**{**T2I, "mode": "omni_reference_to_video"}, references=[
        {"kind": "video", "path": str(clip)}, {"kind": "audio", "path": str(song)},
        {"kind": "voice", "path": str(voice), "name": "Anna"}, {"kind": "image", "url": "https://img.test/a.png"},
        {"kind": "image", "path": "/outputs/already.png"}])
    assert submits(backend)[0]["references"] == [
        {"kind": "video", "role": "reference", "local": "/outputs/c.mp4"},
        {"kind": "audio", "role": "reference", "local": "/outputs/s.mp3"},
        {"kind": "audio", "role": "reference", "local": "/outputs/v.wav"},
        {"kind": "image", "role": "reference", "url": "https://img.test/a.png"},
        {"kind": "image", "role": "reference", "local": "/outputs/already.png"},
    ]


@pytest.mark.parametrize("ref,kind", [
    ({"kind": "image", "path": "/outputs/../../etc/passwd"}, "unsafe_path"),
    ({"kind": "image", "path": "/outputs/a/../../b.png"}, "unsafe_path"),
    ({"kind": "image", "path": "relative/x.png"}, "invalid_path"),
    ({"kind": "image", "path": "/definitely/not/here.png"}, "missing_file"),
    ({"kind": "image", "url": "file:///etc/passwd"}, "invalid_url"),
    ({"kind": "image", "url": "ftp://x/y.png"}, "invalid_url"),
    ({"kind": "image", "path": "/x.png", "url": "https://x/y.png"}, "invalid_reference"),
    ({"kind": "sound", "url": "https://x/y.mp3"}, "invalid_reference"),
    ({"kind": "image", "url": "https://x/y.png", "role": "middle_frame"}, "invalid_reference"),
    ({"kind": "image"}, "invalid_reference"),
    ("x", "invalid_reference"),
])
def test_bad_references_are_refused_before_any_backend_call(backend, ref, kind):
    result = generate(**T2I, references=[ref])
    assert result["ok"] is False and result["error"]["kind"] == kind
    assert result["error"]["field"] == "references[0]"
    assert submits(backend) == [] and not [c for c in backend.calls if c["path"].endswith("/save-local")]


def test_wrong_type_directory_empty_and_oversize_files(backend, tmp_path, monkeypatch):
    text = tmp_path / "notes.txt"
    text.write_text("hello")
    assert generate(**T2I, references=[{"kind": "image", "path": str(text)}])["error"]["kind"] == "wrong_type"
    video_as_image = tmp_path / "clip.mp4"
    video_as_image.write_bytes(b"x")
    assert generate(**T2I, references=[{"kind": "image", "path": str(video_as_image)}])["error"]["kind"] == "wrong_type"
    assert generate(**T2I, references=[{"kind": "image", "path": str(tmp_path)}])["error"]["kind"] == "missing_file"
    empty = tmp_path / "empty.png"
    empty.write_bytes(b"")
    assert generate(**T2I, references=[{"kind": "image", "path": str(empty)}])["error"]["kind"] == "empty_file"
    monkeypatch.setitem(mcp_refs.MAX_BYTES, "image", 4)
    big = _png(tmp_path / "big.png")
    assert generate(**T2I, references=[{"kind": "image", "path": str(big)}])["error"]["kind"] == "too_large"
    assert submits(backend) == []


def test_symlink_into_output_folder_resolves_to_its_target(backend, tmp_path):
    target = _png(backend.out / "t.png")
    link = tmp_path / "link.png"
    link.symlink_to(target)
    generate(**T2I, references=[{"kind": "image", "path": str(link)}])
    assert submits(backend)[0]["references"][0]["local"] == "/outputs/t.png"


# ------------------------------------------------------------------ jobs


def test_job_status_and_not_found(backend):
    backend.on_job("j1", job("j1", "RUNNING", progress=0.4))
    result = job_status("j1")
    assert result["ok"] is True and result["job"]["status"] == "RUNNING" and result["job"]["progress"] == 0.4
    assert "request" not in result["job"] and result["job"]["prompt"] == "a lighthouse"
    missing = job_status("nope")
    assert missing["ok"] is False and missing["error"]["kind"] == "not_found"


def test_wait_for_jobs_collects_all(backend):
    backend.on_job("a", job("a", "RUNNING"), job("a", "COMPLETED"))
    backend.on_job("b", job("b", "FAILED", error={"kind": "timeout", "message": "Gave up."}))
    result = wait_for_jobs(["a", "b", "a"])
    assert [j["job_id"] for j in result["jobs"]] == ["a", "b"]
    assert [j["status"] for j in result["jobs"]] == ["COMPLETED", "FAILED"]
    assert result["pending"] == [] and result["timed_out"] is False
    assert backend.paths("GET").count("/api/jobs/b") == 1


def test_wait_for_jobs_validates_input(backend):
    assert wait_for_jobs([])["error"]["kind"] == "invalid_job_ids"
    assert wait_for_jobs(["a"], timeout_s=-1)["error"]["kind"] == "invalid_timeout"


def test_cancel_job_says_the_provider_may_still_bill(backend):
    backend.on("POST", "/api/jobs/j1/cancel", {"ok": True, "job": job("j1", "CANCELLED", remote_job_id="task-1")})
    result = cancel_job("j1")
    assert result["ok"] is True and result["job"]["status"] == "CANCELLED"
    assert "may still finish and bill" in result["note"]
    backend.on("POST", "/api/jobs/j2/cancel", {"ok": True, "job": job("j2", "CANCELLED")})
    assert "nothing was billed" in cancel_job("j2")["note"]
    assert cancel_job("zzz")["error"]["kind"] == "not_found"


def test_list_jobs_maps_filters(backend):
    backend.on("GET", "/api/jobs", {"ok": True, "jobs": [job("a"), job("b", source="pipeline")]})
    result = list_jobs(status="completed", source="mcp", limit=900)
    assert result["count"] == 2 and [j["job_id"] for j in result["jobs"]] == ["a", "b"]
    assert backend.calls[-1]["query"] == {"status": "COMPLETED", "source": "mcp", "limit": "500"}
    assert list_jobs(status="DONE")["error"]["kind"] == "invalid_status"
    assert list_jobs(source="web")["error"]["kind"] == "invalid_source"


def test_get_balances_pass_through(backend):
    balances = [{"provider": "kie", "label": "Kie", "configured": True, "status": "ok", "amount": 51.98,
                 "unit": "credits", "usd_equivalent": 0.2599}]
    backend.on("GET", "/api/providers/balances", {"ok": True, "balances": balances})
    assert get_balances() == {"ok": True, "balances": balances}
    get_balances(refresh=True)
    assert backend.calls[-1]["query"] == {"refresh": "1"}


# ------------------------------------------------------------------ runs


def _byok_run(run_id, prompt, *, writer=None):
    blocks = [{"type": "textToImage", "config": {"provider": "kie", "model": "seedream-5-pro", "prompt": prompt}},
              {"type": "imageViewer"}]
    if writer:
        blocks.insert(0, {"type": "promptWriter", "config": {"user_prompt": writer}})
    ref = {"kind": "image-ref", "local": f"/outputs/byok/{run_id}.png", "url": "https://cdn.test/x.png",
           "meta": {"job_id": "j", "provider": "kie", "model": "seedream-5-pro", "cost": None}}
    return {"id": run_id, "name": run_id, "status": "completed", "created_at": "2026-11-15T13:00:00.000Z",
            "favorited": False, "flow_snapshot": {"schema_version": 5, "blocks": blocks},
            "block_results": [{"block_index": 1, "block_type": "imageViewer", "status": "completed",
                               "outputs": {"image": {"kind": "image", "value": ref}}}]}


def test_list_runs_summaries_and_filters(backend):
    backend.on("GET", "/api/runs", {"ok": True, "total": 7, "runs": [_byok_run("run-mcp-j1", "A Flash photo")]})
    result = list_runs(limit=5, source="mcp", media_kind="image", query="flash", favorited=True)
    assert backend.calls[-1]["query"] == {"limit": "5", "offset": "0", "source": "mcp", "media_kind": "image",
                                          "q": "flash", "favorited": "true"}
    [run] = result["runs"]
    assert result["total"] == 7
    assert run["source"] == "mcp" and run["prompts"] == ["A Flash photo"]
    assert run["media"] == [{"kind": "image", "local": "/outputs/byok/run-mcp-j1.png",
                             "url": "https://cdn.test/x.png", "job_id": "j", "cost": None}]
    assert list_runs(source="web")["error"]["kind"] == "invalid_source"


def test_get_run_and_not_found(backend):
    backend.on("GET", "/api/runs/r1", {"ok": True, "run": _byok_run("r1", "cat")})
    result = get_run("r1")
    assert result["run"]["run_id"] == "r1" and result["run"]["flow_snapshot"]["schema_version"] == 5
    assert get_run("r2")["error"]["kind"] == "not_found"


def test_search_prompts_finds_byok_and_legacy_prompts(backend):
    legacy = {"id": "old", "created_at": "2026-06-27T10:00:00", "flow_snapshot": {"blocks": []},
              "block_results": [{"outputs": {"image": {"kind": "image", "value": ["/outputs/o.png"]},
                                             "metadata": {"kind": "metadata", "value": [{"prompt": "Flash legacy"}]}}}]}
    backend.on("GET", "/api/runs", {"ok": True, "total": 2,
                                    "runs": [_byok_run("r1", "harsh FLASH photo", writer="flash idea"), legacy]})
    result = search_prompts("flash", limit=10, source="pipeline")
    assert backend.calls[-1]["query"]["q"] == "flash" and backend.calls[-1]["query"]["source"] == "pipeline"
    assert [(r["prompt"], r["run_id"], r["url"]) for r in result["results"]] == [
        ("flash idea", "r1", "/outputs/byok/r1.png"),
        ("harsh FLASH photo", "r1", "/outputs/byok/r1.png"),
        ("Flash legacy", "old", "/outputs/o.png"),
    ]
    assert result["count"] == 3


def test_search_prompts_empty_query_lists_recent(backend):
    backend.on("GET", "/api/runs", {"ok": True, "total": 1, "runs": [_byok_run("r1", "anything")]})
    result = search_prompts("")
    assert "q" not in backend.calls[-1]["query"]
    assert [r["prompt"] for r in result["results"]] == ["anything"]


def test_unreachable_message_points_at_the_clone_not_npm():
    from blockflow_mcp.client import unreachable_message

    text = unreachable_message("http://127.0.0.1:47301", ConnectionRefusedError())
    assert "uv run app.py" in text and "BLOCKFLOW_URL" in text
    assert "npx" not in text and "npm" not in text
