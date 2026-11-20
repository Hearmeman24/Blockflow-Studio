"""The provider's own reason leads a failure message ("<Provider>: <words>").

One builder in ``backend.byok.errors`` makes every message that carries
provider text: ``classify`` (HTTP and body status codes), the Kie poll and the
PiAPI poll. Our generic sentence is used only when the provider said nothing
readable (no text, an HTML page, a JSON blob, a bare code or placeholder).
Providers are mocked at the HTTP transport.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.byok import errors  # noqa: E402
from backend.byok.errors import ProviderError, classify, mentions_content_rejection  # noqa: E402
from backend.byok.http import HttpResponse, RetryPolicy  # noqa: E402
from backend.byok.providers import get_adapter  # noqa: E402

KEY = "sk-test-FAKE-KEY-1234567890"

# The real Kie refusal from a stored job.
KIE_REFUSAL = ("Content security audit did not pass. The output audio may be related to copyright "
               "restrictions.")
OMNI = ("Kling 4.0 Omni generation is not available yet. Use video_generation, text_to_video, or "
        "image_to_video")


class FakeTransport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url})
        item = self.responses.pop(0)
        if isinstance(item, HttpResponse):
            return item
        return HttpResponse(200, json.dumps(item).encode())


FAST = RetryPolicy(max_attempts=1, base_delay_s=0, sleep=lambda s: None)


def adapter(provider, *responses):
    return get_adapter(provider, transport=FakeTransport(*responses), retry=FAST)


def kie_failed(**task):
    return {"code": 200, "msg": "success", "data": {"taskId": "t1", "state": "fail", **task}}


def piapi_failed(error):
    return {"code": 200, "message": "success", "data": {"task_id": "t1", "status": "failed", "error": error}}


def kie_request():
    return get_adapter("kie").build_request("wan-3.0", "text_to_video", {"prompt": "a fox"}, [])


def piapi_request():
    return get_adapter("piapi").build_request("seedance-2", "text_to_video", {"prompt": "a fox"}, [])


# ================================================================== classification


@pytest.mark.parametrize("text", [
    KIE_REFUSAL,
    "Security audit failed for this output.",
    "The output may infringe copyright.",
])
def test_audit_and_copyright_refusals_are_content_rejections(text):
    assert mentions_content_rejection(text)


@pytest.mark.parametrize("text", [
    "internal generation error", "duration must be 5 or 10", "Insufficient plan level",
    "The service is temporarily unavailable", "File too large", OMNI,
])
def test_ordinary_failures_are_not_content_rejections(text):
    assert not mentions_content_rejection(text)


# ================================================================== the reason, cleaned


@pytest.mark.parametrize("text,expected", [
    ("Bad prompt", "Bad prompt."),
    ("Bad prompt.", "Bad prompt."),
    ("Bad prompt..", "Bad prompt."),
    ("Is the model ready?", "Is the model ready?"),
    ("Out of capacity!", "Out of capacity!"),
    ("Hold on...", "Hold on..."),
    ("invalid value (duration)", "invalid value (duration)."),
    ("invalid value (see docs.)", "invalid value (see docs.)"),
    ("Error in field:", "Error in field."),
    ("  two\n lines\t here ", "two lines here."),
    ("Não foi possível gerar", "Não foi possível gerar."),
])
def test_reason_ends_as_one_sentence(text, expected):
    assert errors.provider_reason(text) == expected


@pytest.mark.parametrize("text", [
    None, "", "   ", "\n",
    "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>",
    "<!DOCTYPE html><html><body>Error</body></html>",
    "{'error': 'boom'}", '{"error": {"message": "boom"}}', "[1, 2, 3]",
    "500", "-1", "null", "None", "success", "error", "Error.", "failed", "unknown",
])
def test_non_prose_is_not_a_reason(text):
    assert errors.provider_reason(text) is None


def test_reason_redacts_the_key():
    assert errors.provider_reason(f"key {KEY} is not valid", KEY) == "key [redacted] is not valid."


def test_reason_that_is_only_the_key_still_leads_redacted():
    assert errors.provider_reason(f"{KEY} rejected", KEY) == "[redacted] rejected."


def test_reason_is_capped_at_300_characters():
    reason = errors.provider_reason("a" * 400)
    assert reason == "a" * 300 + "…"


def test_cap_never_leaves_a_dangling_space_or_full_stop_before_the_ellipsis():
    reason = errors.provider_reason("word. " * 60)
    assert reason is not None and len(reason) <= 301
    assert reason.endswith("word…")


def test_cap_redacts_before_cutting():
    reason = errors.provider_reason("x" * 290 + KEY + " more text", KEY)
    assert reason is not None
    assert KEY[:10] not in reason and "[redacted]" in reason


# ================================================================== the hint join


@pytest.mark.parametrize("message,expected", [
    ("Kie: foo", "Kie: foo. Run again."),
    ("Kie: foo.", "Kie: foo. Run again."),
    ("Kie: foo..", "Kie: foo. Run again."),
    ("Kie: foo?", "Kie: foo? Run again."),
    ("Kie: (foo.)", "Kie: (foo.) Run again."),
    ("Kie: (foo)", "Kie: (foo). Run again."),
    ("Kie: foo… ", "Kie: foo… Run again."),
])
def test_with_hint_punctuation(message, expected):
    assert errors.with_hint(message, "Run again.") == expected


def test_with_hint_skips_an_empty_or_repeated_hint():
    assert errors.with_hint("Kie: foo.", "") == "Kie: foo."
    assert errors.with_hint("Kie: run again later.", "Run again later.") == "Kie: run again later."


# ================================================================== classify


def test_classify_leads_with_the_provider_reason():
    err = classify("kie", "Kie", 422, KIE_REFUSAL, api_key=KEY)
    assert err.kind == "content_rejected" and not err.retryable
    assert err.message == f"Kie: {KIE_REFUSAL}"


def test_classify_validation_reason_gets_a_full_stop():
    err = classify("piapi", "PiAPI", 400, OMNI, api_key=KEY)
    assert err.kind == "validation"
    assert err.message == f"PiAPI: {OMNI}."
    assert (err.http_status, err.provider_code) == (None, "400")


# The generic sentences carry no action of their own: the service appends one
# per kind (``service._HINTS``), so it is never said twice.
@pytest.mark.parametrize("status,kind,generic", [
    (401, "auth", "The Kie API key was rejected."),
    (402, "insufficient_credits", "Your Kie account does not have enough credits for this request."),
    (429, "rate_limited", "Kie is rate limiting requests."),
    (422, "validation", "Kie rejected the request parameters."),
    (500, "provider_failure", "Kie could not complete the request."),
])
@pytest.mark.parametrize("detail", ["", "<html><body>Bad Gateway</body></html>", '{"a": 1}'])
def test_classify_without_a_readable_reason_keeps_the_generic_sentence(status, kind, generic, detail):
    err = classify("kie", "Kie", status, detail, api_key=KEY)
    assert (err.kind, err.message) == (kind, generic)


def test_classify_redacts_and_caps_the_reason():
    err = classify("kie", "Kie", 422, f"bad {KEY} " + "y" * 400, api_key=KEY)
    assert KEY not in err.message and "[redacted]" in err.message
    assert err.message.startswith("Kie: bad [redacted] ") and len(err.message) == len("Kie: ") + 301


# ================================================================== Kie adapter


def test_kie_poll_real_refusal_is_content_rejected_and_leads_with_the_reason():
    result = adapter("kie", kie_failed(failCode="400", failMsg=KIE_REFUSAL)).poll("t1", KEY)
    assert result.status == "FAILED"
    assert result.error.kind == "content_rejected"
    assert result.error.message == f"Kie: {KIE_REFUSAL}"
    assert result.error.provider_code == "400" and result.error.retryable is False


@pytest.mark.parametrize("fail_msg", [None, "", "  ", "<html>oops</html>", "500"])
def test_kie_poll_without_a_reason_uses_the_generic_sentence(fail_msg):
    result = adapter("kie", kie_failed(failCode="500", failMsg=fail_msg)).poll("t1", KEY)
    assert (result.error.kind, result.error.message) == ("provider_failure", "Kie could not generate this result.")


def test_kie_poll_reason_redacts_the_key():
    result = adapter("kie", kie_failed(failMsg=f"bad token {KEY}")).poll("t1", KEY)
    assert result.error.message == "Kie: bad token [redacted]."


def test_kie_submit_insufficient_credits_leads_with_the_reason():
    kie = adapter("kie", {"code": 402, "msg": "Credits insufficient, please top up"})
    with pytest.raises(ProviderError) as exc:
        kie.submit(kie_request(), KEY)
    assert exc.value.kind == "insufficient_credits"
    assert exc.value.message == "Kie: Credits insufficient, please top up."


def test_kie_submit_html_error_page_keeps_the_generic_sentence():
    kie = adapter("kie", HttpResponse(502, b"<html><body><h1>502 Bad Gateway</h1></body></html>"))
    with pytest.raises(ProviderError) as exc:
        kie.submit(kie_request(), KEY)
    assert exc.value.message == "Kie could not complete the request."


def test_kie_body_code_with_a_json_msg_keeps_the_generic_sentence():
    kie = adapter("kie", {"code": 422, "msg": {"field": "duration", "error": "bad"}})
    with pytest.raises(ProviderError) as exc:
        kie.submit(kie_request(), KEY)
    assert exc.value.kind == "validation" and exc.value.message == "Kie rejected the request parameters."


# ================================================================== PiAPI adapter


def test_piapi_poll_content_refusal_leads_with_the_reason():
    result = adapter("piapi", piapi_failed({"code": 10000, "message": "Prompt flagged by the safety system"})
                     ).poll("t1", KEY)
    assert result.error.kind == "content_rejected"
    assert result.error.message == "PiAPI: Prompt flagged by the safety system."
    assert result.error.provider_code == "10000"


def test_piapi_poll_insufficient_credits_leads_with_the_reason():
    result = adapter("piapi", piapi_failed({"code": 10001, "message": "insufficient credits for this task"})
                     ).poll("t1", KEY)
    assert result.error.kind == "insufficient_credits"
    assert result.error.message == "PiAPI: insufficient credits for this task."


def test_piapi_poll_provider_failure_leads_with_the_reason():
    result = adapter("piapi", piapi_failed({"code": 10002, "raw_message": "upstream render node crashed"})
                     ).poll("t1", KEY)
    assert result.error.kind == "provider_failure"
    assert result.error.message == "PiAPI: upstream render node crashed."


@pytest.mark.parametrize("error", [{}, {"code": 0, "message": ""}, {"message": "failed"},
                                   {"message": "<html><body>x</body></html>"}])
def test_piapi_poll_without_a_reason_uses_the_generic_sentence(error):
    result = adapter("piapi", piapi_failed(error)).poll("t1", KEY)
    assert (result.error.kind, result.error.message) == ("provider_failure", "PiAPI could not generate this result.")


def test_piapi_poll_reason_redacts_the_key():
    result = adapter("piapi", piapi_failed({"message": f"oops {KEY}"})).poll("t1", KEY)
    assert result.error.message == "PiAPI: oops [redacted]."


def test_piapi_submit_validation_leads_with_the_reason():
    piapi = adapter("piapi", HttpResponse(400, json.dumps({"code": 400, "message": OMNI}).encode()))
    with pytest.raises(ProviderError) as exc:
        piapi.submit(piapi_request(), KEY)
    assert exc.value.kind == "validation" and exc.value.message == f"PiAPI: {OMNI}."
