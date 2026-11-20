"""What ``app.py`` and the backend agree on, declared once.

``app.py`` imports this module before any dependency is installed, so it uses
the standard library only and imports nothing else from ``backend``.

The control-file protocol: ``app.py`` gives the backend a private folder in
``BLOCKFLOW_SUPERVISOR_DIR`` and polls it about once a second; the backend
asks by creating a request file there (see ``backend/app_update/supervisor.py``).
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from collections.abc import Iterable, Mapping
from enum import StrEnum
from pathlib import Path
from urllib.parse import urlsplit

SUPERVISOR_ENV = "BLOCKFLOW_SUPERVISOR_DIR"
# Extra browser origins the backend accepts (backend/origin_guard.py), from the
# environment variable or the stored app preference (Settings API). Either is
# how a user says "I use this app from another device", so they also decide
# where the web interface listens (``frontend_host``).
ORIGINS_ENV = "BLOCKFLOW_ALLOWED_ORIGINS"
ORIGINS_PREF = "allowed_origins"
# The user data folder (backend/config.py) and the database in it that holds
# the settings tables (backend/settings_store.py) next to the run history.
DIR_NAME = "BlockFlow Studio"
DIR_SLUG = "blockflow-studio"
SETTINGS_DB_NAME = "run_history.db"
LOOPBACK_HOST = "127.0.0.1"
ALL_IPV4_HOST = "0.0.0.0"
LAUNCH_MODE_ENV = "BLOCKFLOW_LAUNCH_MODE"


class ControlFile(StrEnum):
    """File names in the control folder. The first three are requests from the
    backend; ``FRONTEND_PAUSED`` is app.py's answer to a pause."""

    PAUSE_FRONTEND = "pause-frontend"    # stop the web server (before files under it change)
    RESUME_FRONTEND = "resume-frontend"  # start the web server again
    RESTART = "restart"                  # stop and start both processes (picks up new code)
    FRONTEND_PAUSED = "frontend-paused"  # app.py: the web server is stopped


# The order app.py handles requests in, each tick. A restart wins: it replaces
# both processes with fresh ones, so a pause or resume still waiting was made
# for the processes being replaced and is dropped with them (acting on it
# afterwards would stop the new web server for an update that is over).
# Pause comes before resume so that a pause and a resume seen in the same tick
# end with the web server running, as the backend asked last.
REQUEST_ORDER: tuple[ControlFile, ...] = (ControlFile.RESTART, ControlFile.PAUSE_FRONTEND,
                                          ControlFile.RESUME_FRONTEND)


class LaunchMode(StrEnum):
    """How the backend was started: the ``BLOCKFLOW_LAUNCH_MODE`` value app.py
    sets, or ``unknown`` when the backend was started some other way (uvicorn
    directly, a debugger) and nothing supervises it. ``dev`` is ``uv run
    app.py --dev`` (the Next.js development server); ``packaged`` is the built
    web interface on the standalone server: ``uv run app.py`` (which builds it
    when needed) and ``uv run app.py --packaged`` (which never builds).
    ``/api/app/version`` reports it as ``launch_mode``."""

    DEV = "dev"
    PACKAGED = "packaged"
    UNKNOWN = "unknown"

    @classmethod
    def parse(cls, value: object) -> LaunchMode:
        """A mode from an env value or a member; anything else is ``unknown``."""
        try:
            return cls(value)
        except ValueError:
            return cls.UNKNOWN

    @property
    def supervised(self) -> bool:
        """app.py started this backend and can restart it."""
        return self in SUPERVISED_MODES

    @property
    def frontend_label(self) -> str:
        """The Next.js server kind app.py prints: ``dev`` or ``standalone``."""
        return "standalone" if self is LaunchMode.PACKAGED else "dev"


SUPERVISED_MODES: frozenset[LaunchMode] = frozenset({LaunchMode.DEV, LaunchMode.PACKAGED})


def read_env_file(path: Path) -> dict[str, str]:
    """``KEY=value`` lines of a ``.env`` file (quotes stripped; blank lines,
    comments and lines without ``=`` skipped). Missing file: empty. The backend
    loads the repository ``.env`` with this (``backend/config.py``)."""
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        if key:
            values[key] = val.strip().strip('"').strip("'")
    return values


