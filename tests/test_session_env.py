"""The pytest session runs in a known environment, not the shell's.

Importing the backend never touches the user's real data folder, and the
ports and allowed origins are the defaults (tests/conftest.py)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from backend import config, db


def _real_default() -> Path:
    # What resolve_user_data_dir returns with no override, computed by hand so
    # the check does not depend on the code under test.
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "BlockFlow Studio"
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "BlockFlow Studio"
    xdg = os.environ.get("XDG_DATA_HOME")
    return (Path(xdg) if xdg else Path.home() / ".local" / "share") / "blockflow-studio"


def test_import_time_data_folder_is_not_the_real_default():
    real = _real_default()
    assert config.USER_DATA_DIR.resolve() != real.resolve()
    assert real.resolve() not in config.USER_DATA_DIR.resolve().parents
    assert Path(db.DB_PATH).resolve().parent != real.resolve()
    assert Path(config.RUN_HISTORY_DB_PATH).resolve().parent != real.resolve()


def test_session_does_not_carry_port_or_origin_settings_from_the_shell():
    # conftest normalises these before any backend import, so a developer's
    # shell cannot change what the tests see.
    from backend import main
    from backend.origin_guard import OriginGuard

    for name in ("FRONTEND_PORT", "BACKEND_PORT", "BLOCKFLOW_ALLOWED_ORIGINS"):
        assert not os.environ.get(name), f"{name} leaked from the shell into the test session"
    guard = next(m for m in main.app.user_middleware if m.cls is OriginGuard)
    static = guard.kwargs["origins"].static
    assert "http://localhost:47300" in static and "http://localhost:47301" in static
    assert "https://evil.example" not in static
