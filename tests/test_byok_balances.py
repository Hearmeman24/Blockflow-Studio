"""Provider balances: adapter parsing, the aggregated service and its route.

All provider traffic goes through a fake transport; no network, no real keys.
"""

from __future__ import annotations

import json
import logging
import sys
import threading
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import db, settings_store  # noqa: E402
from backend.byok import balances, routes, service  # noqa: E402
from backend.byok.errors import ProviderError  # noqa: E402
from backend.byok.http import HttpResponse, RetryPolicy  # noqa: E402
from backend.byok.providers import get_adapter  # noqa: E402
from backend.byok.providers.kie import KIE_USD_PER_CREDIT  # noqa: E402

KIE_KEY = "kie-BAL-SECRET-1234567890"
PI_KEY = "pi-BAL-SECRET-0987654321"
FAST = RetryPolicy(max_attempts=1, base_delay_s=0, sleep=lambda s: None)


class FakeTransport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "headers": dict(headers), "timeout": timeout})
        item = self.responses.pop(0) if self.responses else {"code": 500, "msg": "no more responses"}
        if isinstance(item, BaseException):
            raise item
        if isinstance(item, HttpResponse):
            return item
        if callable(item):
            return item()
        return HttpResponse(200, json.dumps(item).encode())


def _adapter(provider, *responses):
    transport = FakeTransport(*responses)
    return get_adapter(provider, transport=transport, retry=FAST), transport


# ------------------------------------------------------------------ Kie parsing


def test_kie_balance_reads_credits_and_converts_to_usd():
    adapter, transport = _adapter("kie", {"code": 200, "msg": "success", "data": 100.5})
    bal = adapter.get_balance(KIE_KEY)
    assert bal.provider == "kie"
    assert bal.status == "ok"
    assert bal.amount == 100.5
    assert bal.unit == "credits"
    assert bal.usd_equivalent == pytest.approx(100.5 * KIE_USD_PER_CREDIT)
    assert transport.calls[0]["url"] == "https://api.kie.ai/api/v1/chat/credit"
    assert transport.calls[0]["headers"]["Authorization"] == f"Bearer {KIE_KEY}"


def test_kie_credit_is_half_a_cent():
    # kie site pages: 19 credits = $0.095, 160 credits = $0.80
    assert KIE_USD_PER_CREDIT == 0.005


@pytest.mark.parametrize("data", [None, "lots", True, {"credits": 3}, [], float("nan")])
def test_kie_unreadable_balance_is_unavailable(data):
    body = json.dumps({"code": 200, "msg": "success", "data": data}).encode() if data == data else (
        b'{"code": 200, "msg": "success", "data": NaN}')
    adapter, _ = _adapter("kie", HttpResponse(200, body))
    bal = adapter.get_balance(KIE_KEY)
    assert bal.status == "unavailable"
    assert bal.amount is None and bal.usd_equivalent is None
    assert "balance" in bal.message.lower()


def test_kie_numeric_string_balance_is_accepted():
    adapter, _ = _adapter("kie", {"code": 200, "msg": "success", "data": "42.25"})
    assert adapter.get_balance(KIE_KEY).amount == 42.25


def test_kie_auth_failure_raises_auth():
    adapter, _ = _adapter("kie", {"code": 401, "msg": f"bad key {KIE_KEY}"})
    with pytest.raises(ProviderError) as exc:
        adapter.get_balance(KIE_KEY)
    assert exc.value.kind == "auth"
    assert KIE_KEY not in str(exc.value)


def test_kie_balance_needs_a_key():
    adapter, transport = _adapter("kie")
    with pytest.raises(ProviderError) as exc:
        adapter.get_balance("  ")
    assert exc.value.kind == "auth"
    assert transport.calls == []


# ------------------------------------------------------------------ PiAPI parsing


def test_piapi_balance_prefers_equivalent_in_usd():
    adapter, transport = _adapter("piapi", {"code": 200, "data": {
        "account_name": "someone", "account_id": "acc-1", "credits": 123456, "equivalent_in_usd": 12.34}})
    bal = adapter.get_balance(PI_KEY)
    assert bal.status == "ok"
    assert bal.amount == 12.34
    assert bal.unit == "usd"
    assert bal.usd_equivalent == 12.34
    assert transport.calls[0]["url"] == "https://api.piapi.ai/account/info"
    assert transport.calls[0]["headers"]["x-api-key"] == PI_KEY


def test_piapi_balance_top_level_fields_are_read_too():
    adapter, _ = _adapter("piapi", {"equivalent_in_usd": "5.5", "credits": 55000})
    bal = adapter.get_balance(PI_KEY)
    assert (bal.status, bal.amount, bal.unit) == ("ok", 5.5, "usd")


