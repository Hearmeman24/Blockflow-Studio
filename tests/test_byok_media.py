"""Media preparation: pass-through, provider upload, tmpfiles fallback."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.byok.errors import ProviderError  # noqa: E402
from backend.byok.media import prepare_reference, prepare_references  # noqa: E402
from backend.byok.spec import Reference  # noqa: E402

KEY = "sk-media-FAKE-0000"


class Recorder:
    def __init__(self, result="https://up.test/file", error=None):
        self.result, self.error, self.calls = result, error, []

    def __call__(self, *args):
        self.calls.append(args)
        if self.error:
            raise self.error
        return self.result


@pytest.mark.parametrize("url", ["https://cdn.test/a.png", "http://cdn.test/a.png", "asset://asset-2026-x",
                                 "HTTPS://CDN.TEST/A.PNG"])
def test_public_and_asset_urls_pass_through(url):
    up, fb = Recorder(), Recorder()
    assert prepare_reference(Reference("image", url), "kie", KEY, uploader=up, fallback_uploader=fb) == url
    assert up.calls == [] and fb.calls == []


def test_local_file_uploaded_through_provider(tmp_path):
    f = tmp_path / "a.png"
    f.write_bytes(b"x")
    up, fb = Recorder("https://kie.test/a.png"), Recorder()
    url = prepare_reference(Reference("image", str(f)), "kie", KEY, uploader=up, fallback_uploader=fb)
    assert url == "https://kie.test/a.png"
    assert up.calls == [(f, KEY)] and fb.calls == []


def test_outputs_path_resolved_through_resolver(tmp_path):
    f = tmp_path / "gen" / "x.mp4"
    f.parent.mkdir()
    f.write_bytes(b"x")
    up = Recorder("https://kie.test/x.mp4")
    url = prepare_reference(Reference("video", "/outputs/gen/x.mp4"), "kie", KEY, uploader=up,
                            resolve_local=lambda u: tmp_path / u.split("/outputs/", 1)[1])
    assert url == "https://kie.test/x.mp4" and up.calls[0][0] == f


@pytest.mark.parametrize("code", ["plan_required", "file_too_large", "unsupported_file_type"])
def test_falls_back_to_tmpfiles_when_provider_upload_unavailable(tmp_path, code):
    f = tmp_path / "a.mov"
    f.write_bytes(b"x")
    up = Recorder(error=ProviderError("unsupported", "no", provider="piapi", provider_code=code))
    fb = Recorder("https://tmpfiles.org/dl/1.ab/a.mov")
    url = prepare_reference(Reference("video", str(f)), "piapi", KEY, uploader=up, fallback_uploader=fb)
    assert url == "https://tmpfiles.org/dl/1.ab/a.mov"
    assert fb.calls == [(f,)]


@pytest.mark.parametrize("kind", ["auth", "network", "rate_limited", "provider_failure"])
def test_other_upload_errors_do_not_fall_back(tmp_path, kind):
    f = tmp_path / "a.png"
    f.write_bytes(b"x")
    up = Recorder(error=ProviderError(kind, "fail", provider="kie"))
    fb = Recorder()
    with pytest.raises(ProviderError) as exc:
        prepare_reference(Reference("image", str(f)), "kie", KEY, uploader=up, fallback_uploader=fb)
    assert exc.value.kind == kind and fb.calls == []


def test_fallback_failure_is_normalised(tmp_path):
    f = tmp_path / "a.png"
    f.write_bytes(b"x")
    up = Recorder(error=ProviderError("unsupported", "no", provider_code="plan_required"))
    fb = Recorder(error=RuntimeError("tmpfiles upload failed: {}"))
    with pytest.raises(ProviderError) as exc:
        prepare_reference(Reference("image", str(f)), "piapi", KEY, uploader=up, fallback_uploader=fb)
    assert exc.value.kind == "network" and exc.value.retryable is True


def test_missing_file_and_empty_url(tmp_path):
    with pytest.raises(ProviderError) as exc:
        prepare_reference(Reference("image", str(tmp_path / "nope.png")), "kie", KEY, uploader=Recorder())
    assert exc.value.kind == "validation" and "nope.png" in exc.value.message
    with pytest.raises(ProviderError):
        prepare_reference(Reference("image", "  "), "kie", KEY, uploader=Recorder())


def test_prepare_references_keeps_order_count_metadata_and_does_not_mutate(tmp_path):
    f = tmp_path / "v.mp3"
    f.write_bytes(b"x")
    refs = [Reference("image", "https://cdn.test/1.png", "first_frame"),
            Reference("audio", str(f), duration_s=6.0),
            Reference("image", "https://cdn.test/2.png", "last_frame")]
    out = prepare_references(refs, "kie", KEY, uploader=Recorder("https://kie.test/v.mp3"))
    assert [r.url for r in out] == ["https://cdn.test/1.png", "https://kie.test/v.mp3", "https://cdn.test/2.png"]
    assert out[1].kind == "audio" and out[1].duration_s == 6.0 and out[0].role == "first_frame"
    assert refs[1].url == str(f)
