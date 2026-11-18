"""Update check: GitHub releases of the configured repository (backend/app_update/releases.py)."""

from __future__ import annotations

import json

import pytest

from backend.app_update import releases, settings, version
from backend.byok.errors import ProviderError
from backend.byok.http import HttpResponse

# ------------------------------------------------------------------ semver


@pytest.mark.parametrize("ordered", [
    ["0.1.0", "0.1.1", "0.2.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
     "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.10.0", "2.0.0"],
])
def test_semver_precedence(ordered):
    parsed = [version.parse(v) for v in ordered]
    assert sorted(parsed) == parsed
    assert all(a < b for a, b in zip(parsed, parsed[1:]))


@pytest.mark.parametrize("tag,expected", [
    ("v1.2.3", "1.2.3"), ("1.2.3", "1.2.3"), ("v1.2.3-beta.1", "1.2.3-beta.1"),
    ("v1.2.3+build.5", "1.2.3"), ("V1.2.3", None), ("v1.2", None), ("release-1", None), ("v01.2.3", None),
    ("v1.2.3-", None), ("v1.2.3-beta..1", None), ("", None), ("v1.2.3 ", None), ("latest", None),
])
def test_tag_parsing(tag, expected):
    parsed = version.parse_tag(tag)
    assert (str(parsed) if parsed else None) == expected


def test_build_metadata_does_not_change_precedence():
    assert version.parse("1.0.0+a") == version.parse("1.0.0+b")


def test_app_version_reads_package_json(tmp_path):
    (tmp_path / "package.json").write_text(json.dumps({"name": "x", "version": "0.3.0-beta.2"}))
    assert version.read_app_version(tmp_path) == "0.3.0-beta.2"
    (tmp_path / "package.json").write_text("{not json")
    assert version.read_app_version(tmp_path) == "0.0.0"


# ------------------------------------------------------------------ channel


@pytest.mark.parametrize("current,pref,expected", [
    ("0.1.15", None, "beta"), ("1.0.0-beta.1", None, "beta"), ("1.2.0", None, "stable"),
    ("1.2.0", "beta", "beta"), ("0.1.0", "stable", "stable"), ("1.2.0", "nonsense", "stable"),
])
def test_channel_default_and_pref(monkeypatch, current, pref, expected):
    monkeypatch.setattr(settings, "_pref", lambda name: pref if name == settings.CHANNEL_PREF else None)
    assert settings.channel(current) == expected


def test_repo_from_env_then_pref_then_default(monkeypatch):
    prefs = {}
    monkeypatch.setattr(settings, "_pref", lambda name: prefs.get(name))
    monkeypatch.delenv(settings.REPO_ENV, raising=False)
    assert settings.repo() == settings.DEFAULT_REPO == "Hearmeman24/Blockflow-Studio"
    prefs[settings.REPO_PREF] = "someone/fork"
    assert settings.repo() == "someone/fork"
    monkeypatch.setenv(settings.REPO_ENV, "other/repo")
    assert settings.repo() == "other/repo"
    monkeypatch.setenv(settings.REPO_ENV, "../../etc")
    assert settings.repo() == ""


# ------------------------------------------------------------------ picking a release


def _rel(tag, *, prerelease=False, draft=False, body="notes", name=None, published="2026-11-01T10:00:00Z"):
    return {"tag_name": tag, "name": name if name is not None else tag, "body": body, "draft": draft,
            "prerelease": prerelease, "published_at": published,
            "html_url": f"https://github.com/Hearmeman24/Blockflow-Studio/releases/tag/{tag}"}


def test_pick_newest_by_semver_not_list_order():
    raw = [_rel("v0.2.0"), _rel("v0.10.0"), _rel("v0.9.0")]
    picked = releases.pick_latest(releases.normalise(raw, "Hearmeman24/Blockflow-Studio"), channel="stable")
    assert picked["tag"] == "v0.10.0"


def test_stable_channel_skips_prereleases_by_flag_or_tag():
    raw = [_rel("v0.3.0-beta.1"), _rel("v0.2.5", prerelease=True), _rel("v0.2.0")]
    rels = releases.normalise(raw, "Hearmeman24/Blockflow-Studio")
    assert releases.pick_latest(rels, channel="stable")["tag"] == "v0.2.0"
    beta = releases.pick_latest(rels, channel="beta")
    assert beta["tag"] == "v0.3.0-beta.1"
    assert beta["prerelease"] is True


