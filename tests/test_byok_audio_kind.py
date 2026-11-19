"""Sound is one reference kind, ``audio``, on every model.

There is no ``voice`` kind any more. Kling 4.0 on Kie takes audio references
and its adapter sends each one as an entry of the API's ``voices`` list with a
generated name (``sound_<n>``: ``audio_<n>`` is a reserved name in Kie's
schema). A request reference with the old ``kind: "voice"`` is read as audio
and its ``name`` is ignored.
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import db, job_store, output_folder, settings_store  # noqa: E402
from backend.byok import catalog, ledger, pricing, references, routes, service  # noqa: E402
from backend.byok.errors import ProviderError  # noqa: E402
from backend.byok.http import HttpResponse, RetryPolicy  # noqa: E402
from backend.byok.providers import get_adapter  # noqa: E402
from backend.byok.spec import MEDIA_KINDS, MentionSpec, Reference  # noqa: E402
from backend.byok.validation import coerce_reference, validate_request  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BEFORE = ROOT / "tests" / "fixtures" / "catalog_modes_before_audio_merge.json"
PROMPT = "@image_1 sings with @sound_1"
I1, I2 = "https://cdn.test/one.png", "https://cdn.test/two.png"
V1 = "https://cdn.test/clip.mp4"
A1, A2, A3 = "https://cdn.test/a1.mp3", "https://cdn.test/a2.mp3", "https://cdn.test/a3.mp3"
KLING = ("kie", "kling-4.0", "omni_reference_to_video")


def build(provider, model, mode, refs, params=None):
    return get_adapter(provider).build_request(model, mode, params or {"prompt": PROMPT}, list(refs)).body


def codes(issues):
    return [i.code for i in issues]


# ------------------------------------------------------------------ kinds


def test_media_kinds_are_image_video_audio():
    assert MEDIA_KINDS == ("image", "video", "audio")
    assert ledger.catalog_payload(set())["media_kinds"] == ["image", "video", "audio"]


def test_mention_spec_has_no_voice_template():
    assert not hasattr(MentionSpec(), "voice")


def test_no_mode_declares_a_voice_limit_or_rule():
    for model in catalog.CATALOG:
        for offering in model.offerings:
            for spec in offering.modes:
                for s in (spec, *(v for _, v in spec.variants)):
                    assert all(m.kind in MEDIA_KINDS for m in s.media), (model.id, s.mode)
                    assert "kling_voice_names" not in s.rules


def test_kling_4_on_kie_takes_up_to_three_audio():
    spec = ledger.get_mode_spec(*KLING)
    audio = spec.media_limit("audio")
    assert audio is not None and audio.max_count == 3
    # Nothing about the files is documented, so nothing is invented.
    assert (audio.formats, audio.max_size_bytes, audio.min_duration_s, audio.max_duration_s) == ((), None, None, None)
    assert spec.rules == ("keep_sound_needs_video",)
    assert spec.audio_only_allowed is False and spec.max_total_references == 15


def test_kling_mentions_on_kie():
    assert ledger.get_mode_spec(*KLING).mentions.audio == "@sound_{n}"
    assert catalog.KIE_KLING_AUDIO_NAME.format(n=2) == "sound_2"
    # Flash takes no audio: its audio template stays the plain fallback.
    flash = ledger.get_mode_spec("kie", "kling-4.0-flash", "omni_reference_to_video")
    assert flash.media_limit("audio") is None and flash.mentions.audio == "Audio{n}"


def test_catalog_payload_never_says_voice_outside_the_kie_api_field():
    payload = ledger.catalog_payload({"kie", "piapi"})
    unverified = [u for u in payload.pop("unverified") if "voice" in json.dumps(u).lower()]
    assert "voice" not in json.dumps(payload).lower()
    # The only mention left is the Kie API's own field name.
    assert [(u["provider"], u["model"]) for u in unverified] == [("kie", "kling-4.0")]
    assert "`voices`" in unverified[0]["detail"] and "sound_1" in unverified[0]["detail"]


def _modes(payload):
    for model in payload["models"]:
        for provider, offering in model["providers"].items():
            for mode, spec in offering["modes"].items():
                yield f"{provider}/{model['id']}/{mode}", spec


def test_other_modes_are_unchanged_except_the_voice_template():
    before = json.loads(BEFORE.read_text())["modes"]
    now = dict(_modes(ledger.catalog_payload({"kie", "piapi"})))
    assert before, "fixture is empty"
    for key, old in before.items():
        expected = _without_voice_template(old)
        if key == "kie/kling-4.0-flash/omni_reference_to_video":
            # Kling/Kie: the voice-name rule was declared on Flash too (it took no voices).
            expected["rules"] = [r for r in expected["rules"] if r != "kling_voice_names"]
        if key in PIAPI_KLING_OMNI_REMOVED:
            # PiAPI refused Kling 4.0 Omni on 2026-11-18; the offering was removed (test_byok_piapi_kling_omni.py).
            assert now[key]["supported"] is False and now[key]["unavailable_reason"] == catalog.PIAPI_KLING_NO_OMNI
            continue
        assert now[key] == expected, key
    assert PIAPI_KLING_OMNI_REMOVED & set(before), "the exception above is no longer exercised"


PIAPI_KLING_OMNI_REMOVED = {"piapi/kling-4.0/omni_reference_to_video", "piapi/kling-4.0-flash/omni_reference_to_video"}


def _without_voice_template(value):
    if isinstance(value, dict):
        return {k: _without_voice_template(v) for k, v in value.items() if k != "voice"}
    if isinstance(value, list):
        return [_without_voice_template(v) for v in value]
    return value


# ------------------------------------------------------------------ the old kind at the boundary


def test_coerce_reads_voice_as_audio_and_drops_the_name():
    ref = coerce_reference({"kind": "voice", "url": A1, "name": "Narrator", "duration_s": 4.0})
    assert ref == Reference("audio", A1, duration_s=4.0)
    assert coerce_reference({"kind": "audio", "url": A1, "name": "x"}) == Reference("audio", A1)
    assert coerce_reference(Reference("voice", A1)) == Reference("audio", A1)


def test_reference_has_no_name():
    assert "name" not in Reference.__dataclass_fields__


# ------------------------------------------------------------------ validation


def test_kling_kie_audio_validates_and_voice_alias_is_the_same():
    image = Reference("image", I1)
    assert codes(validate_request(*KLING, {"prompt": PROMPT}, [image, Reference("audio", A1)])) == []
    assert codes(validate_request(*KLING, {"prompt": PROMPT},
                                  [image, {"kind": "voice", "url": A1, "name": "image_1"}])) == []


def test_kling_kie_four_audio_is_too_many():
    refs = [Reference("image", I1)] + [Reference("audio", A1)] * 4
    issues = [i for i in validate_request(*KLING, {"prompt": PROMPT}, refs) if i.severity == "error"]
    assert [(i.code, i.field, i.limit, i.actual) for i in issues] == [
        ("too_many_references", "references.audio", 3, 4)]
    assert "audio clips" in issues[0].message


def test_audio_alone_is_rejected_without_saying_voice():
    issues = validate_request(*KLING, {"prompt": PROMPT}, [Reference("audio", A1)])
    issue = next(i for i in issues if i.code == "audio_only_not_allowed")
    assert "voice" not in issue.message.lower()
    assert issue.message == "Kling 4.0 on Kie needs at least one image or video alongside audio references."


def test_unknown_kind_lists_three_kinds():
    issue = validate_request(*KLING, {"prompt": PROMPT}, [Reference("image", I1), Reference("speech", A1)])[0]
    assert issue.code == "unknown_media_kind" and issue.message.endswith("Use one of: image, video, audio.")


def test_kling_flash_on_kie_rejects_audio():
    issues = validate_request("kie", "kling-4.0-flash", "omni_reference_to_video", {"prompt": PROMPT},
                              [Reference("image", I1), Reference("audio", A1)])
    assert codes(issues) == ["media_kind_not_accepted"]


# ------------------------------------------------------------------ Kie request body


def test_kie_kling_body_with_no_audio():
    body = build(*KLING, [Reference("image", I1), Reference("video", V1)])
    assert body == {"model": "kling-4.0/reference-to-video",
                    "input": {"prompt": PROMPT, "duration": 5, "resolution": "720p",
                              "image_urls": [I1], "video_urls": [V1], "keep_original_sound": False}}


def test_kie_kling_body_with_one_audio():
    body = build(*KLING, [Reference("image", I1), Reference("audio", A1)])
    assert body == {"model": "kling-4.0/reference-to-video",
                    "input": {"prompt": PROMPT, "duration": 5, "resolution": "720p", "image_urls": [I1],
                              "voices": [{"name": "sound_1", "audio_url": A1}]}}


def test_kie_kling_body_with_three_audio_numbered_in_request_order():
    refs = [Reference("audio", A1), Reference("image", I1), Reference("audio", A2), Reference("video", V1),
            Reference("image", I2), Reference("audio", A3)]
    body = build(*KLING, refs)
    assert body == {"model": "kling-4.0/reference-to-video",
                    "input": {"prompt": PROMPT, "duration": 5, "resolution": "720p",
                              "image_urls": [I1, I2], "video_urls": [V1], "keep_original_sound": False,
                              "voices": [{"name": "sound_1", "audio_url": A1},
                                         {"name": "sound_2", "audio_url": A2},
                                         {"name": "sound_3", "audio_url": A3}]}}


def test_kie_kling_voice_alias_sends_generated_names_only():
    body = build(*KLING, [{"kind": "image", "url": I1}, {"kind": "voice", "url": A1, "name": "Narrator"},
                          {"kind": "voice", "url": A2, "name": "Hero"}])
    assert body["input"]["voices"] == [{"name": "sound_1", "audio_url": A1}, {"name": "sound_2", "audio_url": A2}]
    assert "Narrator" not in json.dumps(body) and "Hero" not in json.dumps(body)
    assert "audio_urls" not in body["input"]


def test_piapi_seedance_and_kie_seedance_take_the_voice_alias_as_plain_audio():
    # PiAPI no longer offers Kling 4.0 Omni (test_byok_piapi_kling_omni.py); Seedance 2 is the PiAPI case.
    audio = build("piapi", "seedance-2", "omni_reference_to_video", [Reference("image", I1), Reference("audio", A1)])
    alias = build("piapi", "seedance-2", "omni_reference_to_video",
                  [{"kind": "image", "url": I1}, {"kind": "voice", "url": A1, "name": "Narrator"}])
    assert alias == audio and "voices" not in json.dumps(audio)
    sd = build("kie", "seedance-2", "omni_reference_to_video",
               [{"kind": "image", "url": I1}, {"kind": "voice", "url": A1, "name": "Narrator"}])
    assert sd["input"]["reference_audio_urls"] == [A1] and "voices" not in sd["input"]


def test_kling_flash_on_kie_refuses_audio_at_build_time():
    with pytest.raises(ProviderError) as exc:
        build("kie", "kling-4.0-flash", "omni_reference_to_video", [Reference("image", I1), Reference("audio", A1)])
    assert exc.value.kind == "validation"


# ------------------------------------------------------------------ pricing

# Captured from the ledger before the merge, with the same references sent as
# kind "voice" (bundled prices, no learned prices).
BEFORE_ESTIMATES = [
    ([{"kind": "image", "url": I1}, {"kind": "audio", "url": A1}], "720p", 142.5,
     "5 s × 28.5 credits/s at 720p"),
    ([{"kind": "image", "url": I1}, {"kind": "audio", "url": A1}], "1080p", 212.5,
     "5 s × 42.5 credits/s at 1080p"),
    ([{"kind": "image", "url": I1}, {"kind": "video", "url": V1, "duration_s": 5}]
     + [{"kind": "audio", "url": A1}] * 3, "720p", 170.0,
     "10 billable s (5 s output + 5 s input video) × 17 credits/s at 720p with video input"),
    ([{"kind": "image", "url": I1}, {"kind": "video", "url": V1, "duration_s": 5}]
     + [{"kind": "audio", "url": A1}] * 3, "1080p", 255.0,
     "10 billable s (5 s output + 5 s input video) × 25.5 credits/s at 1080p with video input"),
]


@pytest.mark.parametrize("refs,res,amount,basis", BEFORE_ESTIMATES)
def test_kling_kie_audio_estimates_match_the_old_voice_estimates(refs, res, amount, basis):
    params = {"prompt": PROMPT, "duration": 5, "resolution": res}
    est, why = pricing.explain_cost(*KLING, params, refs, use_observed=False)
    assert why is None and (est["amount"], est["unit"], est["basis"]) == (amount, "credits", basis)
    as_voice = [{**r, "kind": "voice", "name": "Hero"} if r["kind"] == "audio" else r for r in refs]
    assert pricing.explain_cost(*KLING, params, as_voice, use_observed=False) == (est, None)


# ------------------------------------------------------------------ routes

KIE_KEY = "kie-AUDIO-SECRET-1234567890"
FAST = RetryPolicy(max_attempts=1, base_delay_s=0, sleep=lambda s: None)


class FakeTransport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "body": body})
        item = self.responses.pop(0)
        return item if isinstance(item, HttpResponse) else HttpResponse(200, json.dumps(item).encode())


class _Resp(io.BytesIO):
    status = 200

    def __init__(self, data, ctype):
        super().__init__(data)
        self.headers = {"Content-Type": ctype}


@pytest.fixture
def env(tmp_path, monkeypatch):
    db_path = tmp_path / "run_history.db"
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    out = tmp_path / "output"
    out.mkdir()
    monkeypatch.setattr(output_folder, "_state", output_folder.pinned_state(out))
    for name in ("POLL_INITIAL_S", "POLL_MAX_S", "CANCEL_CHECK_S"):
        monkeypatch.setattr(service, name, 0)
    monkeypatch.setattr(service, "sleep", lambda s: None)
    monkeypatch.setattr(service, "open_url", lambda url, timeout: _Resp(b"VIDEO", "video/mp4"))
    transports: dict[str, FakeTransport] = {}
    monkeypatch.setattr(service, "adapter_factory",
                        lambda provider, **kw: get_adapter(provider, transport=transports[provider], retry=FAST))
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app) as client:
        yield client, transports
    service.shutdown()


def _body(kind, **extra):
    sound = {"kind": kind, "url": A1, **extra}
    return {"provider": "kie", "model": "kling-4.0", "mode": "omni_reference_to_video",
            "params": {"prompt": PROMPT, "duration": 5}, "references": [{"kind": "image", "url": I1}, sound]}


def test_validate_route_reads_voice_as_audio(env):
    client, _ = env
    for kind in ("audio", "voice"):
        r = client.post("/api/generation/validate", json=_body(kind, name="not a valid name!"))
        assert r.json() == {"ok": True, "issues": []}, kind
    # PiAPI no longer offers Kling 4.0 Omni (test_byok_piapi_kling_omni.py); Seedance 2 takes the alias there.
    piapi = {**_body("voice", name="Narrator"), "provider": "piapi", "model": "seedance-2"}
    assert client.post("/api/generation/validate", json=piapi).json() == {"ok": True, "issues": []}


def test_estimate_route_reads_voice_as_audio(env):
    client, _ = env
    audio = client.post("/api/generation/estimate", json=_body("audio")).json()
    voice = client.post("/api/generation/estimate", json=_body("voice", name="Hero")).json()
    assert audio["estimate"] is not None and audio["estimate"]["amount"] == 142.5
    assert voice == audio


def test_submit_route_stores_audio_and_sends_generated_names(env):
    client, transports = env
    settings_store.set_credential("kie_api_key", KIE_KEY)
    transports["kie"] = FakeTransport(
        {"code": 200, "msg": "success", "data": {"taskId": "t-a"}},
        {"code": 200, "data": {"state": "success", "resultJson": json.dumps({"resultUrls": [V1]})}})
    r = client.post("/api/generation/submit", json=_body("voice", name="Narrator"))
    assert r.status_code == 200, r.text
    job_id = r.json()["job"]["job_id"]
    stored = job_store.get_store().get_job(job_id)["request"]["references"]
    assert stored == [{"kind": "image", "url": I1}, {"kind": "audio", "url": A1}]
    assert service.wait_for_job(job_id, timeout=10)["status"] == "COMPLETED"
    create = next(c for c in transports["kie"].calls if c["url"].endswith("/createTask"))
    sent = json.loads(create["body"])
    assert sent["input"]["voices"] == [{"name": "sound_1", "audio_url": A1}]
    assert "Narrator" not in create["body"].decode()


def test_check_references_route_treats_voice_like_audio(env, monkeypatch):
    client, _ = env
    monkeypatch.setattr(references, "probe_transport", lambda *a, **k: HttpResponse(200, b""))
    refs = [{"kind": "audio", "url": A1}, {"kind": "voice", "url": A1, "name": "Hero"}]
    results = client.post("/api/generation/check-references", json={"references": refs}).json()["results"]
    assert [r["status"] for r in results] == ["ok", "ok"]
    assert results[0]["detail"] == results[1]["detail"]
