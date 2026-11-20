"""The web interface listens on 127.0.0.1 only, unless the user set
BLOCKFLOW_ALLOWED_ORIGINS (how they say "I use this app from another
device"); then on every IPv4 address. One rule
(``launcher_protocol.frontend_host``) serves the built server (``HOSTNAME``)
and ``--dev`` (``next dev --hostname``). The launcher reads the variable the
way the backend does: the environment first, else the repository ``.env``
file (``backend/config.py``), so both agree on whether it is set.
"""
from __future__ import annotations

import importlib.util
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from backend import config
from backend.app_update import launcher_protocol as lp

ROOT = Path(__file__).resolve().parent.parent


def _app():
    spec = importlib.util.spec_from_file_location("blockflow_app_listen", ROOT / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("environ,env_file,expected", [
    ({}, None, "127.0.0.1"),
    ({}, "OTHER=1\n", "127.0.0.1"),
    ({"BLOCKFLOW_ALLOWED_ORIGINS": "http://192.168.1.20:47300"}, None, "0.0.0.0"),
    ({}, "# my machine\nBLOCKFLOW_ALLOWED_ORIGINS = 'http://mac.local:47300'\n", "0.0.0.0"),
    ({"BLOCKFLOW_ALLOWED_ORIGINS": "  "}, None, "127.0.0.1"),
    # The environment wins over .env, as in backend/config.py: an empty value there means unset.
    ({"BLOCKFLOW_ALLOWED_ORIGINS": ""}, "BLOCKFLOW_ALLOWED_ORIGINS=http://mac.local:47300\n", "127.0.0.1"),
    ({}, "BLOCKFLOW_ALLOWED_ORIGINS=\n", "127.0.0.1"),
])
def test_frontend_host(tmp_path, environ, env_file, expected):
    path = tmp_path / ".env"
    if env_file is not None:
        path.write_text(env_file, encoding="utf-8")
    assert lp.frontend_host(environ, path) == expected


def test_the_backend_reads_the_env_file_with_the_same_parser(tmp_path, monkeypatch):
    path = tmp_path / ".env"
    path.write_text("BLOCKFLOW_ALLOWED_ORIGINS=\"http://mac.local:47300\"\nexport_me\n", encoding="utf-8")
    # setenv first, so monkeypatch restores the variable (unset) after the test.
    monkeypatch.setenv("BLOCKFLOW_ALLOWED_ORIGINS", "placeholder")
    monkeypatch.delenv("BLOCKFLOW_ALLOWED_ORIGINS")
    config._load_env_file(path)
    assert os.environ["BLOCKFLOW_ALLOWED_ORIGINS"] == lp.read_env_file(path)["BLOCKFLOW_ALLOWED_ORIGINS"]
    assert lp.frontend_host({}, path) == lp.ALL_IPV4_HOST


def test_the_built_server_and_dev_bind_the_given_host():
    app = _app()
    env = app._frontend_env(backend_port=48201, frontend_port=48200, host="127.0.0.1", base={"PATH": "/bin"})
    assert env["HOSTNAME"] == "127.0.0.1"
    command, _ = app._frontend_command(packaged=False, frontend_port=4123, host="127.0.0.1")
    assert command == ["npm", "run", "dev", "--", "--port", "4123", "--hostname", "127.0.0.1"]
    command, _ = app._frontend_command(packaged=False, frontend_port=4123, host="0.0.0.0")
    assert command[-2:] == ["--hostname", "0.0.0.0"]


@pytest.mark.parametrize("host,says", [
    ("127.0.0.1", ["this computer only", "BLOCKFLOW_ALLOWED_ORIGINS"]),
    ("0.0.0.0", ["every network address", "BLOCKFLOW_ALLOWED_ORIGINS"]),
])
def test_one_launcher_line_says_where_it_listens_and_how_to_change_it(host, says):
    line = _app()._listen_line(host)
    assert line.startswith("[app] ") and "\n" not in line
    for text in says:
        assert text in line
    assert "restart" in line  # decided when the web interface starts


# ------------------------------------------------------------------ the stored preference


def _settings_db(path: Path, value: str | None, *, table: bool = True) -> Path:
    """A settings database as backend.settings_store writes it, plus a key the
    launcher must never read."""
    conn = sqlite3.connect(path)
    if table:
        conn.execute("CREATE TABLE settings_app_prefs (name TEXT PRIMARY KEY, value TEXT, updated_at TEXT)")
        conn.execute("CREATE TABLE settings_credentials (name TEXT PRIMARY KEY, value TEXT, updated_at TEXT)")
        conn.execute("INSERT INTO settings_credentials VALUES ('kie_api_key', 'secret-value', '')")
        if value is not None:
            conn.execute("INSERT INTO settings_app_prefs VALUES ('allowed_origins', ?, '')", (value,))
    conn.commit()
    conn.close()
    return path


@pytest.mark.parametrize("value,expected", [
    ('["http://192.168.1.20:47300"]', "0.0.0.0"),
    ("http://mac.local:47300", "0.0.0.0"),  # the backend also accepts a plain string
    ("[]", "127.0.0.1"),
    ("", "127.0.0.1"),
    ('["*", "ftp://x", "   "]', "127.0.0.1"),  # nothing the backend would accept
    ("not json, not an origin", "127.0.0.1"),
    (None, "127.0.0.1"),
])
def test_the_stored_preference_counts_like_the_variable(tmp_path, value, expected):
    db = _settings_db(tmp_path / "run_history.db", value)
    assert lp.frontend_host({}, tmp_path / ".env", db) == expected


def test_a_missing_or_unreadable_settings_database_is_not_set_and_is_never_created(tmp_path):
    missing = tmp_path / "data" / "run_history.db"
    assert lp.frontend_host({}, tmp_path / ".env", missing) == lp.LOOPBACK_HOST
    assert not missing.exists() and not missing.parent.exists()
    no_table = _settings_db(tmp_path / "empty.db", None, table=False)
    assert lp.frontend_host({}, tmp_path / ".env", no_table) == lp.LOOPBACK_HOST
    garbage = tmp_path / "garbage.db"
    garbage.write_bytes(b"this is not a database" * 100)
    assert lp.frontend_host({}, tmp_path / ".env", garbage) == lp.LOOPBACK_HOST
    assert garbage.read_bytes() == b"this is not a database" * 100


def test_the_variable_still_decides_alone_when_set(tmp_path):
    db = _settings_db(tmp_path / "run_history.db", None)
    env = {"BLOCKFLOW_ALLOWED_ORIGINS": "http://192.168.1.20:47300"}
    assert lp.frontend_host(env, tmp_path / ".env", db) == lp.ALL_IPV4_HOST


def test_the_launcher_finds_the_database_the_backend_uses(tmp_path, monkeypatch):
    monkeypatch.setenv("BLOCKFLOW_DATA_DIR", str(tmp_path / "data"))
    assert lp.settings_db_path(os.environ) == tmp_path / "data" / "run_history.db"
    from backend import settings_store

    # The backend's settings tables live in <data folder>/run_history.db.
    assert config.RUN_HISTORY_DB_PATH.name == settings_store.DB_PATH.name == lp.SETTINGS_DB_NAME
    assert config.resolve_user_data_dir() == tmp_path / "data"
    from backend import origin_guard

    assert origin_guard.ORIGINS_PREF == lp.ORIGINS_PREF == "allowed_origins"
    assert origin_guard.parse_origins is lp.parse_origins


def test_the_preference_is_read_again_each_time_the_web_interface_starts(tmp_path, monkeypatch):
    app = _app()
    monkeypatch.setenv("BLOCKFLOW_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("BLOCKFLOW_ALLOWED_ORIGINS", "")
    monkeypatch.setattr(app, "ROOT", tmp_path)  # no repository .env
    db = _settings_db(tmp_path / "run_history.db", None)
    assert app._current_frontend_host() == lp.LOOPBACK_HOST
    conn = sqlite3.connect(db)
    conn.execute("INSERT INTO settings_app_prefs VALUES ('allowed_origins', '[\"http://mac.local:47300\"]', '')")
    conn.commit()
    conn.close()
    # what a supervisor restart of the web interface calls
    assert app._current_frontend_host() == lp.ALL_IPV4_HOST


def test_app_py_still_imports_with_the_standard_library_only():
    code = ("import sys, importlib.util; spec = importlib.util.spec_from_file_location('a', 'app.py'); "
            "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); "
            "bad = [n for n in ('fastapi', 'starlette', 'pydantic', 'backend.config', 'backend.settings_store') "
            "if n in sys.modules]; assert not bad, bad")
    subprocess.run([sys.executable, "-c", code], cwd=ROOT, check=True)
