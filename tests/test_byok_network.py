"""submit / poll / upload_file / validate_key against a fake HTTP transport."""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.byok.errors import ProviderError  # noqa: E402
from backend.byok.http import HttpResponse, RetryPolicy  # noqa: E402
from backend.byok.providers import get_adapter  # noqa: E402
from backend.byok.spec import Reference  # noqa: E402

KEY = "sk-test-FAKE-KEY-1234567890"


class FakeTransport:
    """Queue of responses (HttpResponse, dict -> JSON 200, or Exception)."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "headers": dict(headers), "body": body,
                           "timeout": timeout})
        item = self.responses.pop(0)
        if isinstance(item, BaseException):
            raise item
        if isinstance(item, HttpResponse):
            return item
        return HttpResponse(200, json.dumps(item).encode())


def resp(status, payload):
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    return HttpResponse(status, body)


SLEEPS: list[float] = []
FAST = RetryPolicy(max_attempts=3, base_delay_s=0, sleep=SLEEPS.append)


def adapter(provider, *responses):
    transport = FakeTransport(*responses)
    return get_adapter(provider, transport=transport, retry=FAST), transport


def kie_request():
    return get_adapter("kie").build_request("wan-3.0", "text_to_video", {"prompt": "a fox"}, [])


def piapi_request(model="seedance-2", mode="text_to_video", refs=()):
    return get_adapter("piapi").build_request(model, mode, {"prompt": "a fox"}, list(refs))


# =========================================================================
# Kie
# =========================================================================

def test_kie_submit_success_sends_bearer_key_and_body():
    kie, t = adapter("kie", {"code": 200, "msg": "success", "data": {"taskId": "task_abc"}})
    result = kie.submit(kie_request(), KEY)
    assert result.remote_job_id == "task_abc" and result.initial is None
    call = t.calls[0]
    assert call["method"] == "POST" and call["url"] == "https://api.kie.ai/api/v1/jobs/createTask"
    assert call["headers"]["Authorization"] == f"Bearer {KEY}"
    assert json.loads(call["body"]) == {"model": "wan/3-0-video", "input": kie_request().body["input"]}


@pytest.mark.parametrize("code,kind,retryable", [
    (401, "auth", False), (402, "insufficient_credits", False), (429, "rate_limited", True),
    (422, "validation", False), (500, "provider_failure", True), (455, "provider_failure", True),
    (501, "provider_failure", False), (505, "unsupported", False), (433, "provider_failure", False),
])
def test_kie_http_200_with_error_code(code, kind, retryable):
    kie, _ = adapter("kie", {"code": code, "msg": "something went wrong", "data": None})
    with pytest.raises(ProviderError) as exc:
        kie.submit(kie_request(), KEY)
    err = exc.value
    assert (err.kind, err.retryable, err.provider_code, err.http_status) == (kind, retryable, str(code), 200)
    assert err.provider == "kie"


def test_kie_submit_is_never_retried():
    kie, t = adapter("kie", {"code": 429, "msg": "Rate limit exceeded"}, {"code": 200, "data": {"taskId": "x"}})
    with pytest.raises(ProviderError) as exc:
        kie.submit(kie_request(), KEY)
    assert exc.value.kind == "rate_limited"
    assert len(t.calls) == 1


def test_kie_real_http_401():
    kie, _ = adapter("kie", resp(401, {"code": 401, "msg": "Unauthorized"}))
    with pytest.raises(ProviderError) as exc:
        kie.submit(kie_request(), KEY)
    assert exc.value.kind == "auth" and exc.value.http_status == 401


def test_kie_validation_content_message_is_content_rejected():
    kie, _ = adapter("kie", {"code": 422, "msg": "Prompt contains sensitive words"})
    with pytest.raises(ProviderError) as exc:
        kie.submit(kie_request(), KEY)
    assert exc.value.kind == "content_rejected"


def test_kie_html_502_page():
    kie, _ = adapter("kie", resp(502, b"<html>Bad gateway</html>"))
    with pytest.raises(ProviderError) as exc:
        kie.submit(kie_request(), KEY)
    assert (exc.value.kind, exc.value.retryable, exc.value.http_status) == ("provider_failure", True, 502)


@pytest.mark.parametrize("payload", [b"{not json", b'{"code": 200, "data": {"taskId": ', b"[]",
                                     b'{"code": 200, "data": {}}', b'{"msg": "no code"}'])
def test_kie_submit_malformed(payload):
    kie, _ = adapter("kie", resp(200, payload))
    with pytest.raises(ProviderError) as exc:
        kie.submit(kie_request(), KEY)
    assert exc.value.kind == "malformed_response"


def test_kie_submit_timeout_and_network_errors():
    kie, _ = adapter("kie", ProviderError("timeout", "The provider did not respond in time."))
    with pytest.raises(ProviderError) as exc:
        kie.submit(kie_request(), KEY)
    assert exc.value.kind == "timeout" and exc.value.provider == "kie"
    kie, t = adapter("kie", ConnectionResetError("reset"))
    with pytest.raises(ProviderError) as exc:
        kie.submit(kie_request(), KEY)
    assert exc.value.kind == "network" and len(t.calls) == 1


def test_kie_missing_key_fails_before_any_request():
    kie, t = adapter("kie")
    for key in ("", "   ", None):
        with pytest.raises(ProviderError) as exc:
            kie.submit(kie_request(), key)
        assert exc.value.kind == "auth"
    assert t.calls == []


def _kie_task(state, **extra):
    return {"code": 200, "msg": "success", "data": {"taskId": "t1", "state": state, **extra}}


@pytest.mark.parametrize("state,status", [("waiting", "QUEUED"), ("queuing", "QUEUED"),
                                          ("generating", "RUNNING")])
def test_kie_poll_in_progress_states(state, status):
    kie, t = adapter("kie", _kie_task(state, progress=45))
    result = kie.poll("t1", KEY)
    assert (result.status, result.remote_status, result.progress, result.outputs) == (status, state, 45.0, ())
    assert t.calls[0]["url"] == "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=t1"
    assert t.calls[0]["method"] == "GET"


def test_kie_poll_escapes_task_id():
    kie, t = adapter("kie", _kie_task("waiting"))
    kie.poll("a b&c", KEY)
    assert t.calls[0]["url"].endswith("taskId=a%20b%26c")


def test_kie_poll_success_with_double_encoded_result_and_param():
    result_json = json.dumps({"resultUrls": ["https://cdn.kie.test/out.mp4", "https://cdn.kie.test/out.mp4"]})
    param = json.dumps({"model": "wan/3-0-video", "input": json.dumps({"prompt": "a fox", "duration": 5})})
    kie, _ = adapter("kie", _kie_task("success", resultJson=json.dumps(result_json), param=param))
    result = kie.poll("t1", KEY)
    assert result.status == "COMPLETED"
    assert [(o.kind, o.url) for o in result.outputs] == [("video", "https://cdn.kie.test/out.mp4")]
    assert result.request_echo == {"model": "wan/3-0-video", "input": {"prompt": "a fox", "duration": 5}}


def test_kie_poll_success_single_encoded_image_uses_expected_kind_for_extensionless_urls():
    result_json = json.dumps({"resultUrls": ["https://cdn.kie.test/a.png", "https://cdn.kie.test/blob"]})
    kie, _ = adapter("kie", _kie_task("success", resultJson=result_json))
    result = kie.poll("t1", KEY, expected_kind="image")
    assert [(o.kind, o.url) for o in result.outputs] == [("image", "https://cdn.kie.test/a.png"),
                                                          ("image", "https://cdn.kie.test/blob")]


def test_kie_poll_success_falls_back_to_parsed_response():
    kie, _ = adapter("kie", _kie_task("success", resultJson="", response={"resultUrls": ["https://x.test/v.mp4"]}))
    assert kie.poll("t1", KEY).outputs[0].url == "https://x.test/v.mp4"


@pytest.mark.parametrize("result_json", ["", None, "{bad json", json.dumps({"resultUrls": []}),
                                         json.dumps({"resultObject": {}})])
def test_kie_poll_success_without_urls_is_malformed(result_json):
    kie, _ = adapter("kie", _kie_task("success", resultJson=result_json))
    with pytest.raises(ProviderError) as exc:
        kie.poll("t1", KEY)
    assert exc.value.kind == "malformed_response"


def test_kie_poll_failed_task_provider_failure():
    kie, _ = adapter("kie", _kie_task("fail", failCode="500", failMsg="internal generation error"))
    result = kie.poll("t1", KEY)
    assert result.status == "FAILED"
    assert (result.error.kind, result.error.provider_code, result.error.retryable) == ("provider_failure", "500",
                                                                                        False)
    assert "internal generation error" in result.error.message


def test_kie_poll_failed_task_content_rejection():
    kie, _ = adapter("kie", _kie_task("fail", failCode="400", failMsg="The output was flagged by moderation"))
    assert kie.poll("t1", KEY).error.kind == "content_rejected"


def test_kie_poll_unknown_state_is_malformed():
    kie, _ = adapter("kie", _kie_task("teleporting"))
    with pytest.raises(ProviderError) as exc:
        kie.poll("t1", KEY)
    assert exc.value.kind == "malformed_response"


def test_kie_poll_retries_rate_limit_and_network_then_succeeds():
    SLEEPS.clear()
    kie, t = adapter("kie", {"code": 429, "msg": "slow down"}, ConnectionResetError("reset"),
                     _kie_task("generating"))
    assert kie.poll("t1", KEY).status == "RUNNING"
    assert len(t.calls) == 3
    assert SLEEPS == [0, 0]


def test_kie_poll_retry_is_bounded():
    kie, t = adapter("kie", *[{"code": 500, "msg": "boom"}] * 5)
    with pytest.raises(ProviderError) as exc:
        kie.poll("t1", KEY)
    assert exc.value.kind == "provider_failure" and len(t.calls) == 3


def test_kie_poll_does_not_retry_auth_or_validation():
    kie, t = adapter("kie", {"code": 401, "msg": "bad key"}, _kie_task("waiting"))
    with pytest.raises(ProviderError):
        kie.poll("t1", KEY)
    assert len(t.calls) == 1
    kie, t = adapter("kie", {"code": 422, "msg": "recordInfo is null", "data": None})
    with pytest.raises(ProviderError) as exc:
        kie.poll("missing", KEY)
    assert exc.value.kind == "validation" and len(t.calls) == 1


def test_kie_poll_timeout_is_retried():
    kie, t = adapter("kie", ProviderError("network", "x", retryable=True), _kie_task("waiting"))
    assert kie.poll("t1", KEY).status == "QUEUED"
    assert len(t.calls) == 2


def test_kie_upload_file_multipart(tmp_path):
    f = tmp_path / "frame.png"
    f.write_bytes(b"\x89PNGdata")
    kie, t = adapter("kie", {"success": True, "code": 200, "msg": "File uploaded successfully",
                             "data": {"downloadUrl": "https://tempfile.redpandaai.co/x/frame.png"}})
    assert kie.upload_file(f, KEY) == "https://tempfile.redpandaai.co/x/frame.png"
    call = t.calls[0]
    assert call["url"] == "https://kieai.redpandaai.co/api/file-stream-upload"
    assert call["headers"]["Authorization"] == f"Bearer {KEY}"
    assert call["headers"]["Content-Type"].startswith("multipart/form-data; boundary=")
    assert b'name="uploadPath"' in call["body"] and b'filename="frame.png"' in call["body"]
    assert b"\x89PNGdata" in call["body"] and b"Content-Type: image/png" in call["body"]


def test_kie_upload_errors(tmp_path):
    f = tmp_path / "a.mp4"
    f.write_bytes(b"x")
    kie, _ = adapter("kie", {"success": False, "code": 401, "msg": "Unauthorized"})
    with pytest.raises(ProviderError) as exc:
        kie.upload_file(f, KEY)
    assert exc.value.kind == "auth"
    kie, _ = adapter("kie", {"success": True, "code": 200, "data": {}})
    with pytest.raises(ProviderError) as exc:
        kie.upload_file(f, KEY)
    assert exc.value.kind == "malformed_response"
    with pytest.raises(ProviderError) as exc:
        kie.upload_file(tmp_path / "missing.png", KEY)
    assert exc.value.kind == "validation"


def test_kie_validate_key():
    kie, t = adapter("kie", {"code": 200, "msg": "success", "data": 1234.5})
    status = kie.validate_key(KEY)
    assert (status.valid, status.balance, status.balance_unit) == (True, 1234.5, "credits")
    assert t.calls[0]["url"] == "https://api.kie.ai/api/v1/chat/credit"
    kie, _ = adapter("kie", {"code": 401, "msg": "Unauthorized"})
    assert kie.validate_key(KEY).valid is False
    kie, t = adapter("kie", {"code": 429, "msg": "slow"}, {"code": 200, "data": 0})
    assert kie.validate_key(KEY).balance == 0.0 and len(t.calls) == 2
    kie, _ = adapter("kie", {"code": 500, "msg": "x"}, {"code": 500, "msg": "x"}, {"code": 500, "msg": "x"})
    with pytest.raises(ProviderError):
        kie.validate_key(KEY)


# =========================================================================
# PiAPI
# =========================================================================

def _pi_task(status, output=None, error=None, **extra):
    return {"code": 200, "message": "success",
            "data": {"task_id": "pi-1", "status": status, "output": output,
                     "error": error or {"code": 0, "message": "", "raw_message": ""}, **extra}}


def test_piapi_submit_success_sends_x_api_key():
    pi, t = adapter("piapi", _pi_task("pending"))
    req = piapi_request()
    result = pi.submit(req, KEY)
    assert result.remote_job_id == "pi-1" and result.initial is None
    call = t.calls[0]
    assert call["url"] == "https://api.piapi.ai/api/v1/task"
    assert call["headers"]["x-api-key"] == KEY
    assert "Mozilla" in call["headers"]["User-Agent"]
    assert json.loads(call["body"]) == dict(req.body)


def test_piapi_synchronous_seedream_result_on_submit():
    pi, _ = adapter("piapi", _pi_task("Completed", {"image_url": "https://img.test/a.jpeg",
                                                    "image_urls": ["https://img.test/a.jpeg",
                                                                   "https://img.test/b.jpeg"]}))
    result = pi.submit(piapi_request("seedream-5-lite", "text_to_image"), KEY)
    assert result.initial.status == "COMPLETED"
    assert [o.url for o in result.initial.outputs] == ["https://img.test/a.jpeg", "https://img.test/b.jpeg"]


@pytest.mark.parametrize("status,payload,kind,retryable", [
    (401, {"code": 401, "message": "Invalid API key"}, "auth", False),
    (403, {"code": 403, "message": "forbidden"}, "auth", False),
    (402, {"code": 402, "message": "pay up"}, "insufficient_credits", False),
    (400, {"code": 400, "message": "insufficient credits in your account"}, "insufficient_credits", False),
    (429, {"code": 429, "message": "too many requests"}, "rate_limited", True),
    (400, {"code": 400, "message": "duration must be between 4 and 15"}, "validation", False),
    (400, {"code": 400, "message": "prompt rejected by content review"}, "content_rejected", False),
    (500, {"code": 500, "message": "internal"}, "provider_failure", True),
    (503, b"<html>down</html>", "provider_failure", True),
])
def test_piapi_http_errors(status, payload, kind, retryable):
    pi, t = adapter("piapi", resp(status, payload), _pi_task("pending"))
    with pytest.raises(ProviderError) as exc:
        pi.submit(piapi_request(), KEY)
    assert (exc.value.kind, exc.value.retryable, exc.value.http_status) == (kind, retryable, status)
    assert len(t.calls) == 1  # submit never retries


def test_piapi_body_error_code_10003_is_validation():
    pi, _ = adapter("piapi", {"code": 10003, "message": "unknown field enable_audio",
                              "data": {"error": {"code": 10003, "message": "unknown field enable_audio"}}})
    with pytest.raises(ProviderError) as exc:
        pi.submit(piapi_request("kling-4.0", "text_to_video"), KEY)
    assert (exc.value.kind, exc.value.provider_code) == ("validation", "10003")


@pytest.mark.parametrize("payload", [b"not json", b'{"code": 200, "data": null}', b'{"code": 200, "data": {}}',
                                     b'"string"', b'{"code": 200'])
def test_piapi_submit_malformed(payload):
    pi, _ = adapter("piapi", resp(200, payload))
    with pytest.raises(ProviderError) as exc:
        pi.submit(piapi_request(), KEY)
    assert exc.value.kind == "malformed_response"


@pytest.mark.parametrize("raw,status", [("pending", "QUEUED"), ("Pending", "QUEUED"), ("Staged", "QUEUED"),
                                        ("starting", "QUEUED"), ("processing\t", "RUNNING"),
                                        ("Processing", "RUNNING"), ("retry", "RUNNING")])
def test_piapi_poll_in_progress_states(raw, status):
    pi, t = adapter("piapi", _pi_task(raw))
    result = pi.poll("pi-1", KEY)
    assert (result.status, result.remote_status) == (status, raw)
    assert t.calls[0]["url"] == "https://api.piapi.ai/api/v1/task/pi-1"


@pytest.mark.parametrize("output,expected", [
    ({"video": "https://v.test/a.mp4"}, [("video", "https://v.test/a.mp4")]),
    ({"video": "https://v.test/a.mp4", "video_url": "https://v.test/a.mp4", "works": []},
     [("video", "https://v.test/a.mp4")]),
    ({"video_url": "https://v.test/legacy.mp4"}, [("video", "https://v.test/legacy.mp4")]),
    ({"image_url": "https://i.test/a.png"}, [("image", "https://i.test/a.png")]),
    ({"image_urls": ["https://i.test/a.png", "https://i.test/b.png"]},
     [("image", "https://i.test/a.png"), ("image", "https://i.test/b.png")]),
    ({"images": [{"url": "https://i.test/a.webp"}, {"url": "https://i.test/b.webp"}]},
     [("image", "https://i.test/a.webp"), ("image", "https://i.test/b.webp")]),
    ({"images": ["https://i.test/plain.png"]}, [("image", "https://i.test/plain.png")]),
])
def test_piapi_every_output_shape(output, expected):
    for status in ("completed", "Completed", "success"):
        pi, _ = adapter("piapi", _pi_task(status, output))
        result = pi.poll("pi-1", KEY)
        assert result.status == "COMPLETED"
        assert [(o.kind, o.url) for o in result.outputs] == expected


@pytest.mark.parametrize("output", [None, {}, {"video": ""}, {"images": [{"nope": 1}]}, "https://x"])
def test_piapi_completed_without_output_is_malformed(output):
    pi, _ = adapter("piapi", _pi_task("completed", output))
    with pytest.raises(ProviderError) as exc:
        pi.poll("pi-1", KEY)
    assert exc.value.kind == "malformed_response"


@pytest.mark.parametrize("message,kind", [
    ("upstream generation failed", "provider_failure"),
    ("content violation: task rejected by moderation", "content_rejected"),
    ("insufficient credits", "insufficient_credits"),
    ("", "provider_failure"),
])
def test_piapi_failed_task(message, kind):
    pi, _ = adapter("piapi", _pi_task("failed", error={"code": 10000, "message": message, "raw_message": ""}))
    result = pi.poll("pi-1", KEY)
    assert result.status == "FAILED" and result.error.kind == kind
    assert result.error.retryable is False


def test_piapi_failed_task_uses_raw_message_when_message_empty():
    pi, _ = adapter("piapi", _pi_task("Failed", error={"code": 500, "message": "", "raw_message": "sensitive image"}))
    result = pi.poll("pi-1", KEY)
    assert result.error.kind == "content_rejected" and result.error.provider_code == "500"


def test_piapi_poll_unknown_status():
    pi, _ = adapter("piapi", _pi_task("vanished"))
    with pytest.raises(ProviderError) as exc:
        pi.poll("pi-1", KEY)
    assert exc.value.kind == "malformed_response"


def test_piapi_poll_retries_5xx_then_succeeds_and_is_bounded():
    pi, t = adapter("piapi", resp(502, b""), _pi_task("processing"))
    assert pi.poll("pi-1", KEY).status == "RUNNING" and len(t.calls) == 2
    pi, t = adapter("piapi", *[resp(429, {"message": "slow"})] * 4)
    with pytest.raises(ProviderError) as exc:
        pi.poll("pi-1", KEY)
    assert exc.value.kind == "rate_limited" and len(t.calls) == 3


def test_piapi_poll_partial_json():
    pi, _ = adapter("piapi", resp(200, b'{"code": 200, "data": {"status": "comp'))
    with pytest.raises(ProviderError) as exc:
        pi.poll("pi-1", KEY)
    assert exc.value.kind == "malformed_response"


def test_piapi_upload_success(tmp_path):
    f = tmp_path / "ref.jpg"
    f.write_bytes(b"jpegbytes")
    pi, t = adapter("piapi", {"code": 200, "data": {"url": "https://img.theapi.app/ephemeral/ref.jpg"},
                              "message": "success"})
    assert pi.upload_file(f, KEY) == "https://img.theapi.app/ephemeral/ref.jpg"
    call = t.calls[0]
    assert call["url"] == "https://upload.theapi.app/api/ephemeral_resource"
    assert call["headers"]["x-api-key"] == KEY
    assert json.loads(call["body"]) == {"file_name": "ref.jpg", "file_data": base64.b64encode(b"jpegbytes").decode()}


def test_piapi_upload_plan_gated_403(tmp_path):
    f = tmp_path / "ref.png"
    f.write_bytes(b"x")
    pi, _ = adapter("piapi", resp(403, {"code": 403, "message": "Insufficient plan level"}))
    with pytest.raises(ProviderError) as exc:
        pi.upload_file(f, KEY)
    assert (exc.value.kind, exc.value.provider_code, exc.value.http_status) == ("unsupported", "plan_required", 403)


def test_piapi_upload_cap_and_type_checked_before_sending(tmp_path):
    big = tmp_path / "big.mp4"
    big.write_bytes(b"x" * 10_000_001)
    pi, t = adapter("piapi")
    with pytest.raises(ProviderError) as exc:
        pi.upload_file(big, KEY)
    assert (exc.value.kind, exc.value.provider_code) == ("unsupported", "file_too_large")
    mov = tmp_path / "clip.mov"
    mov.write_bytes(b"x")
    with pytest.raises(ProviderError) as exc:
        pi.upload_file(mov, KEY)
    assert exc.value.provider_code == "unsupported_file_type"
    assert t.calls == []
    at_cap = tmp_path / "cap.mp3"
    at_cap.write_bytes(b"x" * 10_000_000)
    pi, t = adapter("piapi", {"code": 200, "data": {"url": "https://img.theapi.app/cap.mp3"}})
    assert pi.upload_file(at_cap, KEY).endswith("cap.mp3")


def test_piapi_validate_key():
    pi, t = adapter("piapi", {"code": 200, "data": {"account_name": "me", "credits": 120, "equivalent_in_usd": 1.2}})
    status = pi.validate_key(KEY)
    assert (status.valid, status.balance, status.balance_unit) == (True, 1.2, "usd")
    assert t.calls[0]["url"] == "https://api.piapi.ai/account/info"
    assert t.calls[0]["headers"]["x-api-key"] == KEY
    pi, _ = adapter("piapi", resp(401, {"message": "invalid key"}))
    assert pi.validate_key(KEY).valid is False
    pi, _ = adapter("piapi", {"code": 200, "data": {}})
    status = pi.validate_key(KEY)
    assert status.valid is True and status.balance is None
    pi, t = adapter("piapi", ConnectionError("down"), {"code": 200, "data": {"credits": 5}})
    assert pi.validate_key(KEY).balance == 5.0 and len(t.calls) == 2


def test_piapi_kling_omni_request_round_trip():
    pi, t = adapter("piapi", _pi_task("pending"))
    req = piapi_request("kling-4.0", "omni_reference_to_video", [Reference("image", "https://i.test/a.png")])
    pi.submit(req, KEY)
    sent = json.loads(t.calls[0]["body"])
    assert sent["config"] == {"service_mode": "public"} and sent["task_type"] == "omni_video_generation"


# =========================================================================
# UrllibTransport (urlopen patched; no network)
# =========================================================================

def test_urllib_transport_maps_errors(monkeypatch):
    import io
    import socket
    import urllib.error

    from backend.byok import http as byok_http

    transport = byok_http.UrllibTransport()

    def http_error(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 429, "Too Many", {}, io.BytesIO(b'{"msg": "slow"}'))

    monkeypatch.setattr(byok_http.urllib.request, "urlopen", http_error)
    r = transport("GET", "https://api.kie.ai/x", {"A": "b"}, None, 5)
    assert (r.status, r.body) == (429, b'{"msg": "slow"}')

    def url_error(req, timeout):
        raise urllib.error.URLError(ConnectionRefusedError("refused"))

    monkeypatch.setattr(byok_http.urllib.request, "urlopen", url_error)
    with pytest.raises(ProviderError) as exc:
        transport("GET", "https://api.kie.ai/x", {}, None, 5)
    assert exc.value.kind == "network" and exc.value.retryable

    def timeout(req, timeout):
        raise socket.timeout("timed out")

    monkeypatch.setattr(byok_http.urllib.request, "urlopen", timeout)
    with pytest.raises(ProviderError) as exc:
        transport("GET", "https://api.kie.ai/x", {}, None, 5)
    assert exc.value.kind == "timeout"

    def wrapped_timeout(req, timeout):
        raise urllib.error.URLError(TimeoutError("slow"))

    monkeypatch.setattr(byok_http.urllib.request, "urlopen", wrapped_timeout)
    with pytest.raises(ProviderError) as exc:
        transport("GET", "https://api.kie.ai/x", {}, None, 5)
    assert exc.value.kind == "timeout"


def test_urllib_transport_success_passes_method_headers_and_body(monkeypatch):
    from backend.byok import http as byok_http

    seen = {}

    class Resp:
        status = 200
        headers = {"Content-Type": "application/json"}

        def read(self):
            return b'{"ok": true}'

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout):
        seen.update(method=req.get_method(), url=req.full_url, data=req.data, timeout=timeout,
                    ua=req.get_header("User-agent"))
        return Resp()

    monkeypatch.setattr(byok_http.urllib.request, "urlopen", fake_urlopen)
    r = byok_http.UrllibTransport()("POST", "https://api.piapi.ai/api/v1/task", {"User-Agent": "UA"}, b"{}", 7)
    assert r.status == 200 and r.body == b'{"ok": true}'
    assert seen == {"method": "POST", "url": "https://api.piapi.ai/api/v1/task", "data": b"{}", "timeout": 7,
                    "ua": "UA"}


def test_retry_backoff_is_bounded_exponential():
    policy = RetryPolicy(max_attempts=5, base_delay_s=1.0, max_delay_s=4.0)
    assert [policy.delay(n) for n in range(1, 5)] == [1.0, 2.0, 4.0, 4.0]
