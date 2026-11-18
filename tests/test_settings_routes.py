"""HTTP route tests for settings.

Runs the full HTTP path against the real settings store via TestClient and
asserts the state written to the store and the exact response bodies.

Credential contract (BYOK hardening):
  - names are allow-listed (kie_api_key, piapi_api_key, openrouter_api_key);
    any other name is 404 on every verb and nothing is written;
  - no response ever contains a stored key value — only
    {name, configured, last4, updated_at};
  - PUT trims and rejects empty, whitespace-containing, non-printable,
    non-ASCII and over-long values with a 422 that never echoes the value.
"""
from __future__ import annotations

import logging
import sqlite3
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import settings_store  # noqa: E402
from backend.settings_routes import router as settings_router  # noqa: E402

ALLOWED = ["kie_api_key", "piapi_api_key", "openrouter_api_key"]
KIE_KEY = "kie-SECRET-0123456789abcdWXYZ"


@pytest.fixture
def db_path(tmp_path, monkeypatch):
    path = tmp_path / "settings_routes_test.db"
    monkeypatch.setattr(settings_store, "DB_PATH", path)
    settings_store.init_db()
    return path


@pytest.fixture
def client(db_path):
    app = FastAPI()
    app.include_router(settings_router)
    return TestClient(app)


def _raw_insert(db_path: Path, name: str, value: str) -> None:
    """Write a row directly, bypassing the store's allow-list (legacy DBs)."""
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute(
            "INSERT INTO settings_credentials (name, value, updated_at) VALUES (?, ?, ?)",
            (name, value, "2026-01-01T00:00:00+00:00"),
        )
        conn.commit()
    finally:
        conn.close()


# === list / get =============================================================

def test_list_credentials_reports_every_allowed_name_unconfigured(client):
    r = client.get("/api/settings/credentials")
    assert r.status_code == 200
    assert r.json() == {
        "credentials": [
            {"name": n, "configured": False, "last4": None, "updated_at": None} for n in ALLOWED
        ]
    }


def test_get_unset_allowed_credential_is_unconfigured_not_404(client):
    r = client.get("/api/settings/credentials/piapi_api_key")
    assert r.status_code == 200
    assert r.json() == {"name": "piapi_api_key", "configured": False, "last4": None, "updated_at": None}


def test_put_then_get_returns_masked_status_and_never_the_value(client):
    r = client.put("/api/settings/credentials/kie_api_key", json={"value": KIE_KEY})
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "kie_api_key"
    assert body["configured"] is True
    assert body["last4"] == "WXYZ"
    assert body["updated_at"]
    assert KIE_KEY not in r.text

    assert settings_store.get_credential("kie_api_key") == KIE_KEY

    r2 = client.get("/api/settings/credentials/kie_api_key")
    assert r2.status_code == 200
    assert r2.json() == body
    assert set(r2.json()) == {"name", "configured", "last4", "updated_at"}
    assert KIE_KEY not in r2.text

    r3 = client.get("/api/settings/credentials")
    assert KIE_KEY not in r3.text
    entry = next(c for c in r3.json()["credentials"] if c["name"] == "kie_api_key")
    assert entry == body


def test_no_response_contains_any_fragment_of_a_short_key(client):
    """A key shorter than 12 characters is not partially revealed either."""
    short = "ab12cd34ef9"  # 11 chars
    client.put("/api/settings/credentials/piapi_api_key", json={"value": short})
    for r in (
        client.get("/api/settings/credentials"),
        client.get("/api/settings/credentials/piapi_api_key"),
    ):
        assert short not in r.text
        assert short[-4:] not in r.text


@pytest.mark.parametrize(
    "value,last4",
    [
        ("a" * 11, None),             # 11 chars: too short to reveal anything
        ("abcdefgh1234", "1234"),      # exactly 12: last four shown
        ("abcdefgh12345", "2345"),     # 13
        ("x" * 512, "xxxx"),           # max length accepted
    ],
)
def test_last4_masking_boundaries(client, value, last4):
    r = client.put("/api/settings/credentials/kie_api_key", json={"value": value})
    assert r.status_code == 200
    assert r.json()["last4"] == last4
    assert r.json()["configured"] is True


