"""Character Swap: what reaches the provider for one driving video and one image.

The block has no backend of its own: it submits an Omni Reference request with
a fixed prompt whose reference names come from the ledger. These tests read the
block's model list and prompt template from the frontend config, check both
against the ledger, and send the request through the real adapters with a fake
HTTP transport. No network, no real keys.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.byok import ledger  # noqa: E402
from backend.byok.http import HttpResponse, RetryPolicy  # noqa: E402
from backend.byok.providers import get_adapter  # noqa: E402
from backend.byok.spec import Reference  # noqa: E402
from backend.byok.validation import validate_request  # noqa: E402

MODE = "omni_reference_to_video"
KEY = "swap-TEST-KEY-0123456789"
VIDEO = "https://cdn.test/drive.mp4"
IMAGE = "https://cdn.test/face.png"
KIE_CREATE = "https://api.kie.ai/api/v1/jobs/createTask"
PIAPI_TASK = "https://api.piapi.ai/api/v1/task"
FAST = RetryPolicy(max_attempts=1, base_delay_s=0, sleep=lambda s: None)

PLAIN = "Replace the person from Video1 with the person from Image1"
AT = "Replace the person from @video1 with the person from @image1"
AT_UNDERSCORE = "Replace the person from @video_1 with the person from @image_1"

# provider, model, URL, prompt, provider model fields, field holding the video, field holding the image
CASES = [
    ("kie", "wan-3.0", KIE_CREATE, PLAIN, {"model": "wan/3-0-video"}, "reference_video_urls", "reference_image_urls"),
    ("kie", "seedance-2.5", KIE_CREATE, PLAIN, {"model": "bytedance/seedance-2-5"},
     "reference_video_urls", "reference_image_urls"),
    ("piapi", "seedance-2.5", PIAPI_TASK, AT, {"model": "seedance", "task_type": "seedance-2.5"},
     "video_urls", "image_urls"),
    ("kie", "seedance-2", KIE_CREATE, PLAIN, {"model": "bytedance/seedance-2"},
     "reference_video_urls", "reference_image_urls"),
    ("piapi", "seedance-2", PIAPI_TASK, AT, {"model": "seedance", "task_type": "seedance-2"},
     "video_urls", "image_urls"),
    ("kie", "kling-4.0", KIE_CREATE, AT_UNDERSCORE, {"model": "kling-4.0/reference-to-video"},
     "video_urls", "image_urls"),
    # Kling 4.0 on PiAPI is not offered in Omni Reference to Video (tests/test_byok_piapi_kling_omni.py).
]
IDS = [f"{c[0]}-{c[1]}" for c in CASES]


class FakeTransport:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "headers": dict(headers), "body": body})
        return HttpResponse(200, json.dumps(self.response).encode())


SUBMITTED = {
    "kie": {"code": 200, "msg": "success", "data": {"taskId": "swap-task"}},
    "piapi": {"code": 200, "message": "success", "data": {
        "task_id": "swap-task", "status": "Pending", "output": {},
        "error": {"code": 0, "message": "", "raw_message": ""}}},
}


def block_config() -> dict:
    """The Character Swap entry of the frontend's generation block configs."""
    source = (ROOT / "frontend/src/lib/byok/generation-blocks.ts").read_text(encoding="utf-8")
    entry = re.search(r"characterSwap:\s*\{(.*?)\n  \},", source, re.S)
    assert entry, "characterSwap is missing from GENERATION_BLOCK_CONFIGS"
    body = entry.group(1)
    models = re.search(r"models:\s*\[(.*?)\]", body, re.S)
    prompt = re.search(r"fixedPrompt:\s*'([^']*)'", body)
    mode = re.search(r"mode:\s*'([^']*)'", body)
    assert models and prompt and mode
    return {"mode": mode.group(1), "models": re.findall(r"'([^']+)'", models.group(1)), "prompt": prompt.group(1)}