def test_drafts_and_odd_tags_are_ignored():
    raw = [_rel("v9.9.9", draft=True), _rel("nightly"), _rel("v1.2"), _rel("v0.2.0"), "garbage", {"tag_name": 5}]
    rels = releases.normalise(raw, "Hearmeman24/Blockflow-Studio")
    assert [r["tag"] for r in rels] == ["v0.2.0"]


def test_notes_are_plain_text_capped_and_links_pinned_to_the_repo():
    body = "<script>alert(1)</script>\x00\x07 fixed things\r\n" + "x" * 50_000
    raw = [{**_rel("v0.2.0", body=body, name="<b>v0.2</b>" + "n" * 500), "html_url": "https://evil.example/x"}]
    rel = releases.normalise(raw, "Hearmeman24/Blockflow-Studio")[0]
    assert "\x00" not in rel["notes"] and "\x07" not in rel["notes"] and "\r" not in rel["notes"]
    assert rel["notes"].startswith("<script>alert(1)</script>")  # kept as text; the UI never renders HTML
    assert len(rel["notes"]) <= releases.MAX_NOTES
    assert rel["notes_truncated"] is True
    assert len(rel["name"]) <= releases.MAX_NAME
    assert rel["url"] == "https://github.com/Hearmeman24/Blockflow-Studio/releases/tag/v0.2.0"


# ------------------------------------------------------------------ fetching


class FakeTransport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "headers": dict(headers), "timeout": timeout})
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


@pytest.fixture
def checker(tmp_path, monkeypatch):
    prefs = {}
    monkeypatch.setattr(settings, "_pref", lambda name: prefs.get(name))
    monkeypatch.delenv(settings.REPO_ENV, raising=False)
    clock = {"now": 1_000_000.0}
    c = releases.UpdateChecker(cache_dir=tmp_path / "updates", current_version="0.1.15",
                               transport=FakeTransport(), clock=lambda: clock["now"])
    c.prefs = prefs
    c.clock_state = clock
    return c


def _ok(items, etag='"abc"'):
    return HttpResponse(200, json.dumps(items).encode(), {"ETag": etag, "Content-Type": "application/json"})


def test_check_reports_the_newest_update(checker):
    checker.transport = FakeTransport(_ok([_rel("v0.1.15"), _rel("v0.2.0-beta.1", prerelease=True)]))
    out = checker.status(force=True)
    assert out["status"] == "ok"
    assert out["update_available"] is True
    assert out["latest"]["version"] == "0.2.0-beta.1"
    assert out["latest"]["tag"] == "v0.2.0-beta.1"
    assert out["current"] == "0.1.15"
    assert out["channel"] == "beta"
    call = checker.transport.calls[0]
    assert call["url"] == "https://api.github.com/repos/Hearmeman24/Blockflow-Studio/releases?per_page=30"
    assert call["method"] == "GET"
    assert call["timeout"] <= 10
    # Nothing about the user: a generic agent, no auth, no cookies.
    assert call["headers"]["User-Agent"] == releases.USER_AGENT
    assert not any(h.lower() in ("authorization", "cookie") for h in call["headers"])


def test_no_update_when_latest_is_not_newer(checker):
    checker.transport = FakeTransport(_ok([_rel("v0.1.15"), _rel("v0.1.2")]))
    out = checker.status(force=True)
    assert out["update_available"] is False
    assert out["latest"]["tag"] == "v0.1.15"


def test_checks_are_cached_for_six_hours_then_conditional(checker):
    checker.transport = FakeTransport(_ok([_rel("v0.2.0")]), HttpResponse(304, b"", {}))
    first = checker.status()
    assert first["latest"]["tag"] == "v0.2.0"
    checker.clock_state["now"] += 3600
    again = checker.status()
    assert len(checker.transport.calls) == 1  # not due yet: served from the cache
    assert again["latest"]["tag"] == "v0.2.0"
    checker.clock_state["now"] += 6 * 3600
    later = checker.status()
    assert len(checker.transport.calls) == 2
    assert checker.transport.calls[1]["headers"]["If-None-Match"] == '"abc"'
    assert later["latest"]["tag"] == "v0.2.0"
    assert later["status"] == "ok"
    assert later["checked_at"] == checker.clock_state["now"]