def test_put_trims_surrounding_whitespace_before_storing(client):
    r = client.put("/api/settings/credentials/kie_api_key", json={"value": f"  \t{KIE_KEY}\n "})
    assert r.status_code == 200
    assert settings_store.get_credential("kie_api_key") == KIE_KEY
    assert r.json()["last4"] == "WXYZ"


def test_put_overwrites_previous_value(client):
    client.put("/api/settings/credentials/piapi_api_key", json={"value": "old-key-0000000001"})
    r = client.put("/api/settings/credentials/piapi_api_key", json={"value": "new-key-0000000002"})
    assert r.json()["last4"] == "0002"
    assert settings_store.get_credential("piapi_api_key") == "new-key-0000000002"


# === rejection cases ========================================================

@pytest.mark.parametrize(
    "value,fragment",
    [
        ("", "empty"),
        ("   \n\t ", "empty"),
        ("abc def-123456789", "spaces"),
        ("abc\ndef-123456789", "spaces"),
        ("abc def-123456789", "spaces"),        # non-breaking space
        ("abc\x00def-123456789", "characters"),      # NUL
        ("abc\x07def-123456789", "characters"),      # BEL
        ("abc​def-123456789", "characters"),    # zero-width space
        ("héllo-1234567890", "characters"),
        ("你好🔑-1234567890", "characters"),
        ("x" * 513, "512"),
    ],
)
def test_put_rejects_bad_values_with_422_without_echoing(client, value, fragment, caplog):
    caplog.set_level(logging.DEBUG)
    r = client.put("/api/settings/credentials/kie_api_key", json={"value": value})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert isinstance(detail, str)
    assert fragment in detail.lower()
    stripped = value.strip()
    if stripped:
        assert stripped not in r.text
        assert stripped not in caplog.text
    assert settings_store.get_credential("kie_api_key") is None


def test_rejected_put_keeps_the_previous_key(client):
    client.put("/api/settings/credentials/kie_api_key", json={"value": KIE_KEY})
    r = client.put("/api/settings/credentials/kie_api_key", json={"value": "bad key with spaces"})
    assert r.status_code == 422
    assert settings_store.get_credential("kie_api_key") == KIE_KEY


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"value": None},
        {"value": 1234567890123},
        {"value": ["kie-SECRET-0123456789"]},
        {"other": "kie-SECRET-0123456789"},
        ["kie-SECRET-0123456789"],
        "kie-SECRET-0123456789",
    ],
)
def test_put_rejects_malformed_bodies_without_echoing(client, body):
    r = client.put("/api/settings/credentials/kie_api_key", json=body)
    assert r.status_code == 422
    assert isinstance(r.json()["detail"], str)
    assert "kie-SECRET-0123456789" not in r.text
    assert "1234567890123" not in r.text
    assert settings_store.get_credential("kie_api_key") is None