def resolve_user_data_dir(environ: Mapping[str, str] | None = None) -> Path:
    """The user data folder; ``backend.config.resolve_user_data_dir`` is this.
    Resolution order:
      1. $BLOCKFLOW_DATA_DIR (explicit override; respected verbatim).
      2. $BLOCKFLOW_HOME (portable product home; respected verbatim).
      3. macOS:   ~/Library/Application Support/BlockFlow Studio
      3. Linux:   $XDG_DATA_HOME/blockflow-studio if set, else ~/.local/share/blockflow-studio
      4. Windows: %LOCALAPPDATA%\\BlockFlow Studio if set, else ~/AppData/Local/BlockFlow Studio
                  (LOCALAPPDATA is machine-local — right choice for a multi-GB
                  SQLite DB; APPDATA would sync via Windows roaming profiles.)
      5. Other:   ~/.blockflow-studio (catch-all so worktrees don't fragment).

    The names differ from the original BlockFlow app's folder on purpose: that
    folder holds the original app's database, which this app must not open.
    Nothing is migrated from it.
    """
    env = os.environ if environ is None else environ
    explicit = env.get("BLOCKFLOW_DATA_DIR")
    if explicit:
        return Path(explicit).expanduser()
    home = env.get("BLOCKFLOW_HOME")
    if home:
        return Path(home).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / DIR_NAME
    if sys.platform.startswith("linux"):
        xdg = env.get("XDG_DATA_HOME")
        if xdg:
            return Path(xdg) / DIR_SLUG
        return Path.home() / ".local" / "share" / DIR_SLUG
    if sys.platform == "win32" or sys.platform.startswith("cygwin"):
        local_appdata = env.get("LOCALAPPDATA")
        if local_appdata:
            return Path(local_appdata) / DIR_NAME
        return Path.home() / "AppData" / "Local" / DIR_NAME
    return Path.home() / f".{DIR_SLUG}"


def settings_db_path(environ: Mapping[str, str]) -> Path:
    """The database holding the app preferences, as the backend resolves it."""
    return resolve_user_data_dir(environ) / SETTINGS_DB_NAME


def parse_origins(raw: str | Iterable[str] | None) -> list[str]:
    """Normalised ``scheme://host[:port]`` origins; wildcards and anything
    that is not http(s) are dropped. ``backend.origin_guard`` uses this."""
    if raw is None:
        return []
    items = raw.split(",") if isinstance(raw, str) else list(raw)
    out: list[str] = []
    for item in items:
        if not isinstance(item, str):
            continue
        value = item.strip()
        if not value or "*" in value:
            continue
        try:
            parts = urlsplit(value)
        except ValueError:
            continue
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
            continue
        origin = f"{parts.scheme}://{parts.netloc}".lower()
        if origin not in out:
            out.append(origin)
    return out


def parse_origins_pref(raw: str | None) -> list[str]:
    """The stored ``allowed_origins`` value (a JSON list, or a plain string)."""
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except ValueError:
        value = raw
    return parse_origins(value if isinstance(value, (list, str)) else None)


def stored_origins(db_path: Path) -> list[str]:
    """The origins in the stored ``allowed_origins`` preference, read-only:
    the database is opened in read-only mode (never created) and only that one
    preference row is read. A missing or unreadable database is none."""
    if not db_path.is_file():
        return []
    try:
        conn = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
        try:
            row = conn.execute("SELECT value FROM settings_app_prefs WHERE name = ?", (ORIGINS_PREF,)).fetchone()
        finally:
            conn.close()
    except (sqlite3.Error, OSError, ValueError):
        return []
    return parse_origins_pref(row[0] if row and isinstance(row[0], str) else None)


def frontend_host(environ: Mapping[str, str], env_file: Path, settings_db: Path | None = None) -> str:
    """Where the web interface listens: ``127.0.0.1`` (this computer only),
    or every IPv4 address when ``BLOCKFLOW_ALLOWED_ORIGINS`` is set to
    something (read like the backend reads it: the environment first, else
    ``env_file``; blank is not set) or the stored ``allowed_origins``
    preference in ``settings_db`` holds at least one origin. Decided when the
    web interface starts: a change applies at its next start."""
    value = environ[ORIGINS_ENV] if ORIGINS_ENV in environ else read_env_file(env_file).get(ORIGINS_ENV, "")
    if value.strip():
        return ALL_IPV4_HOST
    if settings_db is not None and stored_origins(settings_db):
        return ALL_IPV4_HOST
    return LOOPBACK_HOST
