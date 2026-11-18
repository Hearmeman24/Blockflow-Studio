"""Tests for the SQLite settings store.

Covers the backend store only — pure repository functions over a
sqlite-backed `credentials` and `app_prefs` schema.

Doctrine: build green ≠ feature works. Every test asserts the ACTUAL state
written/returned, not just "no exception raised."
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import settings_store  # noqa: E402


@pytest.fixture
def store(tmp_path, monkeypatch):
    """Fresh, isolated sqlite file per test."""
    db_path = tmp_path / "settings_test.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    return settings_store


# === init_db ================================================================

def test_init_db_creates_tables_idempotently(tmp_path, monkeypatch):
    db_path = tmp_path / "fresh.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)

    settings_store.init_db()  # first call creates
    settings_store.init_db()  # second call must not error

    # State assertion: tables actually exist + writable
    settings_store.set_credential("kie_api_key", "kie_x")
    assert settings_store.get_credential("kie_api_key") == "kie_x"


def test_init_db_creates_parent_dir_if_missing(tmp_path, monkeypatch):
    nested = tmp_path / "deeply" / "nested" / "settings.db"
    monkeypatch.setattr(settings_store, "DB_PATH", nested)

    settings_store.init_db()

    assert nested.parent.is_dir()


# === credentials ============================================================

def test_allowed_credentials_are_exactly_the_byok_set(store):
    # openrouter_api_key is optional and only used by the Prompt Writer block.
    assert store.ALLOWED_CREDENTIALS == ("kie_api_key", "piapi_api_key", "openrouter_api_key")


def test_openrouter_key_round_trips_and_is_masked(store):
    store.set_credential("openrouter_api_key", "sk-or-v1-0123456789abcdefWXYZ")
    assert store.get_credential("openrouter_api_key") == "sk-or-v1-0123456789abcdefWXYZ"
    status = store.credential_status("openrouter_api_key")
    assert status["configured"] is True
    assert status["last4"] == "WXYZ"
    assert "sk-or" not in str(status)
    store.delete_credential("openrouter_api_key")
    assert store.get_credential("openrouter_api_key") is None


def test_set_then_get_credential_round_trip(store):
    store.set_credential("kie_api_key", "kie_secret_value")
    assert store.get_credential("kie_api_key") == "kie_secret_value"


def test_get_credential_unset_returns_none(store):
    assert store.get_credential("piapi_api_key") is None


def test_update_credential_overwrites_value(store):
    store.set_credential("piapi_api_key", "old_value")
    store.set_credential("piapi_api_key", "new_value")
    assert store.get_credential("piapi_api_key") == "new_value"


@pytest.mark.parametrize("name", ["runpod_api_key", "tmpfiles_api_key", "beta_key", "", "KIE_API_KEY"])
def test_unknown_credential_names_are_refused_by_the_store(store, name):
    with pytest.raises(store.UnknownCredentialError):
        store.set_credential(name, "v")
    with pytest.raises(store.UnknownCredentialError):
        store.delete_credential(name)
    assert store.get_credential(name) is None


def test_get_credential_never_returns_legacy_rows(store):
    import sqlite3
    conn = sqlite3.connect(str(store.DB_PATH))
    conn.execute(
        "INSERT INTO settings_credentials (name, value, updated_at) VALUES (?, ?, ?)",
        ("runpod_api_key", "legacy", "2026-01-01"),
    )
    conn.commit()
    conn.close()
    assert store.get_credential("runpod_api_key") is None
    assert [s["name"] for s in store.list_credential_statuses()] == list(store.ALLOWED_CREDENTIALS)


def test_list_credential_statuses_when_none_set(store):
    assert store.list_credential_statuses() == [
        {"name": n, "configured": False, "last4": None, "updated_at": None}
        for n in store.ALLOWED_CREDENTIALS
    ]


def test_credential_status_masks_the_value(store):
    store.set_credential("kie_api_key", "kie-0123456789ABCD")
    status = store.credential_status("kie_api_key")
    assert status["configured"] is True
    assert status["last4"] == "ABCD"
    assert status["updated_at"]
    assert "kie-0123456789ABCD" not in repr(status)


@pytest.mark.parametrize("value,last4", [("a" * 11, None), ("b" * 8 + "1234", "1234"), ("", None)])
def test_mask_last4_boundaries(store, value, last4):
    assert store.mask_last4(value) == last4


def test_delete_credential_removes_it(store):
    store.set_credential("piapi_api_key", "v")
    store.delete_credential("piapi_api_key")
    assert store.get_credential("piapi_api_key") is None
    assert store.credential_status("piapi_api_key")["configured"] is False


def test_delete_credential_idempotent_when_unset(store):
    store.delete_credential("kie_api_key")  # must not raise


def test_credential_very_long_value_preserved(store):
    """The store does not truncate; length limits live in the route layer."""
    long_value = "x" * 10_000
    store.set_credential("kie_api_key", long_value)
    assert store.get_credential("kie_api_key") == long_value


def test_credential_updated_at_advances_on_update(store):
    store.set_credential("kie_api_key", "v1")
    first_ts = store.get_credential_updated_at("kie_api_key")
    time.sleep(0.01)
    store.set_credential("kie_api_key", "v2")
    second_ts = store.get_credential_updated_at("kie_api_key")
    assert second_ts is not None and second_ts >= first_ts


# === value normalisation ====================================================

def test_normalize_credential_value_trims(store):
    assert store.normalize_credential_value("  abc-123 \n") == "abc-123"


@pytest.mark.parametrize(
    "value",
    ["", "  ", "a b", "a\tb", "a\u00a0b", "a\x00b", "a\u200bb", "h\u00e9llo", "\U0001f511", "x" * 513],
)
def test_normalize_credential_value_rejects(store, value):
    with pytest.raises(store.InvalidCredentialValue) as exc:
        store.normalize_credential_value(value)
    if value.strip():
        assert value.strip() not in str(exc.value)


def test_normalize_credential_value_accepts_max_length(store):
    assert store.normalize_credential_value("y" * 512) == "y" * 512


# === file permissions =======================================================

@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permissions only")
def test_init_db_creates_the_file_readable_only_by_the_user(tmp_path, monkeypatch):
    import os
    import stat
    db_path = tmp_path / "perm.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    assert stat.S_IMODE(os.stat(db_path).st_mode) == 0o600


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permissions only")
def test_init_db_tightens_an_existing_world_readable_file(tmp_path, monkeypatch):
    import os
    import stat
    db_path = tmp_path / "loose.db"
    db_path.touch()
    os.chmod(db_path, 0o644)
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()
    assert stat.S_IMODE(os.stat(db_path).st_mode) == 0o600


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permissions only")
def test_writing_a_credential_restores_user_only_permissions(store):
    import os
    import stat
    os.chmod(store.DB_PATH, 0o644)
    store.set_credential("kie_api_key", "k")
    assert stat.S_IMODE(os.stat(store.DB_PATH).st_mode) == 0o600


def test_permission_errors_are_best_effort(tmp_path, monkeypatch):
    import os
    db_path = tmp_path / "noperm.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)

    def boom(*_a, **_k):
        raise PermissionError("chmod not supported")

    monkeypatch.setattr(os, "chmod", boom)
    settings_store.init_db()  # must not raise
    settings_store.set_credential("kie_api_key", "k")
    assert settings_store.get_credential("kie_api_key") == "k"


# === app_prefs ==============================================================

def test_app_pref_round_trip(store):
    store.set_app_pref("output_dir", "/tmp/blockflow_out")
    assert store.get_app_pref("output_dir") == "/tmp/blockflow_out"


def test_app_pref_get_with_default_when_unset(store):
    assert store.get_app_pref("missing") is None
    assert store.get_app_pref("missing", default="fallback") == "fallback"


def test_app_pref_update(store):
    store.set_app_pref("run_history_retention_days", "90")
    store.set_app_pref("run_history_retention_days", "30")
    assert store.get_app_pref("run_history_retention_days") == "30"


def test_app_pref_value_is_string_typed(store):
    """app_prefs is a simple string-keyed store. Callers serialize numbers/JSON themselves."""
    store.set_app_pref("retention_days", "90")
    val = store.get_app_pref("retention_days")
    assert isinstance(val, str)


# === isolation (regression safety) ==========================================

def test_credentials_and_prefs_are_independent_namespaces(store):
    """Setting a credential named X does not affect app_pref X."""
    store.set_credential("kie_api_key", "this_is_a_credential")
    store.set_app_pref("kie_api_key", "this_is_a_pref")

    assert store.get_credential("kie_api_key") == "this_is_a_credential"
    assert store.get_app_pref("kie_api_key") == "this_is_a_pref"


def test_onboarding_pref_name_constant(store):
    assert store.ONBOARDING_COMPLETED_PREF == "onboarding_completed"
    assert store.get_app_pref(store.ONBOARDING_COMPLETED_PREF) is None
    store.set_app_pref(store.ONBOARDING_COMPLETED_PREF, "true")
    assert store.get_app_pref(store.ONBOARDING_COMPLETED_PREF) == "true"


def test_settings_store_does_not_affect_existing_run_history_table(tmp_path, monkeypatch):
    """Regression guard: settings_store uses the same DB file as run_history;
    creating settings tables must not collide with the runs table."""
    from backend import db as run_history_db

    shared_db = tmp_path / "shared.db"
    monkeypatch.setattr(run_history_db, "DB_PATH", shared_db)
    monkeypatch.setattr(settings_store, "DB_PATH", shared_db)

    run_history_db.init_db()
    settings_store.init_db()

    # Both schemas coexist
    run_history_db.init_db()  # no-op
    settings_store.set_credential("kie_api_key", "v")

    assert settings_store.get_credential("kie_api_key") == "v"


# === tables from removed features ==========================================
# Older builds created settings_endpoints, settings_installed_presets and
# settings_credential_validations. A
# fresh database no longer gets them, and an existing database keeps them
# untouched: init_db never drops or alters them.

_LEGACY_TABLES = (
    "settings_endpoints", "settings_installed_presets", "settings_credential_validations",
)


def _tables(db_path) -> set[str]:
    import sqlite3
    conn = sqlite3.connect(str(db_path))
    try:
        return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    finally:
        conn.close()


def test_fresh_db_has_no_legacy_tables(tmp_path, monkeypatch):
    db_path = tmp_path / "fresh.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()

    tables = _tables(db_path)
    assert {"settings_credentials", "settings_app_prefs"} <= tables
    assert not tables & set(_LEGACY_TABLES)


def test_init_db_leaves_legacy_tables_and_rows_in_place(tmp_path, monkeypatch):
    import sqlite3
    db_path = tmp_path / "legacy.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)

    legacy = sqlite3.connect(str(db_path))
    legacy.executescript("""
        CREATE TABLE settings_endpoints (
            type TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        INSERT INTO settings_endpoints VALUES ('old', 'ep_old', '2026-01-01');
        CREATE TABLE settings_installed_presets (
            preset_id TEXT PRIMARY KEY, version TEXT NOT NULL, workflow_json TEXT NOT NULL,
            installed_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        INSERT INTO settings_installed_presets VALUES ('p', '0.1.0', '{}', '2026-01-01', '2026-01-01');
    """)
    legacy.commit()
    legacy.close()

    settings_store.init_db()
    settings_store.set_credential("kie_api_key", "k")

    conn = sqlite3.connect(str(db_path))
    try:
        assert conn.execute("SELECT endpoint_id FROM settings_endpoints").fetchall() == [("ep_old",)]
        assert [r[1] for r in conn.execute("PRAGMA table_info(settings_endpoints)")] == [
            "type", "endpoint_id", "updated_at",
        ]
        assert conn.execute("SELECT preset_id FROM settings_installed_presets").fetchall() == [("p",)]
    finally:
        conn.close()
    assert settings_store.get_credential("kie_api_key") == "k"


def test_store_exposes_no_legacy_table_helpers():
    for name in ("set_endpoint", "get_endpoint", "list_endpoints", "delete_endpoint",
                 "record_installed_preset", "list_installed_presets", "get_installed_preset",
                 "get_installed_preset_by_pod_id", "remove_installed_preset"):
        assert not hasattr(settings_store, name), name