def test_put_rejects_non_json_body_without_echoing(client):
    r = client.put(
        "/api/settings/credentials/kie_api_key",
        content=b"kie-SECRET-0123456789\xff",
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 422
    assert "kie-SECRET-0123456789" not in r.text
    assert settings_store.get_credential("kie_api_key") is None


def test_put_and_failures_never_log_the_value(client, caplog):
    caplog.set_level(logging.DEBUG)
    client.put("/api/settings/credentials/kie_api_key", json={"value": KIE_KEY})
    client.get("/api/settings/credentials")
    client.delete("/api/settings/credentials/kie_api_key")
    assert KIE_KEY not in caplog.text


# === delete =================================================================

def test_delete_removes_the_key(client):
    client.put("/api/settings/credentials/piapi_api_key", json={"value": "pi-0123456789ab"})
    r = client.delete("/api/settings/credentials/piapi_api_key")
    assert r.status_code == 204
    assert r.content == b""
    assert settings_store.get_credential("piapi_api_key") is None
    assert client.get("/api/settings/credentials/piapi_api_key").json()["configured"] is False


def test_delete_unset_allowed_credential_is_idempotent(client):
    r = client.delete("/api/settings/credentials/piapi_api_key")
    assert r.status_code == 204


# === allow-list =============================================================

UNKNOWN_NAMES = [
    "runpod_api_key",
    "tmpfiles_api_key",
    "elevenlabs_api_key",
    "OPENROUTER_API_KEY",
    "r2_secret_access_key",
    "KIE_API_KEY",
    "kie_api_key ",
    "not_a_key",
    "ключ",
]


@pytest.mark.parametrize("name", UNKNOWN_NAMES)
def test_unknown_names_are_404_on_every_verb(client, name, db_path):
    r = client.get(f"/api/settings/credentials/{name}")
    assert r.status_code == 404
    assert r.json()["detail"] == "Unknown credential name."

    r = client.put(f"/api/settings/credentials/{name}", json={"value": "abcdefghijkl1234"})
    assert r.status_code == 404
    assert r.json()["detail"] == "Unknown credential name."
    assert "abcdefghijkl1234" not in r.text

    r = client.delete(f"/api/settings/credentials/{name}")
    assert r.status_code == 404
    assert r.json()["detail"] == "Unknown credential name."

    conn = sqlite3.connect(str(db_path))
    try:
        assert conn.execute("SELECT COUNT(*) FROM settings_credentials").fetchone() == (0,)
    finally:
        conn.close()


def test_legacy_rows_are_never_listed_or_returned(client, db_path):
    _raw_insert(db_path, "runpod_api_key", "rp-LEGACY-SECRET-123456")
    _raw_insert(db_path, "elevenlabs_api_key", "el-LEGACY-SECRET-123456")
    _raw_insert(db_path, "tmpfiles_api_key", "tmp-LEGACY-SECRET-123456")

    r = client.get("/api/settings/credentials")
    assert [c["name"] for c in r.json()["credentials"]] == ALLOWED
    assert "LEGACY" not in r.text
    assert "runpod" not in r.text
    assert "tmpfiles" not in r.text
    assert "elevenlabs" not in r.text

    for legacy in ("runpod_api_key", "tmpfiles_api_key", "elevenlabs_api_key"):
        r = client.get(f"/api/settings/credentials/{legacy}")
        assert r.status_code == 404
        assert "LEGACY" not in r.text
    assert settings_store.get_credential("tmpfiles_api_key") is None

    # A legacy row can't be removed through the API either; it stays inert.
    assert client.delete("/api/settings/credentials/runpod_api_key").status_code == 404


def test_stored_value_with_surrounding_whitespace_reports_trimmed_last4(client, db_path):
    """Rows written by older builds may carry whitespace. Status trims them."""
    _raw_insert(db_path, "piapi_api_key", "  piapi-OLD-12345678ABCD \n")
    body = client.get("/api/settings/credentials/piapi_api_key").json()
    assert body["configured"] is True
    assert body["last4"] == "ABCD"


def test_blank_legacy_value_reports_not_configured(client, db_path):
    _raw_insert(db_path, "piapi_api_key", "   ")
    body = client.get("/api/settings/credentials/piapi_api_key").json()
    assert body == {"name": "piapi_api_key", "configured": False, "last4": None,
                    "updated_at": "2026-01-01T00:00:00+00:00"}


# === removed routes =========================================================

@pytest.mark.parametrize("method", ["get", "put", "delete"])
def test_endpoint_config_routes_are_gone(client, method):
    kwargs = {"json": {"endpoint_id": "ep_x"}} if method == "put" else {}
    r = getattr(client, method)("/api/settings/endpoints/anything", **kwargs)
    assert r.status_code in (404, 405)
    assert client.get("/api/settings/endpoints").status_code == 404
    assert not hasattr(settings_store, "get_endpoint")


@pytest.mark.parametrize("service", ["kie", "piapi", "runpod", "anything"])
def test_generic_validate_route_is_gone(client, service):
    """Key checks live at /api/providers/{provider}/validate-key now."""
    assert client.get(f"/api/settings/validate/{service}").status_code == 404
    assert client.post(f"/api/settings/validate/{service}").status_code == 404


def test_validator_module_is_removed():
    import importlib.util
    assert importlib.util.find_spec("backend.settings_validators") is None
    for name in ("set_credential_validation", "get_credential_validation",
                 "list_credential_validations"):
        assert not hasattr(settings_store, name), name


# === app_prefs ==============================================================

def test_app_pref_put_then_get(client, tmp_path):
    out = tmp_path / "blockflow_out"
    out.mkdir()
    r = client.put("/api/settings/app-prefs/output_dir", json={"value": str(out)})
    assert r.status_code == 200
    r2 = client.get("/api/settings/app-prefs/output_dir")
    assert r2.json() == {"name": "output_dir", "value": str(out)}


def test_app_pref_get_unset_returns_null_value(client):
    r = client.get("/api/settings/app-prefs/never_set")
    assert r.status_code == 200
    assert r.json() == {"name": "never_set", "value": None}


def test_app_pref_get_with_default_query_param(client):
    r = client.get("/api/settings/app-prefs/never_set?default=fallback_value")
    assert r.json() == {"name": "never_set", "value": "fallback_value"}


def test_app_pref_update(client):
    client.put("/api/settings/app-prefs/retention_days", json={"value": "90"})
    client.put("/api/settings/app-prefs/retention_days", json={"value": "30"})
    assert client.get("/api/settings/app-prefs/retention_days").json()["value"] == "30"


def test_app_pref_put_missing_value_returns_422(client):
    r = client.put("/api/settings/app-prefs/output_dir", json={})
    assert r.status_code in (400, 422)


def test_onboarding_completed_is_unset_on_a_fresh_install(client):
    assert client.get("/api/settings/app-prefs/onboarding_completed").json() == {
        "name": "onboarding_completed", "value": None,
    }


@pytest.mark.parametrize("value", ["true", "false"])
def test_onboarding_completed_round_trip(client, value):
    r = client.put("/api/settings/app-prefs/onboarding_completed", json={"value": value})
    assert r.status_code == 200
    assert settings_store.get_app_pref("onboarding_completed") == value
    assert client.get("/api/settings/app-prefs/onboarding_completed").json()["value"] == value


@pytest.mark.parametrize("value", ["", "yes", "True", "1", "done"])
def test_onboarding_completed_rejects_non_boolean_strings(client, value):
    r = client.put("/api/settings/app-prefs/onboarding_completed", json={"value": value})
    assert r.status_code == 400
    assert "true" in r.json()["detail"] and "false" in r.json()["detail"]
    assert settings_store.get_app_pref("onboarding_completed") is None


def test_credentials_and_prefs_are_isolated_namespaces(client):
    client.put("/api/settings/credentials/kie_api_key", json={"value": KIE_KEY})
    client.put("/api/settings/app-prefs/kie_api_key", json={"value": "this_is_a_pref"})
    assert settings_store.get_credential("kie_api_key") == KIE_KEY
    assert client.get("/api/settings/app-prefs/kie_api_key").json()["value"] == "this_is_a_pref"


# === openrouter_api_key (optional, Prompt Writer only) ======================

OR_KEY = "sk-or-v1-SECRET-0123456789abcdefQRST"


def test_openrouter_key_supports_every_verb_and_is_masked(client, caplog):
    caplog.set_level(logging.DEBUG)
    r = client.get("/api/settings/credentials/openrouter_api_key")
    assert r.json() == {"name": "openrouter_api_key", "configured": False, "last4": None, "updated_at": None}

    r = client.put("/api/settings/credentials/openrouter_api_key", json={"value": f"  {OR_KEY} "})
    assert r.status_code == 200
    assert r.json()["configured"] is True
    assert r.json()["last4"] == "QRST"
    assert settings_store.get_credential("openrouter_api_key") == OR_KEY

    for resp in (r, client.get("/api/settings/credentials/openrouter_api_key"), client.get("/api/settings/credentials")):
        assert OR_KEY not in resp.text
        assert "SECRET" not in resp.text

    r = client.put("/api/settings/credentials/openrouter_api_key", json={"value": "has a space 123456"})
    assert r.status_code == 422
    assert settings_store.get_credential("openrouter_api_key") == OR_KEY

    assert client.delete("/api/settings/credentials/openrouter_api_key").status_code == 204
    assert settings_store.get_credential("openrouter_api_key") is None
    assert OR_KEY not in caplog.text


def test_pre_fork_openrouter_row_is_reported_configured_but_never_returned(client, db_path):
    """Builds before the BYOK fork stored openrouter_api_key; that row now counts."""
    _raw_insert(db_path, "openrouter_api_key", "or-LEGACY-SECRET-123456")
    r = client.get("/api/settings/credentials")
    entry = next(c for c in r.json()["credentials"] if c["name"] == "openrouter_api_key")
    assert entry["configured"] is True
    assert entry["last4"] == "3456"
    assert "LEGACY" not in r.text
