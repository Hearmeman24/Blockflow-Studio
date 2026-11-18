"""Generation orchestration: backend/byok/service.py.

Provider network calls are faked at the adapter boundary (``Scripted``
subclasses keep the real, pure ``build_request``) or at the HTTP transport
(real adapters + ``FakeTransport``). Output downloads are faked through
``service.open_url``. No real network, no real keys.
"""

from __future__ import annotations

import io
import json
import logging
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import (  # noqa: E402
    db,
    job_store,
    output_folder,  # noqa: E402
    settings_store,
)
from backend.byok import service  # noqa: E402
from backend.byok.errors import ERROR_KINDS, ErrorInfo, ProviderError  # noqa: E402
from backend.byok.http import HttpResponse, RetryPolicy  # noqa: E402
from backend.byok.providers import ADAPTERS, Output, PollResult, SubmitResult, get_adapter  # noqa: E402

KIE_KEY = "kie-SECRET-0123456789abcdef"
PI_KEY = "piapi-SECRET-fedcba9876543210"
WAIT = 10.0


# ------------------------------------------------------------------ fakes


class FakeDownloads:
    """service.open_url replacement: url -> (content_type, bytes) | Exception."""

    def __init__(self):
        self.files: dict[str, Any] = {}
        self.calls: list[str] = []

    def __call__(self, url, timeout):
        self.calls.append(url)
        item = self.files.get(url)
        if item is None:
            raise OSError(f"no fake download for {url}")
        if isinstance(item, BaseException):
            raise item
        ctype, data = item
        return _Resp(ctype, data)


class _Resp(io.BytesIO):
    def __init__(self, ctype, data):
        super().__init__(data)
        self.status = 200
        self.headers = {"Content-Type": ctype} if ctype else {}


@dataclass
class Script:
    submit: Any = None
    polls: list[Any] = field(default_factory=list)
    upload: Any = "https://uploads.test/ref.png"
    on_submit: Any = None
    on_poll: Any = None
    on_upload: Any = None
    submits: list[Any] = field(default_factory=list)
    poll_calls: list[Any] = field(default_factory=list)
    uploads: list[Any] = field(default_factory=list)
    keys_seen: list[str] = field(default_factory=list)


def _emit(item):
    if isinstance(item, BaseException):
        raise item
    if callable(item):
        return item()
    return item


def scripted(provider: str, script: Script):
    base = ADAPTERS[provider]

    class Scripted(base):  # type: ignore[misc, valid-type]
        def submit(self, request, api_key):
            script.submits.append(request)
            script.keys_seen.append(api_key)
            if script.on_submit:
                script.on_submit(request)
            return _emit(script.submit if script.submit is not None else SubmitResult("remote-1"))

        def poll(self, remote_job_id, api_key, expected_kind=None):
            script.poll_calls.append(remote_job_id)
            script.keys_seen.append(api_key)
            if script.on_poll:
                script.on_poll(len(script.poll_calls))
            item = script.polls.pop(0) if len(script.polls) > 1 else script.polls[0]
            return _emit(item)

        def upload_file(self, path, api_key):
            script.uploads.append(Path(path))
            script.keys_seen.append(api_key)
            if script.on_upload:
                script.on_upload(Path(path))
            return _emit(script.upload)

    return Scripted()


class FakeTransport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "headers": dict(headers), "body": body})
        item = self.responses.pop(0)
        if isinstance(item, BaseException):
            raise item
        if isinstance(item, HttpResponse):
            return item
        return HttpResponse(200, json.dumps(item).encode())


FAST = RetryPolicy(max_attempts=3, base_delay_s=0, sleep=lambda s: None)


class Gate:
    """A poll that blocks until released; ``polled`` is set once polling began."""

    def __init__(self):
        self.polled = threading.Event()
        self.release = threading.Event()

    def __call__(self):
        self.polled.set()
        self.release.wait(WAIT)
        return running()


def running(progress=None, remote="generating"):
    return PollResult("RUNNING", remote, progress)


def done(*outputs, remote="success"):
    return PollResult("COMPLETED", remote, 1.0, tuple(Output(k, u) for k, u in outputs))


def failed(kind, message):
    return PollResult("FAILED", "fail", None, (), ErrorInfo(kind, message, False, None, None, "kie"))


def video_payload(**overrides):
    payload = {"provider": "kie", "model": "wan-3.0", "mode": "text_to_video", "params": {"prompt": "a fox"}}
    payload.update(overrides)
    return payload


def image_payload(**overrides):
    payload = {"provider": "kie", "model": "seedream-5-pro", "mode": "text_to_image",
               "params": {"prompt": "a lighthouse"}}
    payload.update(overrides)
    return payload


# ------------------------------------------------------------------ fixtures


@dataclass
class Env:
    out: Path
    db_path: Path
    downloads: FakeDownloads
    scripts: dict[str, Script]
    monkeypatch: Any

    @property
    def store(self):
        return job_store.get_store()

    def use_transport(self, provider, transport):
        self.monkeypatch.setattr(service, "adapter_factory",
                                 lambda p, **kw: get_adapter(p, transport=transport, retry=FAST))


@pytest.fixture
def env(tmp_path, monkeypatch):
    db_path = tmp_path / "run_history.db"
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    settings_store.set_credential("kie_api_key", KIE_KEY)
    settings_store.set_credential("piapi_api_key", PI_KEY)
    out = tmp_path / "output"
    out.mkdir()
    monkeypatch.setattr(output_folder, "_state", output_folder.pinned_state(out))
    for name in ("POLL_INITIAL_S", "POLL_MAX_S", "CANCEL_CHECK_S"):
        monkeypatch.setattr(service, name, 0)
    monkeypatch.setattr(service, "sleep", lambda s: None)
    downloads = FakeDownloads()
    monkeypatch.setattr(service, "open_url", downloads)

    def no_fallback(path):
        raise AssertionError("fallback uploader must not be used")

    monkeypatch.setattr(service, "fallback_uploader", no_fallback)
    scripts = {"kie": Script(polls=[done(("video", "https://cdn.test/out.mp4"))]),
               "piapi": Script(polls=[done(("video", "https://cdn.test/out.mp4"))])}
    monkeypatch.setattr(service, "adapter_factory", lambda p, **kw: scripted(p, scripts[p]))
    yield Env(out, db_path, downloads, scripts, monkeypatch)
    service.shutdown()


def finish(job):
    result = service.wait_for_job(job["job_id"], timeout=WAIT)
    assert result is not None
    return result


# ================================================================== happy paths


def test_video_happy_path_with_real_kie_adapter_writes_file(env):
    transport = FakeTransport(
        {"code": 200, "msg": "success", "data": {"taskId": "task_v1"}},
        {"code": 200, "data": {"taskId": "task_v1", "state": "generating", "progress": 40}},
        {"code": 200, "data": {"taskId": "task_v1", "state": "success",
                               "resultJson": json.dumps({"resultUrls": ["https://cdn.test/fox.mp4"]})}},
    )
    env.use_transport("kie", transport)
    env.downloads.files["https://cdn.test/fox.mp4"] = ("video/mp4", b"MP4DATA")

    job = service.submit_generation(video_payload())
    assert job["status"] in ("QUEUED", "RUNNING")
    assert job["provider"] == "kie" and job["model"] == "wan-3.0" and job["mode"] == "text_to_video"
    final = finish(job)

    assert final["status"] == "COMPLETED", final
    assert final["remote_job_id"] == "task_v1"
    assert final["error"] is None
    [out] = final["outputs"]
    assert out["kind"] == "video" and out["url"] == "https://cdn.test/fox.mp4"
    assert out["local_url"].startswith("/outputs/byok/") and out["local_url"].endswith(".mp4")
    path = env.out / "byok" / out["local_url"].rsplit("/", 1)[1]
    assert path.read_bytes() == b"MP4DATA"
    creates = [c for c in transport.calls if c["url"].endswith("/createTask")]
    assert len(creates) == 1
    assert json.loads(creates[0]["body"]) == {"model": "wan/3-0-video",
                                              "input": json.loads(creates[0]["body"])["input"]}
    assert json.loads(creates[0]["body"])["input"]["prompt"] == "a fox"
    assert final["request"]["params"]["prompt"] == "a fox"
    assert final["request"]["provider_request"]["body"]["model"] == "wan/3-0-video"


