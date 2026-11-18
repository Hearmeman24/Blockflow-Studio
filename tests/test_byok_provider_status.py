"""Provider task status mapping (both adapters): one declared vocabulary,
one map per adapter, one function per adapter that decides a raw status.

The provider poll status (``ProviderTaskStatus``: four values) is a different
thing from the job store's six-value ``JobStatus``; the adapters only ever
produce the four. Requests are faked at the HTTP transport.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.byok.catalog import UNVERIFIED  # noqa: E402
from backend.byok.errors import ProviderError  # noqa: E402
from backend.byok.http import HttpResponse, RetryPolicy  # noqa: E402
from backend.byok.providers import base, get_adapter, kie, piapi  # noqa: E402
from backend.statuses import ProviderTaskStatus  # noqa: E402

KEY = "sk-test-FAKE-KEY-1234567890"
FAST = RetryPolicy(max_attempts=3, base_delay_s=0, sleep=lambda s: None)


class FakeTransport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "body": body})
        item = self.responses.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item if isinstance(item, HttpResponse) else HttpResponse(200, json.dumps(item).encode())


def adapter(provider, *responses):
    transport = FakeTransport(*responses)
    return get_adapter(provider, transport=transport, retry=FAST), transport


def _kie_task(state, **extra):
    return {"code": 200, "msg": "success", "data": {"taskId": "t1", "state": state, **extra}}


def _pi_task(status, output=None, **extra):
    return {"code": 200, "message": "success",
            "data": {"task_id": "pi-1", "status": status, "output": output,
                     "error": {"code": 0, "message": "", "raw_message": ""}, **extra}}


def test_provider_task_status_is_four_values_with_todays_strings():
    assert [s.value for s in ProviderTaskStatus] == ["QUEUED", "RUNNING", "COMPLETED", "FAILED"]
    # The old name in providers/base.py still resolves, and now means the enum.
    assert base.ProviderTaskStatus is ProviderTaskStatus
    assert base.JobStatus is ProviderTaskStatus


def test_kie_state_map_is_typed_and_keeps_todays_documented_states():
    assert dict(kie.STATE_MAP) == {"waiting": "QUEUED", "queuing": "QUEUED", "generating": "RUNNING",
                                   "success": "COMPLETED", "fail": "FAILED"}
    assert all(isinstance(v, ProviderTaskStatus) for v in kie.STATE_MAP.values())


def test_piapi_status_map_is_typed_and_keeps_todays_twelve_values():
    assert dict(piapi.STATUS_MAP) == {
        "pending": "QUEUED", "staged": "QUEUED", "starting": "QUEUED",
        "processing": "RUNNING", "retry": "RUNNING", "running": "RUNNING",
        "completed": "COMPLETED", "success": "COMPLETED", "succeeded": "COMPLETED",
        "failed": "FAILED", "fail": "FAILED", "error": "FAILED"}
    assert all(isinstance(v, ProviderTaskStatus) for v in piapi.STATUS_MAP.values())


@pytest.mark.parametrize("module,raw,expected", [
    (kie, "waiting", "QUEUED"), (kie, "Generating", "RUNNING"), (kie, "SUCCESS", "COMPLETED"),
    (kie, "fail", "FAILED"),
    (piapi, " Pending ", "QUEUED"), (piapi, "processing\t", "RUNNING"), (piapi, "Completed", "COMPLETED"),
    (piapi, "error", "FAILED"),
])
def test_one_function_per_adapter_decides_a_raw_status(module, raw, expected):
    status = module.task_status(raw)
    assert status == expected and isinstance(status, ProviderTaskStatus)


@pytest.mark.parametrize("module,name", [(kie, "Kie"), (piapi, "PiAPI")])
@pytest.mark.parametrize("raw", ["teleporting", "canceled", "cancelled", "expired", ""])
def test_an_unknown_raw_status_is_one_retryable_malformed_response_naming_it(module, name, raw):
    with pytest.raises(ProviderError) as exc:
        module.task_status(raw)
    err = exc.value
    assert err.kind == "malformed_response" and err.retryable is True
    assert err.provider == module.__name__.rsplit(".", 1)[-1]
    assert err.message == f"{name} returned an unknown task status '{raw}'."


def test_unknown_status_message_is_truncated_to_forty_characters():
    with pytest.raises(ProviderError) as exc:
        kie.task_status("x" * 100)
    assert exc.value.message == f"Kie returned an unknown task status '{'x' * 40}'."


@pytest.mark.parametrize("provider,payload,raw", [
    ("kie", _kie_task("teleporting"), "teleporting"),
    ("piapi", _pi_task("vanished"), "vanished"),
])
def test_poll_of_an_unknown_status_uses_the_shared_message(provider, payload, raw):
    a, _ = adapter(provider, payload)
    with pytest.raises(ProviderError) as exc:
        a.poll("t1", KEY)
    assert exc.value.kind == "malformed_response" and exc.value.retryable is True
    assert f"unknown task status '{raw}'" in exc.value.message


@pytest.mark.parametrize("provider,payload", [
    ("kie", _kie_task("generating")),
    ("kie", _kie_task("success", resultJson=json.dumps({"resultUrls": ["https://cdn.test/a.mp4"]}))),
    ("kie", _kie_task("fail", failMsg="boom")),
    ("piapi", _pi_task("pending")),
    ("piapi", _pi_task("completed", {"video": "https://cdn.test/a.mp4"})),
    ("piapi", _pi_task("failed")),
])
def test_poll_results_carry_the_enum(provider, payload):
    a, _ = adapter(provider, payload)
    result = a.poll("t1", KEY)
    assert isinstance(result.status, ProviderTaskStatus)


def test_piapi_submit_decides_the_immediate_status_with_the_same_function(monkeypatch):
    seen: list[str] = []
    real = piapi.lookup_status

    def spy(raw):
        seen.append(raw)
        return real(raw)

    monkeypatch.setattr(piapi, "lookup_status", spy)
    pi, _ = adapter("piapi", _pi_task("Completed", {"image_url": "https://img.test/a.png"}))
    request = get_adapter("piapi").build_request("seedream-5-lite", "text_to_image", {"prompt": "a fox"}, [])
    result = pi.submit(request, KEY)
    assert result.initial is not None and isinstance(result.initial.status, ProviderTaskStatus)
    assert seen and all(raw == "Completed" for raw in seen)


@pytest.mark.parametrize("raw", ["pending", "processing", "vanished", ""])
def test_piapi_submit_with_a_non_terminal_or_unknown_status_polls_later(raw):
    # Unchanged: only a known terminal status at submit is read as a result.
    pi, t = adapter("piapi", _pi_task(raw))
    request = get_adapter("piapi").build_request("seedream-5-lite", "text_to_image", {"prompt": "a fox"}, [])
    result = pi.submit(request, KEY)
    assert (result.remote_job_id, result.initial, result.initial_error) == ("pi-1", None, None)
    assert len(t.calls) == 1


def test_undocumented_task_statuses_are_recorded_as_unverified():
    entries = [u for u in UNVERIFIED if u.field == "task status"]
    assert {u.provider for u in entries} == {"kie", "piapi"}
    for entry in entries:
        assert "unknown" in entry.detail.lower()
