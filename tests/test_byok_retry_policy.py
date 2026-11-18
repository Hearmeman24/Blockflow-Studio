"""One retry and error-kind policy table (backend/byok/errors.py RETRY_POLICY).

The three sets that used to be written out by hand (the default ``retryable``
flag, the kinds ``with_retry`` retries inside one call, and the submit
failures that may still have created a paid task) are derived from it with
exactly today's contents. Submit is never retried. A retry backoff stops
early once the job is cancelled.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.byok import errors, http, service  # noqa: E402
from backend.byok.errors import ERROR_KINDS, RETRY_POLICY, ProviderError  # noqa: E402
from backend.byok.http import HttpResponse, RetryPolicy, with_retry  # noqa: E402
from backend.byok.providers import get_adapter  # noqa: E402
from backend.statuses import ErrorKind  # noqa: E402

KEY = "sk-test-FAKE-KEY-1234567890"


def test_policy_table_is_total_over_error_kinds():
    assert set(RETRY_POLICY) == set(ErrorKind)


def test_derived_sets_keep_todays_exact_contents():
    assert errors._RETRYABLE_BY_DEFAULT == {"rate_limited", "network", "timeout"}
    assert http.RETRY_KINDS == {"rate_limited", "network", "provider_failure"}
    assert service._AMBIGUOUS_SUBMIT == {"timeout", "network", "malformed_response"}
    assert all(isinstance(k, str) for k in http.RETRY_KINDS | service._AMBIGUOUS_SUBMIT)


def test_derived_sets_come_from_the_table():
    assert errors._RETRYABLE_BY_DEFAULT == {k for k, p in RETRY_POLICY.items() if p.retryable_by_default}
    assert http.RETRY_KINDS == {k for k, p in RETRY_POLICY.items() if p.http_retry}
    assert service._AMBIGUOUS_SUBMIT == {k for k, p in RETRY_POLICY.items() if p.ambiguous_on_submit}


def test_interrupted_is_never_retried_and_never_ambiguous():
    policy = RETRY_POLICY[ErrorKind.INTERRUPTED]
    assert (policy.retryable_by_default, policy.http_retry, policy.ambiguous_on_submit) == (False, False, False)


@pytest.mark.parametrize("kind", ERROR_KINDS)
def test_provider_error_default_retryable_flag_is_unchanged(kind):
    expected = kind in {"rate_limited", "network", "timeout"}
    assert ProviderError(kind, "x").retryable is expected


def test_hints_are_total_over_error_kinds_and_unchanged():
    assert set(service._HINTS) == set(ErrorKind)
    assert {k: v for k, v in service._HINTS.items() if k != ErrorKind.INTERRUPTED} == {
        "auth": "Check the {p} API key in Settings.",
        "insufficient_credits": "Add credits to your {p} account, then run again.",
        "rate_limited": "Wait a minute, then run again.",
        "validation": "Adjust the settings or references, then run again.",
        "content_rejected": "Change the prompt or references, then run again.",
        "unsupported": "Choose another model, mode or provider.",
        "provider_failure": "Try again later; if it keeps failing, check the {p} status page.",
        "timeout": "Try again later.",
        "network": "Check your internet connection, then run again.",
        "malformed_response": "Try again; if it keeps happening, report it.",
    }
    # interrupted: the job store's own message already says what to do.
    assert service._HINTS[ErrorKind.INTERRUPTED] == service.NO_HINT == ""
    assert service.error_message("interrupted", "Run it again.", "kie") == "Run it again."


# ------------------------------------------------------------------ submit is never retried


class FakeTransport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url})
        item = self.responses.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item if isinstance(item, HttpResponse) else HttpResponse(200, json.dumps(item).encode())


@pytest.mark.parametrize("provider,model,mode", [("kie", "wan-3.0", "text_to_video"),
                                                 ("piapi", "seedance-2", "text_to_video")])
@pytest.mark.parametrize("failure", [
    HttpResponse(500, b'{"code": 500, "msg": "boom", "message": "boom"}'),
    HttpResponse(429, b'{"code": 429, "msg": "slow", "message": "slow"}'),
    ProviderError("network", "Could not reach the provider.", retryable=True),
])
def test_submit_is_never_retried_on_either_provider(provider, model, mode, failure):
    transport = FakeTransport(failure, {"code": 200, "data": {"taskId": "t", "task_id": "t", "status": "pending"}})
    adapter = get_adapter(provider, transport=transport,
                          retry=RetryPolicy(max_attempts=5, base_delay_s=0, sleep=lambda s: None))
    request = get_adapter(provider).build_request(model, mode, {"prompt": "a fox"}, [])
    with pytest.raises(ProviderError):
        adapter.submit(request, KEY)
    assert len(transport.calls) == 1


# ------------------------------------------------------------------ cancel-aware backoff


def _always(kind="network"):
    calls: list[int] = []

    def fn():
        calls.append(1)
        raise ProviderError(kind, "down", retryable=True)

    return fn, calls


def test_backoff_without_a_stop_check_is_unchanged():
    slept: list[float] = []
    fn, calls = _always()
    with pytest.raises(ProviderError):
        with_retry(fn, RetryPolicy(max_attempts=3, base_delay_s=1.0, sleep=slept.append))
    assert len(calls) == 3 and slept == [1.0, 2.0]


def test_backoff_stops_at_once_when_already_cancelled():
    slept: list[float] = []
    fn, calls = _always()
    with http.stop_retrying_when(lambda: True):
        with pytest.raises(ProviderError) as exc:
            with_retry(fn, RetryPolicy(max_attempts=3, base_delay_s=1.0, sleep=slept.append))
    assert exc.value.kind == "network"
    assert len(calls) == 1 and slept == []


def test_backoff_wakes_up_early_when_cancelled_during_the_sleep():
    slept: list[float] = []
    cancelled = [False]

    def sleep(seconds):
        slept.append(seconds)
        cancelled[0] = True

    fn, calls = _always()
    with http.stop_retrying_when(lambda: cancelled[0]):
        with pytest.raises(ProviderError):
            with_retry(fn, RetryPolicy(max_attempts=3, base_delay_s=4.0, sleep=sleep))
    assert len(calls) == 1
    assert slept == [http.RETRY_CANCEL_CHECK_S]


def test_backoff_with_a_stop_check_that_stays_false_sleeps_the_full_delay():
    slept: list[float] = []
    fn, calls = _always()
    with http.stop_retrying_when(lambda: False):
        with pytest.raises(ProviderError):
            with_retry(fn, RetryPolicy(max_attempts=2, base_delay_s=1.2, sleep=slept.append))
    assert len(calls) == 2
    assert sum(slept) == pytest.approx(1.2) and max(slept) <= http.RETRY_CANCEL_CHECK_S


def test_zero_delay_backoff_still_sleeps_once_per_retry_with_a_stop_check():
    slept: list[float] = []
    fn, calls = _always()
    with http.stop_retrying_when(lambda: False):
        with pytest.raises(ProviderError):
            with_retry(fn, RetryPolicy(max_attempts=3, base_delay_s=0, sleep=slept.append))
    assert len(calls) == 3 and slept == [0, 0]


def test_the_stop_check_is_cleared_after_the_block():
    with http.stop_retrying_when(lambda: True):
        pass
    slept: list[float] = []
    fn, calls = _always()
    with pytest.raises(ProviderError):
        with_retry(fn, RetryPolicy(max_attempts=2, base_delay_s=0, sleep=slept.append))
    assert len(calls) == 2