def test_image_happy_path_two_outputs_unique_files(env):
    env.scripts["kie"].polls = [running(0.2), done(("image", "https://cdn.test/a.png"),
                                                   ("image", "https://cdn.test/b?id=2"))]
    env.downloads.files["https://cdn.test/a.png"] = ("image/png", b"PNG-A")
    env.downloads.files["https://cdn.test/b?id=2"] = ("image/jpeg", b"JPG-B")

    final = finish(service.submit_generation(image_payload()))

    assert final["status"] == "COMPLETED"
    assert [o["url"] for o in final["outputs"]] == ["https://cdn.test/a.png", "https://cdn.test/b?id=2"]
    names = [o["local_url"].rsplit("/", 1)[1] for o in final["outputs"]]
    assert len(set(names)) == 2
    assert names[0].endswith(".png") and names[1].endswith(".jpg")
    assert (env.out / "byok" / names[0]).read_bytes() == b"PNG-A"
    assert (env.out / "byok" / names[1]).read_bytes() == b"JPG-B"
    assert all(o["kind"] == "image" for o in final["outputs"])
    assert not list((env.out / "byok").glob("*.part"))


def test_sync_result_at_submit_with_real_piapi_adapter_never_polls(env):
    transport = FakeTransport({"code": 200, "message": "success", "data": {
        "task_id": "pi-sync", "status": "Completed",
        "output": {"image_url": "https://img.test/a.jpeg", "image_urls": ["https://img.test/a.jpeg"]},
        "error": {"code": 0, "message": "", "raw_message": ""}}})
    env.use_transport("piapi", transport)
    env.downloads.files["https://img.test/a.jpeg"] = ("image/jpeg", b"JPEG")

    final = finish(service.submit_generation(
        {"provider": "piapi", "model": "seedream-5-lite", "mode": "text_to_image", "params": {"prompt": "a cat"}}))

    assert final["status"] == "COMPLETED", final
    assert final["remote_job_id"] == "pi-sync"
    assert [c["method"] for c in transport.calls] == ["POST"]
    local = final["outputs"][0]["local_url"]
    assert (env.out / "byok" / local.rsplit("/", 1)[1]).read_bytes() == b"JPEG"


def test_sync_failure_at_submit_fails_job(env):
    env.scripts["kie"].submit = SubmitResult("r-9", failed("content_rejected", "Kie rejected the content."))
    final = finish(service.submit_generation(image_payload()))
    assert final["status"] == "FAILED"
    assert final["error"]["kind"] == "content_rejected"
    assert env.scripts["kie"].poll_calls == []


def test_progress_is_normalised_and_persisted(env):
    seen = []
    env.scripts["kie"].polls = [running(0.5), done(("video", "https://cdn.test/out.mp4"))]

    def on_poll(n):
        if n == 2:
            seen.append(env.store.list_jobs(limit=1)[0]["progress"])

    env.scripts["kie"].on_poll = on_poll
    env.downloads.files["https://cdn.test/out.mp4"] = ("video/mp4", b"x")
    final = finish(service.submit_generation(video_payload()))
    assert seen == [0.5]
    assert final["progress"] == 1.0


def test_unicode_prompt_passes_through_unchanged(env):
    prompt = "一只狐狸 🦊 in the café — «snow»"
    transport = FakeTransport(
        {"code": 200, "msg": "success", "data": {"taskId": "t-u"}},
        {"code": 200, "data": {"state": "success",
                               "resultJson": json.dumps({"resultUrls": ["https://cdn.test/u.mp4"]})}},
    )
    env.use_transport("kie", transport)
    env.downloads.files["https://cdn.test/u.mp4"] = ("video/mp4", b"u")
    final = finish(service.submit_generation(video_payload(params={"prompt": prompt})))
    assert final["status"] == "COMPLETED"
    assert json.loads(transport.calls[0]["body"].decode("utf-8"))["input"]["prompt"] == prompt
    assert env.store.get_job(final["job_id"])["request"]["params"]["prompt"] == prompt


def test_source_mcp_is_recorded(env):
    env.downloads.files["https://cdn.test/out.mp4"] = ("video/mp4", b"x")
    final = finish(service.submit_generation(video_payload(source="mcp")))
    assert final["source"] == "mcp"


# ================================================================== references


def test_local_reference_is_uploaded_and_uploaded_url_sent(env):
    (env.out / "in.png").write_bytes(b"IN")
    transport = FakeTransport(
        {"code": 200, "msg": "ok", "data": {"downloadUrl": "https://kie-up.test/in.png"}},
        {"code": 200, "msg": "success", "data": {"taskId": "t-i2v"}},
        {"code": 200, "data": {"state": "success",
                               "resultJson": json.dumps({"resultUrls": ["https://cdn.test/i2v.mp4"]})}},
    )
    env.use_transport("kie", transport)
    env.downloads.files["https://cdn.test/i2v.mp4"] = ("video/mp4", b"V")

    final = finish(service.submit_generation(video_payload(
        mode="image_to_video",
        references=[{"kind": "image", "local": "/outputs/in.png", "role": "first_frame",
                     "url": "https://expired.test/in.png"}])))

    assert final["status"] == "COMPLETED", final
    upload, create = transport.calls[0], transport.calls[1]
    assert upload["url"].endswith("/api/file-stream-upload") and b"IN" in upload["body"]
    assert json.loads(create["body"])["input"]["first_frame_url"] == "https://kie-up.test/in.png"
    # the job keeps the references as given; nothing dropped
    assert final["request"]["references"] == [{"kind": "image", "local": "/outputs/in.png",
                                               "role": "first_frame", "url": "https://expired.test/in.png"}]


def test_remote_reference_is_passed_through_without_upload(env):
    env.downloads.files["https://cdn.test/out.mp4"] = ("video/mp4", b"x")
    final = finish(service.submit_generation(video_payload(
        mode="image_to_video",
        references=[{"kind": "image", "url": "https://public.test/frame.png", "role": "first_frame"}])))
    assert final["status"] == "COMPLETED"
    script = env.scripts["kie"]
    assert script.uploads == []
    assert script.submits[0].body["input"]["first_frame_url"] == "https://public.test/frame.png"