def prompt_for(provider: str, model: str) -> str:
    """The block's template with the ledger's names for the first video and image."""
    mentions = ledger.get_mode_spec(provider, model, MODE).mentions
    template = block_config()["prompt"]
    return template.replace("{video1}", mentions.video.format(n=1)).replace("{image1}", mentions.image.format(n=1))


def references():
    return [Reference("video", VIDEO, duration_s=5, format="mp4"), Reference("image", IMAGE, format="png")]


def test_the_block_offers_exactly_the_four_models_and_they_are_in_the_ledger():
    config = block_config()
    assert config["mode"] == MODE
    assert config["models"] == ["wan-3.0", "seedance-2.5", "seedance-2", "kling-4.0"]
    assert config["prompt"] == "Replace the person from {video1} with the person from {image1}"
    names = {m.id: m.name for m in ledger.CATALOG}
    assert [names[m] for m in config["models"]] == ["Wan 3.0", "Seedance 2.5", "Seedance 2", "Kling 4.0"]


def test_every_case_is_a_provider_the_ledger_offers_and_none_is_left_out():
    offered = set()
    for model_id in block_config()["models"]:
        for offering in ledger.get_model(model_id).offerings:
            spec = next((m for m in offering.modes if m.mode == MODE), None) if offering.offered else None
            if spec is not None and spec.supported:
                offered.add((offering.provider, model_id))
                kinds = {limit.kind for limit in spec.media}
                assert {"video", "image"} <= kinds, (offering.provider, model_id)
    assert {(c[0], c[1]) for c in CASES} == offered
    # Wan 3.0 is on Kie only, and PiAPI does not run Kling 4.0 in this mode.
    assert ("piapi", "wan-3.0") not in offered
    assert ("piapi", "kling-4.0") not in offered


@pytest.mark.parametrize("provider,model,url,prompt,ids,video_field,image_field", CASES, ids=IDS)
def test_the_fixed_prompt_uses_the_ledgers_reference_names(provider, model, url, prompt, ids, video_field, image_field):
    assert prompt_for(provider, model) == prompt


@pytest.mark.parametrize("provider,model,url,prompt,ids,video_field,image_field", CASES, ids=IDS)
def test_one_video_and_one_image_pass_validation(provider, model, url, prompt, ids, video_field, image_field):
    issues = validate_request(provider, model, MODE, {"prompt": prompt}, references())
    assert [i for i in issues if i.severity == "error"] == []


@pytest.mark.parametrize("provider,model,url,prompt,ids,video_field,image_field", CASES, ids=IDS)
def test_the_http_request_carries_the_prompt_the_video_and_the_image(
        provider, model, url, prompt, ids, video_field, image_field):
    transport = FakeTransport(SUBMITTED[provider])
    adapter = get_adapter(provider, transport=transport, retry=FAST)
    request = adapter.build_request(model, MODE, {"prompt": prompt_for(provider, model)}, references())

    result = adapter.submit(request, KEY)

    assert result.remote_job_id == "swap-task"
    [call] = transport.calls
    assert (call["method"], call["url"]) == ("POST", url)
    sent = json.loads(call["body"])
    assert {k: sent[k] for k in ids} == ids
    assert sent["input"]["prompt"] == prompt
    assert sent["input"][video_field] == [VIDEO]
    assert sent["input"][image_field] == [IMAGE]
    # Nothing else in the request is a reference: no audio, no frames.
    media = {k: v for k, v in sent["input"].items() if isinstance(v, list)}
    assert media == {video_field: [VIDEO], image_field: [IMAGE]}
    # The key travels in a header, never in the body.
    body = call["body"].decode() if isinstance(call["body"], bytes) else call["body"]
    assert KEY not in body


@pytest.mark.parametrize("missing", ["video", "image"])
def test_the_ledger_alone_does_not_require_both_kinds(missing):
    """Why the block checks its own counts: one reference of either kind is a valid Omni Reference request."""
    refs = [r for r in references() if r.kind != missing]
    issues = validate_request("kie", "wan-3.0", MODE, {"prompt": PLAIN}, refs)
    assert [i for i in issues if i.severity == "error"] == []
