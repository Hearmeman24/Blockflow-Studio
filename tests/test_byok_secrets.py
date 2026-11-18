"""API keys never appear in requests, exception text, reprs or results."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.byok.errors import ProviderError, redact  # noqa: E402
from backend.byok.http import HttpResponse, RetryPolicy  # noqa: E402
from backend.byok.providers import get_adapter  # noqa: E402

KEY = "sk-live-SUPERSECRET-9f8e7d6c5b4a"
FAST = RetryPolicy(max_attempts=2, base_delay_s=0, sleep=lambda s: None)


class Echo:
    """A transport whose error bodies echo the key back, like a careless provider."""

    def __init__(self, status=200, payload=None, exc=None):
        self.status, self.payload, self.exc = status, payload, exc

    def __call__(self, method, url, headers, body, timeout):
        if self.exc:
            raise self.exc
        return HttpResponse(self.status, json.dumps(self.payload).encode())


def _texts(err: BaseException) -> list[str]:
    return [str(err), repr(err), err.message, repr(err.info()), json.dumps(err.info().__dict__)]


def _request(provider):
    if provider == "kie":
        return get_adapter("kie").build_request("wan-3.0", "text_to_video", {"prompt": "x"}, [])
    return get_adapter("piapi").build_request("seedance-2", "text_to_video", {"prompt": "x"}, [])


@pytest.mark.parametrize("provider", ["kie", "piapi"])
def test_provider_request_has_no_key(provider):
    req = _request(provider)
    assert KEY not in repr(req)
    lowered = {k.lower() for k in req.header_dict}
    assert "authorization" not in lowered and "x-api-key" not in lowered


@pytest.mark.parametrize("provider,status,payload", [
    ("kie", 200, {"code": 401, "msg": f"Invalid key {KEY}"}),
    ("kie", 500, {"code": 500, "msg": f"crash for Bearer {KEY}"}),
    ("kie", 200, {"code": 422, "msg": f"bad param sent with {KEY}"}),
    ("piapi", 401, {"message": f"key {KEY} is not valid"}),
    ("piapi", 400, {"code": 400, "message": f"policy violation {KEY}"}),
    ("piapi", 200, {"code": 10003, "message": f"unknown field; key={KEY}"}),
])
def test_error_messages_redact_echoed_key(provider, status, payload):
    adapter = get_adapter(provider, transport=Echo(status, payload), retry=FAST)
    with pytest.raises(ProviderError) as exc:
        adapter.submit(_request(provider), KEY)
    for text in _texts(exc.value):
        assert KEY not in text
    assert "[redacted]" in exc.value.message


@pytest.mark.parametrize("provider", ["kie", "piapi"])
def test_failed_task_messages_redact_key(provider):
    if provider == "kie":
        payload = {"code": 200, "data": {"state": "fail", "failMsg": f"oops {KEY}", "failCode": "500"}}
    else:
        payload = {"code": 200, "data": {"task_id": "t", "status": "failed", "error": {"message": f"oops {KEY}"}}}
    adapter = get_adapter(provider, transport=Echo(200, payload), retry=FAST)
    result = adapter.poll("t", KEY)
    assert KEY not in repr(result) and KEY not in result.error.message


@pytest.mark.parametrize("provider", ["kie", "piapi"])
def test_transport_errors_redact_key(provider):
    adapter = get_adapter(provider, transport=Echo(exc=ProviderError("network", f"failed with {KEY}",
                                                                     retryable=True)), retry=FAST)
    with pytest.raises(ProviderError) as exc:
        adapter.poll("t", KEY)
    for text in _texts(exc.value):
        assert KEY not in text


@pytest.mark.parametrize("provider", ["kie", "piapi"])
def test_adapter_and_results_never_hold_the_key(provider):
    payload = ({"code": 200, "data": {"taskId": "t1"}} if provider == "kie"
               else {"code": 200, "data": {"task_id": "t1", "status": "pending"}})
    adapter = get_adapter(provider, transport=Echo(200, payload), retry=FAST)
    result = adapter.submit(_request(provider), KEY)
    assert KEY not in repr(result) and KEY not in repr(adapter) and KEY not in repr(vars(adapter))
    status_payload = {"code": 200, "data": 10} if provider == "kie" else {"code": 200, "data": {"credits": 1}}
    status = get_adapter(provider, transport=Echo(200, status_payload), retry=FAST).validate_key(KEY)
    assert KEY not in repr(status)


def test_redact_handles_none_and_short_values():
    assert redact(None, KEY) == ""
    assert redact("abc", "ab") == "abc"  # too short to be a key; avoid mangling text
    assert redact(f"x{KEY}y{KEY}", KEY) == "x[redacted]y[redacted]"


def test_provider_error_rejects_unknown_kind():
    with pytest.raises(ValueError):
        ProviderError("oops", "x")
