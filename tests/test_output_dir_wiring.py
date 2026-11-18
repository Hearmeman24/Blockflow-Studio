"""The backend honors the Settings → App tab `output_dir` pref.

Pre-fix: the Settings UI persists `output_dir` via setAppPref, but no
backend code reads it — LOCAL_OUTPUT_DIR is hardcoded everywhere
(/outputs static mount, services.py, routes.py, tmpfiles.py).

Post-fix:
  - backend.output_folder.current() resolves the folder at every call:
    pref set + an existing folder → the override
    pref unset / empty / folder missing → the default
  - the /outputs route and every writer call it, so a change applies
    immediately (tests/test_output_folder_runtime.py covers the writers).
  - PUT /api/settings/app-prefs/output_dir validates the path with
    backend.output_folder (absolute, created when missing, a writable
    directory, not a system folder) before persisting (400 on bad input).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import config as _config  # noqa: E402
from backend import output_folder, settings_routes, settings_store  # noqa: E402

# === output_folder.current() (resolved at use time) =========================

@pytest.fixture
def prefs(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_store, "DB_PATH", tmp_path / "prefs.db")
    settings_store.init_db()
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(_config, "USER_DATA_DIR", data)
    monkeypatch.setattr(output_folder, "_state", None)
    return data / "output"


def _current_with_pref(value):
    if value is not None:
        settings_store.set_app_pref("output_dir", value)
    output_folder.reload()
    return output_folder.current()


def test_no_pref_uses_the_default(prefs):
    assert _current_with_pref(None) == prefs
    assert prefs.is_dir()


def test_valid_pref_is_used(prefs, tmp_path):
    override = tmp_path / "vault_output"
    override.mkdir()
    assert _current_with_pref(str(override)) == override


def test_missing_dir_falls_back_to_default(prefs, tmp_path):
    assert _current_with_pref(str(tmp_path / "does_not_exist")) == prefs


def test_file_at_path_falls_back_to_default(prefs, tmp_path):
    notadir = tmp_path / "I_am_a_file.txt"
    notadir.write_text("hi")
    assert _current_with_pref(str(notadir)) == prefs


def test_empty_string_pref_is_treated_as_unset(prefs):
    assert _current_with_pref("") == prefs


def test_unplugged_folder_comes_back_without_a_restart(prefs, tmp_path):
    drive = tmp_path / "ext"
    drive.mkdir()
    assert _current_with_pref(str(drive)) == drive
    drive.rmdir()
    assert output_folder.current() == prefs
    drive.mkdir()
    assert output_folder.current() == drive


# === PUT /api/settings/app-prefs/output_dir validates the value ==============

@pytest.fixture
def app(tmp_path, monkeypatch):
    db_path = tmp_path / "settings_test.db"
    monkeypatch.setattr(settings_store, "DB_PATH", db_path)
    settings_store.init_db()

    fastapi_app = FastAPI()
    fastapi_app.include_router(settings_routes.router)
    return fastapi_app


@pytest.fixture
def client(app):
    return TestClient(app)


def test_put_output_dir_creates_a_missing_folder(client, tmp_path):
    target = tmp_path / "does_not_exist_yet"
    r = client.put(
        "/api/settings/app-prefs/output_dir",
        json={"value": str(target)},
    )
    assert r.status_code == 200
    assert target.is_dir()
    assert settings_store.get_app_pref("output_dir") == str(target)


def test_put_output_dir_rejects_a_relative_path(client):
    r = client.put("/api/settings/app-prefs/output_dir", json={"value": "./output"})
    assert r.status_code == 400
    assert "full folder path" in r.json()["detail"]
    assert settings_store.get_app_pref("output_dir") is None


def test_put_output_dir_rejects_file_path(client, tmp_path):
    f = tmp_path / "afile.txt"
    f.write_text("nope")
    r = client.put("/api/settings/app-prefs/output_dir", json={"value": str(f)})
    assert r.status_code == 400
    assert "points to a file" in r.json()["detail"]


def test_put_output_dir_rejects_unwritable_dir(client, tmp_path):
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o500)
    try:
        r = client.put("/api/settings/app-prefs/output_dir", json={"value": str(locked)})
        assert r.status_code == 400
        assert "read-only" in r.json()["detail"]
    finally:
        locked.chmod(0o700)


def test_put_output_dir_accepts_valid_dir(client, tmp_path):
    good = tmp_path / "vault_output"
    good.mkdir()
    r = client.put("/api/settings/app-prefs/output_dir", json={"value": str(good)})
    assert r.status_code == 200
    assert settings_store.get_app_pref("output_dir") == str(good)


def test_put_output_dir_empty_string_clears_setting(client, tmp_path):
    """Setting output_dir to empty string is the UX for 'go back to default'.
    Empty must be persisted (not rejected) so resolve_local_output_dir's
    empty-as-unset branch can kick in."""
    good = tmp_path / "v"
    good.mkdir()
    client.put("/api/settings/app-prefs/output_dir", json={"value": str(good)})
    r = client.put("/api/settings/app-prefs/output_dir", json={"value": ""})
    assert r.status_code == 200
    assert settings_store.get_app_pref("output_dir") == ""


def test_put_other_app_pref_is_unvalidated(client):
    """Validation kicks in ONLY for output_dir, not every app pref."""
    r = client.put(
        "/api/settings/app-prefs/run_history_retention_days",
        json={"value": "30"},
    )
    assert r.status_code == 200
    assert settings_store.get_app_pref("run_history_retention_days") == "30"
