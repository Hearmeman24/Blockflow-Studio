"""Remote price-ledger refresh (backend/byok/price_sources.py) with a fake transport."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import db, settings_store  # noqa: E402
from backend.byok import price_ledger, price_sources  # noqa: E402
from backend.byok.errors import ProviderError  # noqa: E402
from backend.byok.http import HttpResponse  # noqa: E402

URL = "https://example.test/prices/prices.json"


def ledger_body(generated_at="2099-01-01T00:00:00Z", amount=41.0) -> dict:
    data = json.loads(price_ledger.BUNDLED_PATH.read_text())
    data["generated_at"] = generated_at
    for e in data["entries"]:
        if e["provider"] == "kie" and e["model"] == "bytedance/seedance-2" and e["resolution"] == "720p" \
                and e["variant"] is None:
            e["amount"] = amount
    return data


class FakeTransport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "headers": dict(headers), "timeout": timeout})
        item = self.responses.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


def ok(data, headers=None) -> HttpResponse:
    return HttpResponse(200, json.dumps(data).encode(), headers or {})


@pytest.fixture
def env(tmp_path, monkeypatch):
    db_path = tmp_path / "run_history.db"
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    monkeypatch.setattr(price_sources, "CACHE_DIR", tmp_path / "price_ledger")
    monkeypatch.delenv(price_sources.URL_ENV, raising=False)
    monkeypatch.delenv(price_sources.REPO_ENV, raising=False)
    now = [1_000_000.0]
    monkeypatch.setattr(price_sources, "clock", lambda: now[0])
    monkeypatch.setattr(price_sources, "AUTO_REFRESH", False)
    price_sources.reset_state()
    transport = FakeTransport()
    monkeypatch.setattr(price_sources, "transport", transport)
    yield transport, now, monkeypatch, tmp_path
    price_sources.reset_state()


def configure(monkeypatch):
    monkeypatch.setenv(price_sources.URL_ENV, URL)


# ------------------------------------------------------------------ configuration


DEFAULT_URL = "https://raw.githubusercontent.com/Hearmeman24/blockflow-prices/main/prices.json"


def test_defaults_point_at_the_ledger_repository(env):
    assert price_sources.PRICE_LEDGER_URL == DEFAULT_URL
    assert price_sources.PRICE_LEDGER_REPO == "Hearmeman24/blockflow-prices"
    assert price_sources.configured_url() == DEFAULT_URL
    assert price_sources.configured_repo() == "Hearmeman24/blockflow-prices"


@pytest.mark.parametrize("where", ["env", "pref"])
def test_an_empty_override_turns_the_remote_layer_off(env, where):
    transport, _, monkeypatch, _ = env
    if where == "env":
        monkeypatch.setenv(price_sources.URL_ENV, "")
        monkeypatch.setenv(price_sources.REPO_ENV, "")
    else:
        settings_store.set_app_pref(price_sources.URL_PREF, "")
        settings_store.set_app_pref(price_sources.REPO_PREF, "")
    assert price_sources.configured_url() == "" and price_sources.configured_repo() == ""
    assert price_sources.refresh(force=True)["status"] == "not_configured"
    assert transport.calls == []
    ledger, layer = price_sources.active_ledger()
    assert layer == "bundled" and ledger.entries


def test_a_404_from_the_default_url_is_quiet(env, caplog):
    transport, _, _, _ = env
    transport.responses = [HttpResponse(404, b"404: Not Found", {})]
    with caplog.at_level("DEBUG"):
        result = price_sources.refresh(force=True)
    assert transport.calls[0]["url"] == DEFAULT_URL
    assert result["status"] == "not_available" and result["ok"] is False
    assert "not available yet" in result["message"]
    assert price_sources.active_ledger()[1] == "bundled"
    assert price_sources.status()["last_refresh"]["status"] == "not_available"
    assert not [r for r in caplog.records if r.levelname in ("WARNING", "ERROR")]


@pytest.mark.parametrize("value", ["http://example.test/p.json", "ftp://x/y", "https://user:pw@x.test/p.json",
                                   "not a url", "https://"])
def test_invalid_urls_are_ignored(env, value):
    _, _, monkeypatch, _ = env
    monkeypatch.setenv(price_sources.URL_ENV, value)
    assert price_sources.configured_url() == ""


def test_url_and_repo_from_prefs_and_env_precedence(env):
    _, _, monkeypatch, _ = env
    settings_store.set_app_pref(price_sources.URL_PREF, URL)
    settings_store.set_app_pref(price_sources.REPO_PREF, "someone/prices")
    assert price_sources.configured_url() == URL
    assert price_sources.configured_repo() == "someone/prices"
    monkeypatch.setenv(price_sources.URL_ENV, "https://other.test/p.json")
    monkeypatch.setenv(price_sources.REPO_ENV, "org/repo.name")
    assert price_sources.configured_url() == "https://other.test/p.json"
    assert price_sources.configured_repo() == "org/repo.name"
    monkeypatch.setenv(price_sources.REPO_ENV, "not a repo")
    settings_store.set_app_pref(price_sources.REPO_PREF, "../etc")
    assert price_sources.configured_repo() == ""


# ------------------------------------------------------------------ refresh


def test_200_validates_caches_and_activates(env):
    transport, _, monkeypatch, tmp = env
    configure(monkeypatch)
    transport.responses = [ok(ledger_body(amount=50), {"ETag": '"v1"', "Last-Modified": "Sun, 15 Nov 2099 00:00:00 GMT"})]
    result = price_sources.refresh(force=True)
    assert result["ok"] is True and result["status"] == "updated"
    call = transport.calls[0]
    assert (call["method"], call["url"]) == ("GET", URL)
    assert call["timeout"] <= 15
    assert set(call["headers"]) <= {"Accept", "User-Agent", "If-None-Match", "If-Modified-Since"}
    assert "If-None-Match" not in call["headers"]
    ledger, layer = price_sources.active_ledger()
    assert layer == "ledger"
    assert ledger.find("kie", "bytedance/seedance-2", "credits_per_second", "720p", None).amount == 50
    assert (tmp / "price_ledger" / "prices.json").is_file()


def test_304_reuses_the_cache_with_conditional_headers(env):
    transport, now, monkeypatch, _ = env
    configure(monkeypatch)
    transport.responses = [ok(ledger_body(amount=50), {"ETag": '"v1"', "Last-Modified": "Sun, 15 Nov 2099 00:00:00 GMT"}),
                           HttpResponse(304, b"", {})]
    price_sources.refresh(force=True)
    now[0] += 60
    result = price_sources.refresh(force=True)
    assert result["status"] == "not_modified" and result["ok"] is True
    headers = transport.calls[1]["headers"]
    assert headers["If-None-Match"] == '"v1"'
    assert headers["If-Modified-Since"] == "Sun, 15 Nov 2099 00:00:00 GMT"
    assert price_sources.active_ledger()[1] == "ledger"


def test_cache_survives_a_restart(env):
    transport, _, monkeypatch, _ = env
    configure(monkeypatch)
    transport.responses = [ok(ledger_body(amount=50))]
    price_sources.refresh(force=True)
    price_sources.reset_state()  # a new process: memory gone, files kept
    ledger, layer = price_sources.active_ledger()
    assert layer == "ledger"
    assert ledger.find("kie", "bytedance/seedance-2", "credits_per_second", "720p", None).amount == 50


def test_refresh_is_throttled_to_twelve_hours_unless_forced(env):
    transport, now, monkeypatch, _ = env
    configure(monkeypatch)
    transport.responses = [ok(ledger_body()), HttpResponse(304, b"", {})]
    price_sources.refresh()
    assert price_sources.refresh()["status"] == "skipped"
    now[0] += 11 * 3600
    assert price_sources.refresh()["status"] == "skipped"
    now[0] += 2 * 3600
    assert price_sources.refresh()["status"] == "not_modified"
    assert len(transport.calls) == 2


@pytest.mark.parametrize("response,status", [
    (ProviderError("timeout", "The provider did not respond in time."), "error"),
    (HttpResponse(500, b"oops", {}), "error"),
    (HttpResponse(200, b"{nope", {}), "invalid"),
    (HttpResponse(200, json.dumps({"schema_version": 1, "entries": []}).encode(), {}), "invalid"),
    (HttpResponse(200, b"x" * (price_sources.MAX_BYTES + 1), {}), "too_large"),
    (HttpResponse(200, b"{}", {"Content-Length": str(price_sources.MAX_BYTES + 5)}), "too_large"),
])
def test_failures_fall_back_and_never_raise(env, response, status):
    transport, _, monkeypatch, _ = env
    configure(monkeypatch)
    transport.responses = [response]
    result = price_sources.refresh(force=True)
    assert result["ok"] is False and result["status"] == status
    assert price_sources.active_ledger()[1] == "bundled"


def test_failure_keeps_a_previously_cached_ledger(env):
    transport, _, monkeypatch, _ = env
    configure(monkeypatch)
    transport.responses = [ok(ledger_body(amount=50)), HttpResponse(200, b"{broken", {})]
    price_sources.refresh(force=True)
    price_sources.refresh(force=True)
    assert price_sources.active_ledger()[1] == "ledger"


def test_a_remote_ledger_older_than_the_bundled_one_is_ignored(env):
    transport, _, monkeypatch, _ = env
    configure(monkeypatch)
    transport.responses = [ok(ledger_body(generated_at="2020-01-01T00:00:00Z"))]
    result = price_sources.refresh(force=True)
    assert result["status"] == "older_than_bundled"
    assert price_sources.active_ledger()[1] == "bundled"


def test_disabled_by_pref(env):
    transport, _, monkeypatch, _ = env
    configure(monkeypatch)
    transport.responses = [ok(ledger_body(amount=50))]
    price_sources.refresh(force=True)
    settings_store.set_app_pref(price_sources.UPDATES_PREF, "false")
    assert price_sources.refresh(force=True)["status"] == "disabled"
    assert len(transport.calls) == 1
    # the downloaded copy is not used while updates are off
    assert price_sources.active_ledger()[1] == "bundled"


def test_a_cache_from_another_url_is_not_used(env):
    transport, _, monkeypatch, _ = env
    configure(monkeypatch)
    transport.responses = [ok(ledger_body(amount=50))]
    price_sources.refresh(force=True)
    monkeypatch.setenv(price_sources.URL_ENV, "https://elsewhere.test/p.json")
    price_sources.reset_state()
    assert price_sources.active_ledger()[1] == "bundled"


def test_a_corrupt_cache_file_falls_back_to_bundled(env):
    transport, _, monkeypatch, tmp = env
    configure(monkeypatch)
    transport.responses = [ok(ledger_body(amount=50))]
    price_sources.refresh(force=True)
    (tmp / "price_ledger" / "prices.json").write_text("{garbage")
    price_sources.reset_state()
    assert price_sources.active_ledger()[1] == "bundled"


def test_status_reports_layers_and_last_result(env):
    transport, _, monkeypatch, _ = env
    st = price_sources.status()
    assert st["active"] == "bundled"
    assert st["remote"] == {"configured": True, "enabled": True, "url": DEFAULT_URL,
                            "repo": "Hearmeman24/blockflow-prices", "refresh_interval_hours": 12}
    monkeypatch.setenv(price_sources.URL_ENV, "")
    monkeypatch.setenv(price_sources.REPO_ENV, "")
    st = price_sources.status()
    assert st["remote"] == {"configured": False, "enabled": True, "url": "", "repo": "",
                            "refresh_interval_hours": 12}
    assert st["ledger"]["schema_version"] == 1 and st["ledger"]["generated_at"]
    assert st["last_refresh"] is None
    configure(monkeypatch)
    transport.responses = [ok(ledger_body(amount=50))]
    price_sources.refresh(force=True)
    st = price_sources.status()
    assert st["active"] == "ledger"
    assert st["remote"]["configured"] is True and st["remote"]["url"] == URL
    assert st["ledger"]["generated_at"] == "2099-01-01T00:00:00Z"
    assert st["bundled"]["generated_at"] != st["ledger"]["generated_at"]
    assert st["last_refresh"]["status"] == "updated"


# ------------------------------------------------------------------ refresh state machine


def test_a_failed_refresh_is_retried_after_the_short_interval(env):
    transport, now, monkeypatch, _ = env
    configure(monkeypatch)
    transport.responses = [ProviderError("network", "down"), ok(ledger_body(amount=50))]
    assert price_sources.refresh()["status"] == "error"
    assert price_sources.RETRY_AFTER_FAILURE_S < price_sources.REFRESH_INTERVAL_S
    assert price_sources.RETRY_AFTER_FAILURE_S <= 30 * 60
    now[0] += price_sources.RETRY_AFTER_FAILURE_S - 1
    assert price_sources.refresh()["status"] == "skipped"
    now[0] += 1
    assert price_sources.refresh()["status"] == "updated"
    assert len(transport.calls) == 2
    # after a success the long interval applies again
    now[0] += price_sources.RETRY_AFTER_FAILURE_S
    assert price_sources.refresh()["status"] == "skipped"


@pytest.mark.parametrize("response", [HttpResponse(500, b"oops", {}), HttpResponse(200, b"{nope", {}),
                                      HttpResponse(200, b"x" * (price_sources.MAX_BYTES + 1), {})])
def test_every_failed_download_uses_the_short_interval(env, response):
    transport, now, monkeypatch, _ = env
    configure(monkeypatch)
    transport.responses = [response, HttpResponse(304, b"", {})]
    assert price_sources.refresh()["ok"] is False
    now[0] += price_sources.RETRY_AFTER_FAILURE_S
    assert price_sources.refresh()["status"] == "not_modified"


@pytest.mark.parametrize("response", [HttpResponse(404, b"", {}), HttpResponse(304, b"", {})])
def test_an_answer_that_is_not_a_failure_keeps_the_long_interval(env, response):
    transport, now, monkeypatch, _ = env
    configure(monkeypatch)
    transport.responses = [response]
    price_sources.refresh()
    now[0] += price_sources.RETRY_AFTER_FAILURE_S
    assert price_sources.refresh()["status"] == "skipped"
    assert len(transport.calls) == 1


def test_the_background_refresh_follows_the_same_rule(env):
    transport, now, monkeypatch, _ = env
    configure(monkeypatch)
    monkeypatch.setattr(price_sources, "AUTO_REFRESH", True)
    transport.responses = [HttpResponse(500, b"", {}), HttpResponse(304, b"", {})]
    price_sources.active_ledger()
    price_sources.join_background(5)
    assert len(transport.calls) == 1
    price_sources.active_ledger()
    price_sources.join_background(5)
    assert len(transport.calls) == 1  # not due yet
    now[0] += price_sources.RETRY_AFTER_FAILURE_S
    price_sources.active_ledger()
    price_sources.join_background(5)
    assert len(transport.calls) == 2


def test_forced_and_background_refreshes_never_overlap(env):
    import threading

    transport, _, monkeypatch, _ = env
    configure(monkeypatch)
    entered, release = threading.Event(), threading.Event()
    active, peak = [0], [0]
    lock = threading.Lock()

    def slow(method, url, headers, body, timeout):
        with lock:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
        entered.set()
        release.wait(5)
        with lock:
            active[0] -= 1
        return HttpResponse(304, b"", {})

    monkeypatch.setattr(price_sources, "transport", slow)
    first = threading.Thread(target=price_sources.refresh, kwargs={"force": True})
    first.start()
    assert entered.wait(5)
    second = threading.Thread(target=price_sources.refresh, kwargs={"force": True})
    second.start()
    second.join(0.3)
    assert second.is_alive()  # waiting for the first refresh, not fetching beside it
    release.set()
    first.join(5)
    second.join(5)
    assert peak[0] == 1


def test_a_mismatched_cache_pair_is_ignored(env):
    """A crash between replacing prices.json and meta.json leaves a pair that
    does not belong together; the reader ignores it instead of trusting it."""
    transport, _, monkeypatch, tmp = env
    configure(monkeypatch)
    transport.responses = [ok(ledger_body(amount=50))]
    price_sources.refresh(force=True)
    cache = tmp / "price_ledger"
    (cache / "prices.json").write_text(json.dumps(ledger_body(generated_at="2099-06-01T00:00:00Z", amount=77)))
    price_sources.reset_state()
    assert price_sources.active_ledger()[1] == "bundled"


def test_both_cache_files_are_written_before_either_replaces(env):
    transport, _, monkeypatch, tmp = env
    configure(monkeypatch)
    transport.responses = [ok(ledger_body(amount=50))]
    seen: list[set[str]] = []
    real_replace = price_sources.os.replace

    def replace(src, dst):
        seen.append({p.name for p in Path(tmp / "price_ledger").iterdir()})
        return real_replace(src, dst)

    monkeypatch.setattr(price_sources.os, "replace", replace)
    assert price_sources.refresh(force=True)["status"] == "updated"
    assert len(seen) == 2
    assert {".prices.json.tmp", ".meta.json.tmp"} <= seen[0]