def test_provider_upload_unavailable_falls_back_to_tmpfiles(env):
    (env.out / "ref.png").write_bytes(b"R")
    env.scripts["piapi"].upload = ProviderError("unsupported", "PiAPI upload needs a paid plan.",
                                                provider="piapi", provider_code="plan_required")
    env.scripts["piapi"].polls = [done(("image", "https://cdn.test/o.png"))]
    env.downloads.files["https://cdn.test/o.png"] = ("image/png", b"o")
    fallback_calls = []

    def fallback(path):
        fallback_calls.append(Path(path))
        return "https://tmpfiles.test/dl/1/ref.png"

    env.monkeypatch.setattr(service, "fallback_uploader", fallback)
    settings_store.set_app_pref("asset_storage_mode", "tmpfiles")
    final = finish(service.submit_generation(
        {"provider": "piapi", "model": "seedream-5-lite", "mode": "image_to_image",
         "params": {"prompt": "make it blue"}, "references": [{"kind": "image", "local": "/outputs/ref.png"}]}))
    assert final["status"] == "COMPLETED", final
    assert fallback_calls == [(env.out / "ref.png").resolve()]
    assert "https://tmpfiles.test/dl/1/ref.png" in json.dumps(env.scripts["piapi"].submits[0].body)


# ------------------------------------------------------------------ storage mode x provider upload failures

_PI_SYNC_DONE = {"code": 200, "message": "success", "data": {
    "task_id": "pi-up", "status": "Completed",
    "output": {"image_url": "https://img.test/o.jpeg", "image_urls": ["https://img.test/o.jpeg"]},
    "error": {"code": 0, "message": "", "raw_message": ""}}}


def _upload_case(env, case):
    """Write the reference for ``case`` and return (local value, upload responses, reason text)."""
    if case == "plan_403":
        (env.out / "ref.png").write_bytes(b"R")
        return ("/outputs/ref.png",
                [HttpResponse(403, json.dumps({"code": 403, "message": "Insufficient plan level"}).encode())],
                "creator plan")
    if case == "oversized":
        (env.out / "big.png").write_bytes(b"\0" * 10_000_001)
        return "/outputs/big.png", [], "10 mb"
    (env.out / "anim.gif").write_bytes(b"GIF89a")
    return "/outputs/anim.gif", [], ".gif"


def _pi_i2i(local):
    return {"provider": "piapi", "model": "seedream-5-lite", "mode": "image_to_image",
            "params": {"prompt": "make it blue"}, "references": [{"kind": "image", "local": local}]}


class Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, path):
        self.calls.append(Path(path))
        return "https://tmpfiles.test/dl/9/ref"


CASES = ["plan_403", "oversized", "unsupported_type"]


@pytest.mark.parametrize("case", CASES)
@pytest.mark.parametrize("mode", [None, "local_only", "bucket", ""])
def test_local_only_storage_never_falls_back(env, case, mode):
    if mode is not None:
        settings_store.set_app_pref("asset_storage_mode", mode)
    local, upload_responses, reason = _upload_case(env, case)
    transport = FakeTransport(*upload_responses)
    env.use_transport("piapi", transport)
    fallback = Recorder()
    env.monkeypatch.setattr(service, "fallback_uploader", fallback)

    final = finish(service.submit_generation(_pi_i2i(local)))

    assert final["status"] == "FAILED", final
    assert final["error"]["kind"] == "unsupported"
    assert fallback.calls == []
    # nothing but (at most) the provider's own upload was attempted; never a submit
    assert all("ephemeral_resource" in c["url"] for c in transport.calls)
    assert final["remote_job_id"] is None
    msg = final["error"]["message"]
    assert reason in msg.lower()
    assert Path(local).name in msg
    assert "local only" in msg.lower()
    assert '"tmpfiles"' in msg and "Settings" in msg
    assert "provider or plan that accepts" in msg
    assert PI_KEY not in json.dumps(final)


@pytest.mark.parametrize("case", CASES)
def test_tmpfiles_storage_falls_back_after_provider_upload_failure(env, case):
    settings_store.set_app_pref("asset_storage_mode", "tmpfiles")
    local, upload_responses, _ = _upload_case(env, case)
    transport = FakeTransport(*upload_responses, _PI_SYNC_DONE)
    env.use_transport("piapi", transport)
    env.downloads.files["https://img.test/o.jpeg"] = ("image/jpeg", b"J")
    fallback = Recorder()
    env.monkeypatch.setattr(service, "fallback_uploader", fallback)

    final = finish(service.submit_generation(_pi_i2i(local)))

    assert final["status"] == "COMPLETED", final
    assert fallback.calls == [references_path(env, local)]
    submit = transport.calls[-1]
    assert submit["url"].endswith("/api/v1/task")
    assert "https://tmpfiles.test/dl/9/ref" in submit["body"].decode("utf-8")


def references_path(env, local):
    return (env.out / Path(local).name).resolve()


def test_local_only_still_uses_the_provider_upload_when_it_works(env):
    settings_store.set_app_pref("asset_storage_mode", "local_only")
    (env.out / "ref.png").write_bytes(b"R")
    env.scripts["piapi"].upload = "https://piapi-up.test/ref.png"
    env.scripts["piapi"].polls = [done(("image", "https://cdn.test/o.png"))]
    env.downloads.files["https://cdn.test/o.png"] = ("image/png", b"o")
    fallback = Recorder()
    env.monkeypatch.setattr(service, "fallback_uploader", fallback)
    final = finish(service.submit_generation(_pi_i2i("/outputs/ref.png")))
    assert final["status"] == "COMPLETED"
    assert fallback.calls == []
    assert "https://piapi-up.test/ref.png" in json.dumps(env.scripts["piapi"].submits[0].body)


@pytest.mark.parametrize("value,expected", [(None, "local_only"), ("local_only", "local_only"),
                                            ("tmpfiles", "tmpfiles"), ("bucket", "local_only"),
                                            ("TMPFILES", "local_only")])
def test_storage_mode_reads_the_app_pref(env, value, expected):
    if value is not None:
        settings_store.set_app_pref("asset_storage_mode", value)
    assert service.storage_mode() == expected


def test_many_references_are_never_truncated(env):
    refs = [{"kind": "image", "url": f"https://public.test/{i}.png"} for i in range(30)]
    with pytest.raises(service.GenerationError) as exc:
        service.submit_generation({"provider": "kie", "model": "seedance-2", "mode": "omni_reference_to_video",
                                   "params": {"prompt": "a long enough prompt for seedance"},
                                   "references": refs})
    issue = next(i for i in exc.value.issues if i["code"] == "too_many_references")
    assert issue["actual"] == 30
    assert env.store.list_jobs() == []


@pytest.mark.parametrize("ref,code", [
    ({"kind": "image", "local": "/outputs/../../etc/passwd", "role": "first_frame"}, "reference_path_unsafe"),
    ({"kind": "image", "local": "/etc/passwd", "role": "first_frame"}, "reference_path_unsafe"),
    ({"kind": "image", "url": "/outputs/../secret.png", "role": "first_frame"}, "reference_path_unsafe"),
    ({"kind": "image", "local": "/outputs/missing.png", "role": "first_frame"}, "reference_missing_local"),
])
def test_unsafe_or_missing_local_reference_blocks_submit(env, ref, code):
    with pytest.raises(service.GenerationError) as exc:
        service.submit_generation(video_payload(mode="image_to_video", references=[ref]))
    assert exc.value.kind == "validation"
    assert code in [i["code"] for i in exc.value.issues]
    assert env.store.list_jobs() == []
    assert env.scripts["kie"].submits == [] and env.scripts["kie"].uploads == []


def test_missing_local_with_remote_url_uses_remote(env):
    env.downloads.files["https://cdn.test/out.mp4"] = ("video/mp4", b"x")
    final = finish(service.submit_generation(video_payload(
        mode="image_to_video",
        references=[{"kind": "image", "local": "/outputs/gone.png", "url": "https://public.test/f.png",
                     "role": "first_frame"}])))
    assert final["status"] == "COMPLETED"
    assert env.scripts["kie"].submits[0].body["input"]["first_frame_url"] == "https://public.test/f.png"