def test_cache_survives_a_restart(checker, tmp_path):
    checker.transport = FakeTransport(_ok([_rel("v0.2.0")]))
    checker.status(force=True)
    fresh = releases.UpdateChecker(cache_dir=tmp_path / "updates", current_version="0.1.15",
                                   transport=FakeTransport(), clock=lambda: checker.clock_state["now"] + 60)
    out = fresh.status()
    assert out["latest"]["tag"] == "v0.2.0"
    assert fresh.transport.calls == []


def test_cache_for_another_repo_is_not_used(checker):
    checker.transport = FakeTransport(_ok([_rel("v0.2.0")]))
    checker.status(force=True)
    checker.prefs[settings.REPO_PREF] = "someone/fork"
    checker.transport = FakeTransport(HttpResponse(304, b"", {}))
    out = checker.status(force=True)
    assert "If-None-Match" not in checker.transport.calls[0]["headers"]
    assert out["latest"] is None


@pytest.mark.parametrize("response,status", [
    (HttpResponse(404, b'{"message":"Not Found"}', {}), "not_found"),
    (HttpResponse(403, b'{"message":"API rate limit exceeded"}', {"X-RateLimit-Remaining": "0"}), "rate_limited"),
    (HttpResponse(429, b"", {}), "rate_limited"),
    (HttpResponse(500, b"", {}), "error"),
    (ProviderError("network", "down"), "offline"),
    (ProviderError("timeout", "slow"), "offline"),
    (HttpResponse(200, b"not json", {}), "invalid"),
    (HttpResponse(200, b"x" * (releases.MAX_BYTES + 1), {}), "too_large"),
])
def test_failures_are_quiet_statuses(checker, response, status, caplog):
    checker.transport = FakeTransport(response)
    out = checker.status(force=True)
    assert out["status"] == status
    assert out["update_available"] is False
    assert isinstance(out["message"], str) and out["message"]
    assert not [r for r in caplog.records if r.levelname in ("ERROR", "CRITICAL")]


def test_a_failure_keeps_the_last_good_result(checker):
    checker.transport = FakeTransport(_ok([_rel("v0.2.0")]), ProviderError("network", "down"))
    checker.status(force=True)
    out = checker.status(force=True)
    assert out["status"] == "offline"
    assert out["latest"]["tag"] == "v0.2.0"
    assert out["update_available"] is True


def test_turning_checks_off_makes_no_request(checker):
    checker.prefs[settings.CHECKS_PREF] = "false"
    checker.transport = FakeTransport()
    out = checker.status(force=True)
    assert out["status"] == "disabled"
    assert checker.transport.calls == []


def test_channel_change_applies_to_cached_releases(checker):
    checker.transport = FakeTransport(_ok([_rel("v0.1.16"), _rel("v0.2.0-beta.1", prerelease=True)]))
    assert checker.status(force=True)["latest"]["tag"] == "v0.2.0-beta.1"
    checker.prefs[settings.CHANNEL_PREF] = "stable"
    out = checker.status()
    assert out["channel"] == "stable"
    assert out["latest"]["tag"] == "v0.1.16"


def test_skip_and_snooze_hide_the_notice_but_not_the_update(checker):
    checker.transport = FakeTransport(_ok([_rel("v0.2.0")]))
    assert checker.status(force=True)["notify"] is True
    checker.prefs[settings.SKIP_PREF] = "v0.2.0"
    out = checker.status()
    assert out["update_available"] is True and out["notify"] is False and out["dismissed"] == "skipped"
    checker.prefs[settings.SKIP_PREF] = "v0.1.99"
    checker.prefs[settings.SNOOZE_PREF] = json.dumps({"tag": "v0.2.0", "until": checker.clock_state["now"] + 10})
    out = checker.status()
    assert out["notify"] is False and out["dismissed"] == "snoozed"
    checker.clock_state["now"] += 11
    assert checker.status()["notify"] is True