def test_piapi_credits_only_has_no_usd_value():
    adapter, _ = _adapter("piapi", {"code": 200, "data": {"credits": 800}})
    bal = adapter.get_balance(PI_KEY)
    assert (bal.status, bal.amount, bal.unit, bal.usd_equivalent) == ("ok", 800, "credits", None)


@pytest.mark.parametrize("payload", [
    {"code": 200, "data": {"account_name": "x"}},
    {"code": 200, "data": {"equivalent_in_usd": None, "credits": "many"}},
    {"code": 200, "data": {"equivalent_in_usd": True}},
    {"code": 200, "data": []},
    {"code": 200},
])
def test_piapi_unexpected_shapes_are_unavailable_not_guessed(payload):
    adapter, _ = _adapter("piapi", payload)
    bal = adapter.get_balance(PI_KEY)
    assert bal.status == "unavailable"
    assert bal.amount is None
    assert bal.message


def test_piapi_non_object_body_is_unavailable():
    adapter, _ = _adapter("piapi", HttpResponse(200, b"[1, 2]"))
    with pytest.raises(ProviderError) as exc:
        adapter.get_balance(PI_KEY)
    assert exc.value.kind == "malformed_response"


def test_piapi_auth_failure_raises_auth():
    adapter, _ = _adapter("piapi", HttpResponse(401, json.dumps({"message": "invalid key"}).encode()))
    with pytest.raises(ProviderError) as exc:
        adapter.get_balance(PI_KEY)
    assert exc.value.kind == "auth"


# ------------------------------------------------------------------ aggregated service


@pytest.fixture
def env(tmp_path, monkeypatch):
    db_path = tmp_path / "run_history.db"
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    transports: dict[str, FakeTransport] = {"kie": FakeTransport(), "piapi": FakeTransport()}

    def factory(provider, **kw):
        return get_adapter(provider, transport=transports[provider], retry=FAST)

    monkeypatch.setattr(service, "adapter_factory", factory)
    now = [1_000.0]
    monkeypatch.setattr(balances, "clock", lambda: now[0])
    balances.clear_cache()
    yield transports, now
    balances.clear_cache()


def _by_provider(result):
    return {b["provider"]: b for b in result}


def test_unconfigured_providers_are_reported_without_a_call(env):
    transports, _ = env
    result = _by_provider(balances.get_balances())
    assert set(result) == {"kie", "piapi"}
    for provider, entry in result.items():
        assert entry["configured"] is False
        assert entry["status"] == "not_configured"
        assert entry["label"] in ("Kie", "PiAPI")
        assert "amount" not in entry
    assert transports["kie"].calls == [] and transports["piapi"].calls == []


def test_one_provider_failing_does_not_fail_the_other(env):
    transports, _ = env
    settings_store.set_credential("kie_api_key", KIE_KEY)
    settings_store.set_credential("piapi_api_key", PI_KEY)
    transports["kie"].responses = [{"code": 200, "data": 205}]
    transports["piapi"].responses = [HttpResponse(502, b"<html>bad gateway</html>")]
    result = _by_provider(balances.get_balances())
    assert result["kie"]["status"] == "ok"
    assert result["kie"]["amount"] == 205
    assert result["kie"]["unit"] == "credits"
    assert result["kie"]["usd_equivalent"] == pytest.approx(1.025)
    assert isinstance(result["kie"]["fetched_at"], float)
    assert result["piapi"]["status"] == "error"
    assert result["piapi"]["configured"] is True
    assert result["piapi"]["message"]


def test_auth_failure_is_an_error_with_an_action(env):
    transports, _ = env
    settings_store.set_credential("kie_api_key", KIE_KEY)
    transports["kie"].responses = [{"code": 401, "msg": "Unauthorized"}]
    entry = _by_provider(balances.get_balances())["kie"]
    assert entry["status"] == "error"
    assert entry["kind"] == "auth"
    assert "Settings" in entry["message"]


def test_unavailable_balance_carries_its_reason(env):
    transports, _ = env
    settings_store.set_credential("piapi_api_key", PI_KEY)
    transports["piapi"].responses = [{"code": 200, "data": {"account_name": "x"}}]
    entry = _by_provider(balances.get_balances())["piapi"]
    assert entry["status"] == "unavailable"
    assert entry["message"]
    assert "amount" not in entry


def test_timeout_is_reported_per_provider(env, monkeypatch):
    transports, _ = env
    settings_store.set_credential("kie_api_key", KIE_KEY)
    settings_store.set_credential("piapi_api_key", PI_KEY)
    release = threading.Event()
    monkeypatch.setattr(balances, "TIMEOUT_S", 0.2)

    def hang():
        release.wait(5)
        return HttpResponse(200, b'{"code": 200, "data": 1}')

    transports["kie"].responses = [hang]
    transports["piapi"].responses = [{"code": 200, "data": {"equivalent_in_usd": 3}}]
    try:
        result = _by_provider(balances.get_balances())
    finally:
        release.set()
    assert result["kie"]["status"] == "error"
    assert result["kie"]["kind"] == "timeout"
    assert result["piapi"]["status"] == "ok"