# ================================================================== keys and validation


@pytest.mark.parametrize("value", [None, "", "   "])
def test_missing_key_is_a_clear_error_and_creates_no_job(env, value):
    if value is None:
        settings_store.delete_credential("kie_api_key")
    else:
        settings_store.set_credential("kie_api_key", value)
    with pytest.raises(service.GenerationError) as exc:
        service.submit_generation(video_payload())
    assert exc.value.kind == "auth"
    assert "Kie" in exc.value.message and "Settings" in exc.value.message
    assert env.store.list_jobs() == []
    assert env.scripts["kie"].submits == []


def test_key_in_request_body_is_refused_and_never_used(env):
    body = video_payload(api_key="sk-from-body-123456")
    with pytest.raises(service.GenerationError) as exc:
        service.submit_generation(body)
    assert exc.value.kind == "validation"
    assert "key_in_request" in [i["code"] for i in exc.value.issues]
    assert "sk-from-body-123456" not in json.dumps(exc.value.issues)
    assert env.store.list_jobs() == []


def test_validation_issues_returned_in_full_and_no_job(env):
    with pytest.raises(service.GenerationError) as exc:
        service.submit_generation(video_payload(params={"prompt": "", "duration": 999, "bogus": 1}))
    codes = [i["code"] for i in exc.value.issues]
    assert "prompt_required" in codes and "unknown_parameter" in codes and len(codes) >= 3
    assert all(set(i) >= {"code", "severity", "field", "message"} for i in exc.value.issues)
    assert env.store.list_jobs() == []
    assert env.scripts["kie"].submits == []


@pytest.mark.parametrize("payload,code", [
    ("not a dict", "invalid_payload"),
    ({"model": "wan-3.0", "mode": "text_to_video"}, "missing_field"),
    (video_payload(params="nope"), "invalid_parameter"),
    (video_payload(references={"kind": "image"}), "invalid_reference"),
    (video_payload(references=["x"]), "invalid_reference"),
    (video_payload(source="cron"), "invalid_source"),
    (video_payload(client_request_id=""), "invalid_client_request_id"),
    (video_payload(client_request_id="x" * 300), "invalid_client_request_id"),
    (video_payload(provider="openai"), "unknown_provider"),
    (video_payload(model="nope"), "unknown_model"),
])
def test_malformed_payloads(env, payload, code):
    issues = service.validate_generation(payload)
    assert code in [i["code"] for i in issues]
    with pytest.raises(service.GenerationError) as exc:
        service.submit_generation(payload)
    assert exc.value.kind == "validation"
    assert env.store.list_jobs() == []


def test_validate_generation_ok_returns_only_warnings(env):
    issues = service.validate_generation(video_payload())
    assert [i for i in issues if i["severity"] == "error"] == []


# ================================================================== failures


@pytest.mark.parametrize("kind", ERROR_KINDS)
def test_every_submit_error_kind_maps_to_job_error(env, kind):
    env.scripts["kie"].submit = ProviderError(kind, f"Kie said {kind} for key {KIE_KEY}", provider="kie")
    final = finish(service.submit_generation(video_payload()))
    assert final["status"] == "FAILED"
    assert final["error"]["kind"] == kind
    assert final["error"]["message"]
    assert KIE_KEY not in json.dumps(final)
    assert final["message"] == final["error"]["message"]
    assert env.scripts["kie"].poll_calls == []


@pytest.mark.parametrize("kind,hint", [
    ("auth", "Settings"), ("insufficient_credits", "credits"), ("rate_limited", "Wait"),
    ("network", "connection"), ("content_rejected", "prompt"),
])
def test_error_messages_are_actionable(env, kind, hint):
    env.scripts["kie"].submit = ProviderError(kind, "x", provider="kie")
    final = finish(service.submit_generation(video_payload()))
    assert hint.lower() in final["error"]["message"].lower()


def test_ambiguous_submit_failure_warns_the_task_may_exist(env):
    env.scripts["kie"].submit = ProviderError("timeout", "Kie did not respond in time.", provider="kie")
    final = finish(service.submit_generation(video_payload()))
    assert final["status"] == "FAILED"
    assert "dashboard" in final["error"]["message"].lower()


def test_remote_failure_result_maps_to_job_error(env):
    env.scripts["kie"].polls = [running(), failed("content_rejected", "Kie rejected the content of this request.")]
    final = finish(service.submit_generation(video_payload()))
    assert final["status"] == "FAILED"
    assert final["error"]["kind"] == "content_rejected"
    assert final["remote_job_id"] == "remote-1"


def test_non_retryable_poll_error_fails(env):
    env.scripts["kie"].polls = [ProviderError("auth", "The Kie API key was rejected.", provider="kie")]
    final = finish(service.submit_generation(video_payload()))
    assert final["status"] == "FAILED" and final["error"]["kind"] == "auth"
    assert len(env.scripts["kie"].poll_calls) == 1


def test_malformed_poll_response_real_adapter(env):
    transport = FakeTransport({"code": 200, "msg": "success", "data": {"taskId": "t-m"}},
                              HttpResponse(200, b"<html>not json</html>"))
    env.use_transport("kie", transport)
    final = finish(service.submit_generation(video_payload()))
    assert final["status"] == "FAILED"
    assert final["error"]["kind"] == "malformed_response"


def test_repeated_retryable_malformed_poll_eventually_fails(env):
    env.monkeypatch.setattr(service, "MAX_POLL_ERRORS", 3)
    env.scripts["kie"].polls = [ProviderError("malformed_response", "Kie returned an unknown task state.",
                                              provider="kie", retryable=True)]
    final = finish(service.submit_generation(video_payload()))
    assert final["status"] == "FAILED" and final["error"]["kind"] == "malformed_response"
    assert len(env.scripts["kie"].poll_calls) == 3
    assert len(env.scripts["kie"].submits) == 1


def test_submit_called_once_even_when_polls_fail_transiently(env):
    net = ProviderError("network", "Could not reach the provider.", provider="kie")
    env.scripts["kie"].polls = [net, net, running(), done(("video", "https://cdn.test/out.mp4"))]
    env.downloads.files["https://cdn.test/out.mp4"] = ("video/mp4", b"x")
    final = finish(service.submit_generation(video_payload()))
    assert final["status"] == "COMPLETED"
    assert len(env.scripts["kie"].submits) == 1
    assert len(env.scripts["kie"].poll_calls) == 4


def test_timeout_marks_timed_out(env):
    ticks = iter(range(0, 10_000, 100))
    env.monkeypatch.setattr(service, "clock", lambda: float(next(ticks)))
    env.monkeypatch.setattr(service, "JOB_TIMEOUT_S", 250)
    env.scripts["kie"].polls = [running()]
    final = finish(service.submit_generation(video_payload()))
    assert final["status"] == "TIMED_OUT"
    assert final["error"]["kind"] == "timeout"
    assert "bill" in final["error"]["message"].lower()
    assert final["remote_job_id"] == "remote-1"
    assert 1 <= len(env.scripts["kie"].poll_calls) <= 5


