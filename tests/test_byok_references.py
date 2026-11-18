"""Reference resolution (output-dir sandbox) and reference health checks."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import output_folder  # noqa: E402
from backend.byok import references  # noqa: E402
from backend.byok.errors import ProviderError  # noqa: E402
from backend.byok.http import HttpResponse  # noqa: E402


@pytest.fixture
def out(tmp_path, monkeypatch):
    root = tmp_path / "output"
    root.mkdir()
    monkeypatch.setattr(output_folder, "_state", output_folder.pinned_state(root))
    return root


class ProbeTransport:
    """Maps (method, url) -> HttpResponse | Exception | status int. Records calls."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "headers": dict(headers), "timeout": timeout})
        item = self.routes.get((method, url))
        if item is None:
            item = self.routes.get(url, 404)
        if isinstance(item, BaseException):
            raise item
        if isinstance(item, int):
            return HttpResponse(item, b"")
        return item


# ------------------------------------------------------------------ resolve_local


def test_resolve_outputs_url_path_to_file(out):
    (out / "byok").mkdir()
    f = out / "byok" / "a.png"
    f.write_bytes(b"png")
    assert references.resolve_local("/outputs/byok/a.png") == f.resolve()


def test_resolve_percent_encoded_unicode_name(out):
    f = out / "café ☕.png"
    f.write_bytes(b"x")
    assert references.resolve_local("/outputs/caf%C3%A9%20%E2%98%95.png") == f.resolve()
    assert references.resolve_local("/outputs/café ☕.png") == f.resolve()


def test_resolve_absolute_path_inside_output_dir(out):
    f = out / "b.mp4"
    f.write_bytes(b"x")
    assert references.resolve_local(str(f)) == f.resolve()


def test_resolve_relative_path_is_relative_to_output_dir(out):
    f = out / "c.png"
    f.write_bytes(b"x")
    assert references.resolve_local("c.png") == f.resolve()


def test_resolve_nonexistent_file_inside_sandbox_returns_path(out):
    # Resolution is about safety; existence is checked separately.
    assert references.resolve_local("/outputs/missing.png") == (out / "missing.png").resolve()


@pytest.mark.parametrize("value", [
    "/outputs/../secret.txt",
    "/outputs/byok/../../secret.txt",
    "/outputs/%2e%2e/secret.txt",
    "/outputs/..%2Fsecret.txt",
    "../secret.txt",
    "/etc/passwd",
    "file:///etc/passwd",
    "https://example.com/a.png",
    "",
    "   ",
    "/outputs/a\x00.png",
    "/outputs/",
])
def test_resolve_rejects_paths_outside_output_dir(out, value):
    (out.parent / "secret.txt").write_text("top secret")
    with pytest.raises(references.UnsafePathError):
        references.resolve_local(value)


def test_resolve_rejects_symlink_pointing_outside(out):
    secret = out.parent / "secret.txt"
    secret.write_text("top secret")
    os.symlink(secret, out / "link.txt")
    with pytest.raises(references.UnsafePathError):
        references.resolve_local("/outputs/link.txt")


def test_resolve_rejects_symlinked_directory_pointing_outside(out):
    elsewhere = out.parent / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "x.png").write_bytes(b"x")
    os.symlink(elsewhere, out / "dir")
    with pytest.raises(references.UnsafePathError):
        references.resolve_local("/outputs/dir/x.png")


def test_resolve_allows_symlink_that_stays_inside(out):
    real = out / "real.png"
    real.write_bytes(b"x")
    os.symlink(real, out / "alias.png")
    assert references.resolve_local("/outputs/alias.png") == real.resolve()


def test_resolve_rejects_non_string(out):
    with pytest.raises(references.UnsafePathError):
        references.resolve_local(None)  # type: ignore[arg-type]


def test_local_file_returns_none_for_missing_or_directory(out):
    (out / "d").mkdir()
    assert references.local_file("/outputs/nope.png") is None
    assert references.local_file("/outputs/d") is None
    f = out / "ok.png"
    f.write_bytes(b"x")
    assert references.local_file("/outputs/ok.png") == f.resolve()


# ------------------------------------------------------------------ check_references


def _statuses(results):
    return [(r["index"], r["status"]) for r in results]


def test_check_local_file_ok_without_network(out):
    (out / "a.png").write_bytes(b"x")
    t = ProbeTransport({})
    results = references.check_references([{"kind": "image", "local": "/outputs/a.png",
                                             "url": "https://gone.test/a.png"}], transport=t)
    assert _statuses(results) == [(0, "ok")]
    assert t.calls == []


def test_check_url_field_holding_local_path(out):
    (out / "a.png").write_bytes(b"x")
    results = references.check_references([{"kind": "image", "url": "/outputs/a.png"}],
                                           transport=ProbeTransport({}))
    assert _statuses(results) == [(0, "ok")]


def test_check_missing_local_without_url(out):
    results = references.check_references([{"kind": "image", "local": "/outputs/gone.png"}],
                                           transport=ProbeTransport({}))
    assert _statuses(results) == [(0, "missing_local")]
    assert "gone.png" in results[0]["detail"]


def test_check_missing_local_falls_back_to_reachable_url(out):
    t = ProbeTransport({"https://cdn.test/a.png": 200})
    results = references.check_references([{"kind": "image", "local": "/outputs/gone.png",
                                             "url": "https://cdn.test/a.png"}], transport=t)
    assert _statuses(results) == [(0, "ok")]
    assert "local" in results[0]["detail"].lower()


def test_check_missing_local_with_expired_url_reports_expired(out):
    t = ProbeTransport({"https://cdn.test/a.png": 404})
    results = references.check_references([{"kind": "image", "local": "/outputs/gone.png",
                                             "url": "https://cdn.test/a.png"}], transport=t)
    assert _statuses(results) == [(0, "expired")]