def test_transport_timeout_error_is_reported(env):
    transports, _ = env
    settings_store.set_credential("kie_api_key", KIE_KEY)
    transports["kie"].responses = [ProviderError("timeout", "The provider did not respond in time.")]
    entry = _by_provider(balances.get_balances())["kie"]
    assert (entry["status"], entry["kind"]) == ("error", "timeout")


def test_results_are_cached_and_refresh_bypasses_the_cache(env):
    transports, now = env
    settings_store.set_credential("kie_api_key", KIE_KEY)
    transports["kie"].responses = [{"code": 200, "data": 10}, {"code": 200, "data": 9}, {"code": 200, "data": 8}]
    assert _by_provider(balances.get_balances())["kie"]["amount"] == 10
    now[0] += 10
    assert _by_provider(balances.get_balances())["kie"]["amount"] == 10
    assert len(transports["kie"].calls) == 1
    assert _by_provider(balances.get_balances(refresh=True))["kie"]["amount"] == 9
    assert len(transports["kie"].calls) == 2
    now[0] += balances.CACHE_TTL_S + 1
    assert _by_provider(balances.get_balances())["kie"]["amount"] == 8
    assert len(transports["kie"].calls) == 3


def test_a_new_key_is_not_served_from_the_old_keys_cache(env):
    transports, _ = env
    settings_store.set_credential("kie_api_key", KIE_KEY)
    transports["kie"].responses = [{"code": 200, "data": 10}, {"code": 200, "data": 77}]
    balances.get_balances()
    settings_store.set_credential("kie_api_key", KIE_KEY + "-new")
    assert _by_provider(balances.get_balances())["kie"]["amount"] == 77


def test_errors_are_not_cached(env):
    transports, _ = env
    settings_store.set_credential("kie_api_key", KIE_KEY)
    transports["kie"].responses = [HttpResponse(503, b""), {"code": 200, "data": 4}]
    assert _by_provider(balances.get_balances())["kie"]["status"] == "error"
    assert _by_provider(balances.get_balances())["kie"]["amount"] == 4


def test_unexpected_crash_is_a_generic_error_without_the_key(env, monkeypatch, caplog):
    transports, _ = env
    settings_store.set_credential("kie_api_key", KIE_KEY)
    transports["kie"].responses = [RuntimeError(f"boom {KIE_KEY}")]
    with caplog.at_level(logging.DEBUG):
        entry = _by_provider(balances.get_balances())["kie"]
    assert entry["status"] == "error"
    assert KIE_KEY not in json.dumps(entry)
    assert KIE_KEY not in caplog.text


# ------------------------------------------------------------------ route


@pytest.fixture
def client(env):
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app) as c:
        yield c, env[0]


def test_balances_route_shape_and_no_key_in_output(client, caplog):
    c, transports = client
    settings_store.set_credential("kie_api_key", KIE_KEY)
    settings_store.set_credential("piapi_api_key", PI_KEY)
    transports["kie"].responses = [{"code": 401, "msg": f"invalid key {KIE_KEY}"}]
    transports["piapi"].responses = [{"code": 200, "data": {"equivalent_in_usd": 7.5, "account_id": "acc"}}]
    with caplog.at_level(logging.DEBUG):
        res = c.get("/api/providers/balances")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    entries = _by_provider(body["balances"])
    assert [b["provider"] for b in body["balances"]] == ["kie", "piapi"]
    assert entries["piapi"] == {"provider": "piapi", "label": "PiAPI", "configured": True, "status": "ok",
                                "amount": 7.5, "unit": "usd", "usd_equivalent": 7.5,
                                "fetched_at": entries["piapi"]["fetched_at"]}
    assert entries["kie"]["status"] == "error"
    raw = res.text
    assert KIE_KEY not in raw and PI_KEY not in raw
    assert KIE_KEY not in caplog.text and PI_KEY not in caplog.text


def test_balances_route_refresh_param_bypasses_cache(client):
    c, transports = client
    settings_store.set_credential("kie_api_key", KIE_KEY)
    transports["kie"].responses = [{"code": 200, "data": 1}, {"code": 200, "data": 2}]
    assert _by_provider(c.get("/api/providers/balances").json()["balances"])["kie"]["amount"] == 1
    assert _by_provider(c.get("/api/providers/balances").json()["balances"])["kie"]["amount"] == 1
    assert _by_provider(c.get("/api/providers/balances?refresh=1").json()["balances"])["kie"]["amount"] == 2