def test_unexpected_exception_is_generic_and_logged_scrubbed(env, caplog):
    caplog.set_level(logging.DEBUG)
    env.scripts["kie"].submit = RuntimeError(f"boom with {KIE_KEY} inside")
    final = finish(service.submit_generation(video_payload()))
    assert final["status"] == "FAILED"
    assert final["error"]["kind"] == "provider_failure"
    assert "boom" not in final["error"]["message"]
    assert "boom" in caplog.text
    assert KIE_KEY not in caplog.text


# ================================================================== downloads


def test_download_failure_keeps_remote_url_and_completes_with_warning(env):
    env.scripts["kie"].polls = [done(("image", "https://cdn.test/a.png"), ("image", "https://cdn.test/b.png"))]
    env.downloads.files["https://cdn.test/a.png"] = ("image/png", b"A")
    env.downloads.files["https://cdn.test/b.png"] = OSError("connection reset")
    final = finish(service.submit_generation(image_payload()))
    assert final["status"] == "COMPLETED"
    assert final["error"] is None
    a, b = final["outputs"]
    assert "local_url" in a and (env.out / "byok" / a["local_url"].rsplit("/", 1)[1]).read_bytes() == b"A"
    assert b == {"kind": "image", "url": "https://cdn.test/b.png"}
    assert "could not be saved" in final["message"].lower()
    assert not list((env.out / "byok").glob("*.part"))


def test_download_extension_falls_back_to_url_then_kind(env):
    env.scripts["kie"].polls = [done(("video", "https://cdn.test/clip.webm?sig=1"), ("video", "https://cdn.test/x"))]
    env.downloads.files["https://cdn.test/clip.webm?sig=1"] = ("application/octet-stream", b"W")
    env.downloads.files["https://cdn.test/x"] = (None, b"X")
    final = finish(service.submit_generation(video_payload()))
    names = [o["local_url"].rsplit("/", 1)[1] for o in final["outputs"]]
    assert names[0].endswith(".webm") and names[1].endswith(".mp4")


def test_unknown_output_kind_uses_model_output_kind(env):
    env.scripts["kie"].polls = [done(("unknown", "https://cdn.test/o"))]
    env.downloads.files["https://cdn.test/o"] = ("image/webp", b"W")
    final = finish(service.submit_generation(image_payload()))
    assert final["outputs"][0]["kind"] == "image"
    assert final["outputs"][0]["local_url"].endswith(".webp")


def test_download_size_cap(env):
    env.monkeypatch.setattr(service, "DOWNLOAD_MAX_BYTES", 4)
    env.scripts["kie"].polls = [done(("image", "https://cdn.test/big.png"))]
    env.downloads.files["https://cdn.test/big.png"] = ("image/png", b"0123456789")
    final = finish(service.submit_generation(image_payload()))
    assert final["status"] == "COMPLETED"
    assert "local_url" not in final["outputs"][0]
    assert not (env.out / "byok").exists() or not any((env.out / "byok").iterdir())


# ================================================================== cancellation


def _cancel_latest(env):
    job = env.store.list_jobs(limit=1)[0]
    env.store.request_cancel(job["job_id"])


def test_cancel_before_submit(env):
    (env.out / "in.png").write_bytes(b"IN")
    env.scripts["kie"].on_upload = lambda path: _cancel_latest(env)
    final = finish(service.submit_generation(video_payload(
        mode="image_to_video", references=[{"kind": "image", "local": "/outputs/in.png", "role": "first_frame"}])))
    assert final["status"] == "CANCELLED"
    assert env.scripts["kie"].submits == []
    assert final["remote_job_id"] is None
    assert "not sent" in final["message"].lower()


def test_cancel_during_polling_stops_and_warns_about_billing(env):
    env.scripts["kie"].polls = [running()]
    env.scripts["kie"].on_poll = lambda n: _cancel_latest(env) if n == 2 else None
    final = finish(service.submit_generation(video_payload()))
    assert final["status"] == "CANCELLED"
    assert len(env.scripts["kie"].poll_calls) == 2
    assert final["remote_job_id"] == "remote-1"
    msg = final["message"].lower()
    assert "may still" in msg and "bill" in msg
    assert env.downloads.calls == []


def test_cancel_while_submit_in_flight_records_remote_task(env):
    env.scripts["kie"].on_submit = lambda request: _cancel_latest(env)
    final = finish(service.submit_generation(video_payload()))
    assert final["status"] == "CANCELLED"
    assert final["remote_job_id"] == "remote-1"
    assert len(env.scripts["kie"].submits) == 1
    assert env.scripts["kie"].poll_calls == []
    assert "bill" in final["message"].lower()


def test_cancel_after_completion_is_a_no_op(env):
    env.downloads.files["https://cdn.test/out.mp4"] = ("video/mp4", b"x")
    final = finish(service.submit_generation(video_payload()))
    assert final["status"] == "COMPLETED"
    after = env.store.request_cancel(final["job_id"])
    assert after["status"] == "COMPLETED"
    assert after["outputs"] == final["outputs"]


def test_cancel_while_waiting_between_polls(env):
    env.monkeypatch.setattr(service, "POLL_INITIAL_S", 5)
    env.monkeypatch.setattr(service, "POLL_MAX_S", 5)
    env.monkeypatch.setattr(service, "CANCEL_CHECK_S", 1)
    slept = []

    def fake_sleep(seconds):
        slept.append(seconds)
        if len(slept) == 2:
            _cancel_latest(env)

    env.monkeypatch.setattr(service, "sleep", fake_sleep)
    env.scripts["kie"].polls = [running()]
    final = finish(service.submit_generation(video_payload()))
    assert final["status"] == "CANCELLED"
    assert len(env.scripts["kie"].poll_calls) == 1
    assert len(slept) == 2 and all(s <= 1 for s in slept)


# ================================================================== idempotency and concurrency


def test_duplicate_client_request_id_returns_same_active_job(env):
    gate = Gate()
    env.scripts["kie"].polls = [gate]
    first = service.submit_generation(video_payload(client_request_id="click-1"))
    second = service.submit_generation(video_payload(client_request_id="click-1"))
    assert second["job_id"] == first["job_id"]
    assert len(env.store.list_jobs()) == 1
    assert gate.polled.wait(WAIT)
    env.store.request_cancel(first["job_id"])
    gate.release.set()
    finish(first)
    assert len(env.scripts["kie"].submits) == 1


def test_client_request_id_reused_after_completion_creates_new_job(env):
    env.downloads.files["https://cdn.test/out.mp4"] = ("video/mp4", b"x")
    a = finish(service.submit_generation(video_payload(client_request_id="click-2")))
    b = finish(service.submit_generation(video_payload(client_request_id="click-2")))
    assert a["job_id"] != b["job_id"]
    assert len(env.scripts["kie"].submits) == 2


def test_client_request_id_reused_for_different_request_conflicts(env):
    gate = Gate()
    env.scripts["kie"].polls = [gate]
    first = service.submit_generation(video_payload(client_request_id="click-3"))
    with pytest.raises(service.GenerationError) as exc:
        service.submit_generation(image_payload(client_request_id="click-3"))
    assert exc.value.kind == "conflict"
    assert gate.polled.wait(WAIT)
    env.store.request_cancel(first["job_id"])
    gate.release.set()
    finish(first)