@pytest.mark.parametrize("status,expected", [
    (200, "ok"), (204, "ok"), (206, "ok"),
    (401, "expired"), (404, "expired"), (410, "expired"),
    (500, "unreachable"), (502, "unreachable"), (503, "unreachable"),
])
def test_check_http_status_mapping(out, status, expected):
    url = "https://cdn.test/v.mp4"
    t = ProbeTransport({("HEAD", url): status, ("GET", url): status})
    results = references.check_references([{"kind": "video", "url": url}], transport=t)
    assert _statuses(results) == [(0, expected)]
    assert t.calls[0]["method"] == "HEAD"
    assert t.calls[0]["timeout"] <= references.PROBE_TIMEOUT_S


@pytest.mark.parametrize("head_status", [403, 405, 501])
def test_check_falls_back_to_ranged_get_when_head_not_allowed(out, head_status):
    url = "https://signed.test/a.png?sig=abc"
    t = ProbeTransport({("HEAD", url): head_status, ("GET", url): 206})
    results = references.check_references([{"kind": "image", "url": url}], transport=t)
    assert _statuses(results) == [(0, "ok")]
    assert [c["method"] for c in t.calls] == ["HEAD", "GET"]
    assert t.calls[1]["headers"]["Range"] == "bytes=0-0"


def test_check_ranged_get_403_is_expired(out):
    url = "https://signed.test/a.png"
    t = ProbeTransport({("HEAD", url): 403, ("GET", url): 403})
    assert _statuses(references.check_references([{"kind": "image", "url": url}], transport=t)) == [(0, "expired")]


@pytest.mark.parametrize("exc", [
    ProviderError("network", "Could not reach the provider (gaierror).", retryable=True),
    ProviderError("timeout", "The provider did not respond in time.", retryable=True),
    TimeoutError("slow"),
    OSError("connection refused"),
])
def test_check_network_errors_are_unreachable(out, exc):
    url = "https://down.test/a.png"
    t = ProbeTransport({("HEAD", url): exc})
    results = references.check_references([{"kind": "image", "url": url}], transport=t)
    assert _statuses(results) == [(0, "unreachable")]


@pytest.mark.parametrize("ref", [
    {"kind": "image", "url": "ftp://files.test/a.png"},
    {"kind": "image", "url": "file:///etc/passwd"},
    {"kind": "image", "url": "javascript:alert(1)"},
    {"kind": "image", "url": "https://"},
    {"kind": "image", "url": "http:// spaces.test/a b.png"},
    {"kind": "image", "url": "/outputs/../../etc/passwd"},
    {"kind": "image", "local": "/etc/passwd"},
    {"kind": "image"},
    {"kind": "image", "url": 42},
    "not-a-dict",
    None,
])
def test_check_malformed(out, ref):
    t = ProbeTransport({})
    results = references.check_references([ref], transport=t)
    assert _statuses(results) == [(0, "malformed")]
    assert results[0]["detail"]
    assert t.calls == []


def test_check_keeps_order_and_count_for_mixed_list(out):
    (out / "a.png").write_bytes(b"x")
    t = ProbeTransport({"https://ok.test/1.png": 200, "https://gone.test/2.png": 410,
                        ("HEAD", "https://down.test/3.png"): OSError("down")})
    refs = [
        {"kind": "image", "local": "/outputs/a.png"},
        {"kind": "image", "url": "https://ok.test/1.png"},
        {"kind": "image", "url": "https://gone.test/2.png"},
        {"kind": "image", "url": "https://down.test/3.png"},
        {"kind": "image", "local": "/outputs/missing.png"},
        {"kind": "image", "url": "nope://x"},
    ]
    results = references.check_references(refs, transport=t)
    assert _statuses(results) == [(0, "ok"), (1, "ok"), (2, "expired"), (3, "unreachable"),
                                  (4, "missing_local"), (5, "malformed")]


def test_check_empty_list(out):
    assert references.check_references([], transport=ProbeTransport({})) == []


def test_check_detail_never_echoes_query_string_secrets(out):
    url = "https://signed.test/a.png?X-Amz-Signature=deadbeefsecret"
    t = ProbeTransport({("HEAD", url): 404})
    results = references.check_references([{"kind": "image", "url": url}], transport=t)
    assert "deadbeefsecret" not in results[0]["detail"]


@pytest.mark.parametrize("url", ["asset://abc123", "ASSET://lib/asset-9", "  asset://abc  "])
def test_check_provider_asset_is_unchecked_without_network(out, url):
    t = ProbeTransport({})
    results = references.check_references([{"kind": "image", "url": url}], transport=t)
    assert _statuses(results) == [(0, "unchecked")]
    detail = results[0]["detail"].lower()
    assert "provider asset" in detail and "not verified" in detail
    assert t.calls == []


@pytest.mark.parametrize("url", ["asset://", "asset:// ", "asset://a b", "asset:abc"])
def test_check_invalid_asset_values_stay_malformed(out, url):
    results = references.check_references([{"kind": "image", "url": url}], transport=ProbeTransport({}))
    assert _statuses(results) == [(0, "malformed")]


def test_check_missing_local_with_asset_url_is_unchecked(out):
    results = references.check_references([{"kind": "image", "local": "/outputs/gone.png",
                                             "url": "asset://abc"}], transport=ProbeTransport({}))
    assert _statuses(results) == [(0, "unchecked")]
    assert "gone.png" in results[0]["detail"]


def test_unchecked_is_a_documented_status():
    assert "unchecked" in references.STATUSES
