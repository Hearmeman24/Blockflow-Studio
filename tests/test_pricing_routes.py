"""GET /api/pricing/status, POST /api/pricing/refresh and the price-ledger prefs."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import db, settings_routes, settings_store  # noqa: E402
from backend.byok import price_ledger, price_sources, pricing_routes  # noqa: E402
from backend.byok.http import HttpResponse  # noqa: E402

URL = "https://example.test/prices.json"


class FakeTransport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = 0

    def __call__(self, method, url, headers, body, timeout):
        self.calls += 1
        return self.responses.pop(0)


@pytest.fixture
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "run_history.db"
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    monkeypatch.setattr(price_sources, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(price_sources, "AUTO_REFRESH", False)
    monkeypatch.delenv(price_sources.URL_ENV, raising=False)
    monkeypatch.delenv(price_sources.REPO_ENV, raising=False)
    price_sources.reset_state()
    transport = FakeTransport()
    monkeypatch.setattr(price_sources, "transport", transport)
    app = FastAPI()
    app.include_router(pricing_routes.router)
    app.include_router(settings_routes.router)
    with TestClient(app) as c:
        yield c, transport, monkeypatch
    price_sources.reset_state()


DEFAULT_URL = "https://raw.githubusercontent.com/Hearmeman24/blockflow-prices/main/prices.json"


def test_status_by_default_points_at_the_ledger_repository(client):
    c, transport, _ = client
    body = c.get("/api/pricing/status").json()
    assert body["ok"] is True
    assert body["active"] == "bundled"
    assert body["remote"]["configured"] is True and body["remote"]["enabled"] is True
    assert body["remote"]["url"] == DEFAULT_URL
    assert body["remote"]["repo"] == "Hearmeman24/blockflow-prices"
    assert body["ledger"]["generated_at"] == price_ledger.load_bundled().generated_at
    assert transport.calls == 0


def test_refresh_while_the_repository_is_not_published_is_quiet(client):
    c, transport, _ = client
    transport.responses = [HttpResponse(404, b"404: Not Found", {})]
    body = c.post("/api/pricing/refresh").json()
    assert body["ok"] is True
    assert body["refresh"]["status"] == "not_available"
    assert body["status"]["active"] == "bundled"


def test_refresh_without_a_url_reports_not_configured(client):
    c, transport, monkeypatch = client
    monkeypatch.setenv(price_sources.URL_ENV, "")
    res = c.post("/api/pricing/refresh")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["refresh"]["status"] == "not_configured"
    assert body["status"]["active"] == "bundled"
    assert transport.calls == 0


def test_refresh_downloads_and_activates(client):
    c, transport, monkeypatch = client
    monkeypatch.setenv(price_sources.URL_ENV, URL)
    data = json.loads(price_ledger.BUNDLED_PATH.read_text())
    data["generated_at"] = "2099-01-01T00:00:00Z"
    transport.responses = [HttpResponse(200, json.dumps(data).encode(), {})]
    body = c.post("/api/pricing/refresh").json()
    assert body["refresh"]["status"] == "updated"
    assert body["status"]["active"] == "ledger"
    assert body["status"]["last_refresh"]["status"] == "updated"


def test_updates_pref_is_a_boolean(client):
    c, _, _ = client
    assert c.put("/api/settings/app-prefs/price_ledger_updates", json={"value": "maybe"}).status_code == 400
    assert c.put("/api/settings/app-prefs/price_ledger_updates", json={"value": "false"}).status_code == 200
    assert c.get("/api/pricing/status").json()["remote"]["enabled"] is False


@pytest.mark.parametrize("name,value,ok", [
    ("price_ledger_url", "https://example.test/p.json", True),
    ("price_ledger_url", "", True),
    ("price_ledger_url", "http://example.test/p.json", False),
    ("price_ledger_url", "https://u:p@example.test/p.json", False),
    ("price_ledger_repo", "someone/prices", True),
    ("price_ledger_repo", "", True),
    ("price_ledger_repo", "not a repo", False),
    ("price_ledger_repo", "https://github.com/a/b", False),
])
def test_url_and_repo_prefs_are_validated(client, name, value, ok):
    c, _, _ = client
    res = c.put(f"/api/settings/app-prefs/{name}", json={"value": value})
    assert (res.status_code == 200) is ok
    if not ok:
        assert value not in res.text or value == ""