def test_concurrent_duplicate_submissions_submit_once(env):
    gate = Gate()
    env.scripts["kie"].polls = [gate]
    results, barrier = [], threading.Barrier(8)

    def go():
        barrier.wait()
        results.append(service.submit_generation(video_payload(client_request_id="dbl")))

    threads = [threading.Thread(target=go) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(WAIT)
    assert len({r["job_id"] for r in results}) == 1
    assert gate.polled.wait(WAIT)
    env.store.request_cancel(results[0]["job_id"])
    gate.release.set()
    finish(results[0])
    assert len(env.scripts["kie"].submits) == 1


def test_concurrent_distinct_submissions_all_complete(env):
    counter = iter(range(100))
    lock = threading.Lock()

    def next_submit():
        with lock:
            n = next(counter)
        return SubmitResult(f"remote-{n}")

    env.scripts["kie"].submit = next_submit
    env.scripts["kie"].polls = [done(("image", "https://cdn.test/same.png"))]
    env.downloads.files["https://cdn.test/same.png"] = ("image/png", b"S")
    jobs, errors = [], []

    def go(i):
        try:
            jobs.append(service.submit_generation(image_payload(params={"prompt": f"prompt number {i}"})))
        except Exception as exc:  # pragma: no cover - surfaced below
            errors.append(exc)

    threads = [threading.Thread(target=go, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(WAIT)
    assert errors == []
    finals = [finish(j) for j in jobs]
    assert all(f["status"] == "COMPLETED" for f in finals)
    assert len({f["remote_job_id"] for f in finals}) == 8
    files = list((env.out / "byok").iterdir())
    assert len(files) == 8 and all(f.read_bytes() == b"S" for f in files)


# ================================================================== resume


def test_resume_after_restart_polls_without_resubmitting(env):
    store = env.store
    job = store.create_job(source="pipeline", provider="kie", model="wan-3.0", mode="text_to_video",
                           request={"params": {"prompt": "a fox"}})
    store.update_job(job["job_id"], status="RUNNING", remote_job_id="remote-77")
    stranded = store.create_job(source="pipeline", provider="kie", model="wan-3.0", mode="text_to_video")
    env.scripts["kie"].polls = [running(), done(("video", "https://cdn.test/r.mp4"))]
    env.downloads.files["https://cdn.test/r.mp4"] = ("video/mp4", b"R")

    summary = service.resume_pending()

    assert summary["resumed"] == [job["job_id"]]
    assert summary["failed"] == [stranded["job_id"]]
    final = service.wait_for_job(job["job_id"], timeout=WAIT)
    assert final["status"] == "COMPLETED"
    assert env.scripts["kie"].submits == []
    assert set(env.scripts["kie"].poll_calls) == {"remote-77"}
    assert store.get_job(stranded["job_id"])["status"] == "FAILED"


def test_resume_is_idempotent_while_attached(env):
    gate = Gate()
    store = env.store
    job = store.create_job(source="pipeline", provider="kie", model="wan-3.0", mode="text_to_video")
    store.update_job(job["job_id"], status="RUNNING", remote_job_id="remote-88")
    env.scripts["kie"].polls = [gate]
    assert service.resume_pending()["resumed"] == [job["job_id"]]
    assert service.resume_pending()["resumed"] == []
    assert gate.polled.wait(WAIT)
    store.request_cancel(job["job_id"])
    gate.release.set()
    service.wait_for_job(job["job_id"], timeout=WAIT)


def test_resume_without_key_fails_with_auth(env):
    store = env.store
    job = store.create_job(source="pipeline", provider="kie", model="wan-3.0", mode="text_to_video")
    store.update_job(job["job_id"], status="RUNNING", remote_job_id="remote-99")
    settings_store.delete_credential("kie_api_key")
    service.resume_pending()
    final = store.get_job(job["job_id"])
    assert final["status"] == "FAILED" and final["error"]["kind"] == "auth"
    assert "remote-99" in final["error"]["message"]


# ================================================================== secrets


def test_api_key_never_reaches_job_db_or_logs(env, caplog, capsys):
    caplog.set_level(logging.DEBUG)
    (env.out / "in.png").write_bytes(b"IN")
    env.scripts["kie"].polls = [ProviderError("network", f"flaky {KIE_KEY}", provider="kie"),
                                done(("video", "https://cdn.test/out.mp4"))]
    env.downloads.files["https://cdn.test/out.mp4"] = ("video/mp4", b"x")
    final = finish(service.submit_generation(video_payload(
        mode="image_to_video", references=[{"kind": "image", "local": "/outputs/in.png", "role": "first_frame"}])))
    env.scripts["kie"].submit = ProviderError("auth", f"bad key {KIE_KEY}", provider="kie")
    failed_job = finish(service.submit_generation(video_payload()))

    assert final["status"] == "COMPLETED" and failed_job["status"] == "FAILED"
    assert set(env.scripts["kie"].keys_seen) == {KIE_KEY}  # the stored key was what the adapter got
    for snapshot in (final, failed_job, *env.store.list_jobs()):
        assert KIE_KEY not in json.dumps(snapshot)
    # The key lives in the settings table of the same file; no job row may hold it.
    assert _no_job_row_has_key(env.db_path)
    assert KIE_KEY not in caplog.text
    assert KIE_KEY not in capsys.readouterr().out


def _no_job_row_has_key(db_path: Path) -> bool:
    import sqlite3

    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(f"SELECT data FROM {job_store.TABLE}").fetchall()
    finally:
        conn.close()
    return all(KIE_KEY not in r[0] for r in rows)


def test_service_uses_only_public_job_store_api():
    import re

    source = Path(service.__file__).read_text(encoding="utf-8")
    assert not re.search(r"\bstore\._", source)
    assert "_mutate" not in source


# ================================================================== label (MCP run name)


def test_label_is_stored_on_the_request_record(env):
    job = service.submit_generation(image_payload(source="mcp", label="  Hero shots  "))
    assert job["source"] == "mcp"
    assert job["request"]["label"] == "Hero shots"
    finish(job)


def test_no_label_leaves_request_record_unchanged(env):
    job = service.submit_generation(image_payload())
    assert "label" not in job["request"]
    finish(job)


@pytest.mark.parametrize("label", ["", "   ", 5, "x" * 201, ["a"]])
def test_invalid_label_is_a_validation_issue(env, label):
    issues = service.validate_generation(image_payload(label=label))
    assert [i["code"] for i in issues if i["severity"] == "error"] == ["invalid_label"]


# ================================================================== job phase (in memory only)


def _latest_id(env) -> str:
    return env.store.list_jobs(limit=1)[0]["job_id"]


def test_phase_follows_the_worker_and_is_never_stored(env):
    seen: list[tuple[str, Any]] = []
    env.store.subscribe_callback(
        lambda e: seen.append((e["job"]["message"], service.with_phase(e["job"]).get("phase"))))
    env.scripts["kie"].on_submit = lambda request: seen.append(("submit", service.job_phase(_latest_id(env))))
    env.scripts["kie"].on_poll = lambda n: seen.append(("poll", service.job_phase(_latest_id(env))))
    real_open = env.downloads

    def downloading(url, timeout):
        seen.append(("download", service.job_phase(_latest_id(env))))
        return real_open(url, timeout)

    env.monkeypatch.setattr(service, "open_url", downloading)
    env.downloads.files["https://cdn.test/out.mp4"] = ("video/mp4", b"x")

    job = service.submit_generation(video_payload())
    final = finish(job)

    assert final["status"] == "COMPLETED"
    assert seen[1:] == [("Preparing references", "preparing"), ("Sending to Kie", "submitting"),
                        ("submit", "submitting"), ("Waiting for Kie", "polling"), ("poll", "polling"),
                        ("download", "downloading"), ("Done", None)]
    assert service.job_phase(job["job_id"]) is None
    assert "phase" not in service.with_phase(final)
    import sqlite3

    raw = sqlite3.connect(env.db_path).execute(f"SELECT data FROM {job_store.TABLE}").fetchone()[0]
    assert "phase" not in json.loads(raw)


def test_phase_is_cleared_when_a_job_fails_or_is_cancelled(env):
    env.scripts["kie"].polls = [failed("provider_failure", "boom")]
    failed_job = finish(service.submit_generation(video_payload()))
    assert failed_job["status"] == "FAILED" and service.job_phase(failed_job["job_id"]) is None

    env.scripts["kie"].polls = [running()]
    env.scripts["kie"].on_poll = lambda n: _cancel_latest(env)
    cancelled = finish(service.submit_generation(video_payload()))
    assert cancelled["status"] == "CANCELLED" and service.job_phase(cancelled["job_id"]) is None
    assert "phase" not in service.with_phase(cancelled)


def test_a_job_resumed_after_a_restart_reports_polling(env):
    gate = Gate()
    store = env.store
    job = store.create_job(source="pipeline", provider="kie", model="wan-3.0", mode="text_to_video")
    store.update_job(job["job_id"], status="RUNNING", remote_job_id="remote-55")
    assert "phase" not in service.with_phase(store.get_job(job["job_id"]))  # no worker yet
    env.scripts["kie"].polls = [gate]
    assert service.resume_pending()["resumed"] == [job["job_id"]]
    assert gate.polled.wait(WAIT)
    assert service.with_phase(store.get_job(job["job_id"]))["phase"] == "polling"
    store.request_cancel(job["job_id"])
    gate.release.set()
    service.wait_for_job(job["job_id"], timeout=WAIT)
    assert service.job_phase(job["job_id"]) is None


def test_a_submitted_job_starts_in_the_preparing_phase(env):
    gate = threading.Event()
    env.scripts["kie"].on_upload = lambda path: gate.wait(WAIT)
    (env.out / "in.png").write_bytes(b"IN")
    job = service.submit_generation(video_payload(
        mode="image_to_video", references=[{"kind": "image", "local": "/outputs/in.png", "role": "first_frame"}]))
    assert service.with_phase(job)["phase"] == "preparing"
    gate.set()
    finish(job)


def test_with_phase_never_mutates_its_argument_and_hides_terminal_jobs(env):
    job = {"job_id": "x", "status": "COMPLETED"}
    service._set_phase("x", service.JobPhase.DOWNLOADING)
    try:
        assert service.with_phase(job) == {"job_id": "x", "status": "COMPLETED"}
        active = {"job_id": "x", "status": "RUNNING"}
        assert service.with_phase(active) == {"job_id": "x", "status": "RUNNING", "phase": "downloading"}
        assert active == {"job_id": "x", "status": "RUNNING"}
    finally:
        service._clear_phase("x")


# ================================================================== a finished task's charge is never dropped


def _kie_success_without_urls(env, credits):
    transport = FakeTransport(
        {"code": 200, "msg": "success", "data": {"taskId": "t-nourl"}},
        {"code": 200, "data": {"taskId": "t-nourl", "state": "success", "resultJson": "",
                               "creditsConsumed": credits}},
    )
    env.use_transport("kie", transport)
    return transport


def test_kie_success_without_urls_fails_but_keeps_the_reported_cost(env):
    _kie_success_without_urls(env, 24)
    final = finish(service.submit_generation(video_payload()))
    assert final["status"] == "FAILED"
    assert final["error"]["kind"] == "malformed_response"
    expected = service.error_message("malformed_response", "Kie reported success but returned no result URLs.",
                                     "kie")
    assert final["error"]["message"] == expected == final["message"]
    assert final["cost"] == {"amount": 24.0, "unit": "credits", "usd_equivalent": 0.12}
    assert final["price_check"] is None
    assert final["remote_job_id"] == "t-nourl" and final["outputs"] == []


def test_piapi_success_without_output_fails_but_keeps_the_reported_cost(env):
    usage = {"type": "point", "frozen": 0, "consume": 600000}
    transport = FakeTransport(
        {"code": 200, "message": "success", "data": {"task_id": "pi-nourl", "status": "pending"}},
        {"code": 200, "message": "success", "data": {"task_id": "pi-nourl", "status": "completed",
                                                     "output": {}, "meta": {"usage": usage}}},
    )
    env.use_transport("piapi", transport)
    final = finish(service.submit_generation(
        {"provider": "piapi", "model": "seedream-5-lite", "mode": "text_to_image", "params": {"prompt": "a cat"}}))
    assert final["status"] == "FAILED" and final["error"]["kind"] == "malformed_response"
    expected = service.error_message("malformed_response", "PiAPI reported success but returned no output URL.",
                                     "piapi")
    assert final["error"]["message"] == expected
    assert final["cost"] == {"amount": 600000.0, "unit": "points", "usd_equivalent": 0.06}
    assert final["remote_job_id"] == "pi-nourl"


# ================================================================== PiAPI immediate result keeps its task id


_PI_SYNC_BAD = {"code": 200, "message": "success", "data": {
    "task_id": "pi-sync-bad", "status": "Completed", "output": {"image_urls": []},
    "meta": {"usage": {"type": "point", "frozen": 0, "consume": 300000}},
    "error": {"code": 0, "message": "", "raw_message": ""}}}
_PI_IMAGE = {"provider": "piapi", "model": "seedream-5-lite", "mode": "text_to_image", "params": {"prompt": "a cat"}}


def test_piapi_unreadable_immediate_result_records_the_task_and_fails_as_before(env):
    transport = FakeTransport(_PI_SYNC_BAD)
    env.use_transport("piapi", transport)
    final = finish(service.submit_generation(_PI_IMAGE))
    assert final["status"] == "FAILED"
    assert final["remote_job_id"] == "pi-sync-bad"
    assert final["error"]["kind"] == "malformed_response"
    expected = service.error_message("malformed_response", "PiAPI reported success but returned no output URL.",
                                     "piapi")
    expected += (" PiAPI may have accepted the request anyway; check your PiAPI dashboard before running it "
                 "again so you are not billed twice.")
    assert final["error"]["message"] == expected == final["message"]
    assert final["cost"] == {"amount": 300000.0, "unit": "points", "usd_equivalent": 0.03}
    assert [c["method"] for c in transport.calls] == ["POST"]  # never polled, never resubmitted


def test_piapi_unreadable_immediate_result_after_a_cancel_keeps_the_task_id(env):
    calls = []

    def transport(method, url, headers, body, timeout):
        calls.append(method)
        _cancel_latest(env)
        return HttpResponse(200, json.dumps(_PI_SYNC_BAD).encode())

    env.use_transport("piapi", transport)
    final = finish(service.submit_generation(_PI_IMAGE))
    assert final["status"] == "CANCELLED"
    assert final["remote_job_id"] == "pi-sync-bad"
    assert "bill" in final["message"].lower()
    assert calls == ["POST"]


# ================================================================== cancel while the outputs download


def _done_with_cost(*urls):
    from backend.byok.providers.base import Cost

    return PollResult("COMPLETED", "success", 1.0, tuple(Output("image", u) for u in urls), None, None,
                      Cost(30.0, "credits", 0.15))


def _saved_files(env) -> list[Path]:
    folder = env.out / "byok"
    return sorted(folder.iterdir()) if folder.exists() else []


def _learned(env) -> list[Any]:
    from backend.byok import learned_prices

    calls: list[Any] = []
    env.monkeypatch.setattr(learned_prices, "learn", lambda *a: calls.append(a) or None)
    return calls


def _assert_cancelled_after_provider_finished(final):
    assert final["status"] == "CANCELLED"
    assert final["outputs"] == []
    assert final["remote_job_id"] == "remote-1"
    assert final["cost"] == {"amount": 30.0, "unit": "credits", "usd_equivalent": 0.15}
    assert final["price_check"] is None
    msg = final["message"].lower()
    assert "already finished" in msg and "charged" in msg and "remote-1" in final["message"]


def test_cancel_after_the_provider_finished_downloads_nothing(env):
    learned = _learned(env)
    env.scripts["kie"].polls = [_done_with_cost("https://cdn.test/a.png")]
    env.scripts["kie"].on_poll = lambda n: _cancel_latest(env)
    env.downloads.files["https://cdn.test/a.png"] = ("image/png", b"A")
    final = finish(service.submit_generation(image_payload()))
    _assert_cancelled_after_provider_finished(final)
    assert env.downloads.calls == []
    assert _saved_files(env) == []
    assert len(learned) == 1  # the provider's charge for a finished task is still a price observation


def test_cancel_during_the_download_of_several_outputs_leaves_no_files(env):
    learned = _learned(env)
    env.scripts["kie"].polls = [_done_with_cost("https://cdn.test/a.png", "https://cdn.test/b.png")]
    env.downloads.files["https://cdn.test/a.png"] = ("image/png", b"A")
    env.downloads.files["https://cdn.test/b.png"] = ("image/png", b"B")
    real_open = env.downloads

    def cancel_on_first(url, timeout):
        if len(real_open.calls) == 0:
            _cancel_latest(env)
        return real_open(url, timeout)

    env.monkeypatch.setattr(service, "open_url", cancel_on_first)
    final = finish(service.submit_generation(image_payload()))
    _assert_cancelled_after_provider_finished(final)
    assert real_open.calls == ["https://cdn.test/a.png"]  # stopped before the second output
    assert _saved_files(env) == []
    assert len(learned) == 1


def test_cancel_that_lands_just_before_the_completed_update_removes_the_files(env):
    """The last check is the COMPLETED update itself: if the store refuses it
    because the job is already CANCELLED, every file this job saved is removed."""
    learned = _learned(env)
    env.scripts["kie"].polls = [_done_with_cost("https://cdn.test/a.png")]
    env.downloads.files["https://cdn.test/a.png"] = ("image/png", b"A")
    real_update = job_store.JobStore.update_job

    def cancel_then_update(self, job_id, /, **fields):
        if fields.get("status") == "COMPLETED":
            self.request_cancel(job_id)
        return real_update(self, job_id, **fields)

    env.monkeypatch.setattr(job_store.JobStore, "update_job", cancel_then_update)
    keep = env.out / "byok" / "someone-elses.png"
    keep.parent.mkdir(parents=True, exist_ok=True)
    keep.write_bytes(b"KEEP")
    final = finish(service.submit_generation(image_payload()))
    _assert_cancelled_after_provider_finished(final)
    assert env.downloads.calls == ["https://cdn.test/a.png"]
    assert _saved_files(env) == [keep]
    assert len(learned) == 1


# ================================================================== state machine leftovers


def test_a_cancel_during_a_poll_retry_backoff_stops_retrying(env):
    """The poll's own HTTP retry sleeps in slices and stops as soon as the job
    is cancelled; the job then ends CANCELLED with the billing warning."""
    slept: list[float] = []

    def sleep(seconds):
        slept.append(seconds)
        _cancel_latest(env)

    transport = FakeTransport({"code": 200, "msg": "success", "data": {"taskId": "t-b"}},
                              {"code": 429, "msg": "slow down"}, {"code": 429, "msg": "slow down"},
                              {"code": 200, "data": {"state": "generating"}})
    policy = RetryPolicy(max_attempts=3, base_delay_s=1.0, sleep=sleep)
    env.monkeypatch.setattr(service, "adapter_factory",
                            lambda p, **kw: get_adapter(p, transport=transport, retry=policy))
    final = finish(service.submit_generation(video_payload()))
    assert final["status"] == "CANCELLED"
    assert final["remote_job_id"] == "t-b"
    assert "may still" in final["message"].lower()
    assert [c["method"] for c in transport.calls] == ["POST", "GET"]  # no second poll attempt
    assert len(slept) == 1 and slept[0] <= 0.5


def test_duplicate_client_request_id_is_found_beyond_one_list_page(env):
    env.monkeypatch.setattr(job_store, "MAX_LIST_LIMIT", 2)
    store = env.store
    oldest = store.create_job(source="pipeline", provider="kie", model="wan-3.0", mode="text_to_video",
                              request={"params": {"prompt": "a fox"}, "client_request_id": "deep-1"})
    for n in range(3):
        store.create_job(source="pipeline", provider="kie", model="wan-3.0", mode="text_to_video",
                         request={"params": {"prompt": f"other {n}"}, "client_request_id": f"other-{n}"})
    again = service.submit_generation(video_payload(client_request_id="deep-1"))
    assert again["job_id"] == oldest["job_id"]
    assert env.scripts["kie"].submits == []


def test_finished_workers_are_pruned(env):
    env.downloads.files["https://cdn.test/out.mp4"] = ("video/mp4", b"x")
    jobs = [finish(service.submit_generation(video_payload())) for _ in range(3)]
    assert all(j["status"] == "COMPLETED" for j in jobs)
    with service._state_lock:
        assert not any(j["job_id"] in service._futures for j in jobs)
        assert not any(j["job_id"] in service._attached for j in jobs)
    # waiting on a pruned job still answers from the store
    assert service.wait_for_job(jobs[0]["job_id"], timeout=1)["status"] == "COMPLETED"


def test_a_resumed_job_measures_its_age_with_the_service_clock(env):
    """Elapsed time and the deadline come from the same clock: a job whose
    hour is already up on that clock times out after one poll."""
    store = env.store
    job = store.create_job(source="pipeline", provider="kie", model="wan-3.0", mode="text_to_video")
    store.update_job(job["job_id"], status="RUNNING", remote_job_id="remote-old")
    late = float(job["created_at"]) + service.JOB_TIMEOUT_S + 5
    env.monkeypatch.setattr(service, "clock", lambda: late)
    env.scripts["kie"].polls = [running()]
    env.scripts["kie"].on_poll = lambda n: store.request_cancel(job["job_id"]) if n >= 5 else None
    assert service.resume_pending()["resumed"] == [job["job_id"]]
    final = service.wait_for_job(job["job_id"], timeout=WAIT)
    assert final["status"] == "TIMED_OUT"
    assert len(env.scripts["kie"].poll_calls) == 1


def test_a_resumed_job_keeps_the_rest_of_its_hour(env):
    store = env.store
    job = store.create_job(source="pipeline", provider="kie", model="wan-3.0", mode="text_to_video")
    store.update_job(job["job_id"], status="RUNNING", remote_job_id="remote-young")
    start = float(job["created_at"]) + 600  # ten minutes old on the service clock
    ticks = iter(range(0, 10_000_000, 1000))
    env.monkeypatch.setattr(service, "clock", lambda: start + next(ticks))
    env.scripts["kie"].polls = [running()]
    service.resume_pending()
    final = service.wait_for_job(job["job_id"], timeout=WAIT)
    assert final["status"] == "TIMED_OUT"
    # Age 600 s read at start+0, deadline start+1000+3000; one clock read per poll after that.
    assert len(env.scripts["kie"].poll_calls) == 3
