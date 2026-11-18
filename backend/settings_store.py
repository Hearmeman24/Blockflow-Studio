"""Settings store: credentials and app preferences.

Backed by the same sqlite file as `backend.db` (run_history.db). Two tables
coexist with the existing `runs` table:

  - `settings_credentials`: name -> value (provider API keys)
  - `settings_app_prefs`: name -> value (output dir, retention policy, ...)

Databases created by older builds may also hold `settings_endpoints`,
`settings_installed_presets`, `settings_credential_validations` and
credential rows for removed services. They are left in place and never read.

Credential names are allow-listed (`ALLOWED_CREDENTIALS`). The store refuses
to write or delete any other name and reads any other name as unset, so
legacy rows never surface. Callers that show credentials to a user go through
`credential_status`, which never includes the value. Nothing here logs a value.

The database file holds plain-text keys, so it is restricted to the current
user (0600) whenever the store creates, opens for init, or writes a key.
"""
from __future__ import annotations

import logging
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend import config

logger = logging.getLogger(__name__)

# Same file as backend.db.DB_PATH — settings tables coexist with `runs`.
DB_PATH: Path = config.RUN_HISTORY_DB_PATH

# Kie and PiAPI drive generation. openrouter_api_key is optional and only
# used by the Prompt Writer block (backend/prompt_writer/).
ALLOWED_CREDENTIALS: tuple[str, ...] = ("kie_api_key", "piapi_api_key", "openrouter_api_key")
MAX_CREDENTIAL_LENGTH = 512
# Shown only when the key is long enough that four characters reveal little.
MIN_LENGTH_FOR_LAST4 = 12

ONBOARDING_COMPLETED_PREF = "onboarding_completed"

_lock = threading.Lock()


class UnknownCredentialError(ValueError):
    """Raised for a credential name outside ALLOWED_CREDENTIALS."""


class InvalidCredentialValue(ValueError):
    """Raised for an unusable key value. The message never contains the value."""


def is_allowed_credential(name: str) -> bool:
    return name in ALLOWED_CREDENTIALS


def _require_allowed(name: str) -> None:
    if not is_allowed_credential(name):
        raise UnknownCredentialError("Unknown credential name.")


def _restrict_permissions(path: Path) -> None:
    """Best-effort chmod 0600. Platforms without POSIX modes are skipped."""
    try:
        if path.exists():
            os.chmod(path, 0o600)
    except OSError:
        logger.warning("could not restrict permissions on the settings database")


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _create_private_file(path: Path) -> None:
    """Create the DB file with 0600 before sqlite does, so it is never
    briefly world-readable. No-op if it already exists."""
    try:
        fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    except FileExistsError:
        return
    except OSError:
        logger.warning("could not pre-create the settings database with private permissions")
        return
    os.close(fd)


def init_db() -> None:
    """Create the settings tables if absent and restrict the file. Idempotent."""
    with _lock:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _create_private_file(DB_PATH)
        _restrict_permissions(DB_PATH)
        conn = _get_conn()
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS settings_credentials (
                    name TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS settings_app_prefs (
                    name TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )
            conn.commit()
        finally:
            conn.close()


# === credential values ======================================================

def normalize_credential_value(value: str) -> str:
    """Trim and check a key typed by the user. Returns the trimmed value.

    Rejects empty values, inner whitespace, characters outside printable
    ASCII (keys are ASCII and travel in HTTP headers) and values over
    MAX_CREDENTIAL_LENGTH. Error messages never include the value.
    """
    trimmed = value.strip()
    if not trimmed:
        raise InvalidCredentialValue("API key is empty. Paste the key from your provider dashboard.")
    if len(trimmed) > MAX_CREDENTIAL_LENGTH:
        raise InvalidCredentialValue(
            f"API key is too long. Keys can be at most {MAX_CREDENTIAL_LENGTH} characters."
        )
    if any(ch.isspace() for ch in trimmed):
        raise InvalidCredentialValue("API key must not contain spaces or line breaks.")
    if any(not (0x21 <= ord(ch) <= 0x7E) for ch in trimmed):
        raise InvalidCredentialValue(
            "API key contains characters that are not allowed. "
            "Copy the key again from your provider dashboard."
        )
    return trimmed


def mask_last4(value: str | None) -> str | None:
    """The last four characters, only for keys of at least MIN_LENGTH_FOR_LAST4."""
    if not value or len(value) < MIN_LENGTH_FOR_LAST4:
        return None
    return value[-4:]


# === credentials ============================================================

def set_credential(name: str, value: str) -> None:
    """Store a key. The name must be allow-listed; the value is stored as given
    (callers taking user input run normalize_credential_value first)."""
    _require_allowed(name)
    with _lock:
        conn = _get_conn()
        try:
            conn.execute(
                """
                INSERT INTO settings_credentials (name, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                """,
                (name, value, _now()),
            )
            conn.commit()
        finally:
            conn.close()
        _restrict_permissions(DB_PATH)


def _read_row(name: str) -> sqlite3.Row | None:
    if not is_allowed_credential(name):
        return None
    conn = _get_conn()
    try:
        return conn.execute(
            "SELECT value, updated_at FROM settings_credentials WHERE name = ?", (name,)
        ).fetchone()
    finally:
        conn.close()


def get_credential(name: str) -> str | None:
    """The stored value for an allow-listed name, else None. Backend-only:
    never return this from an HTTP route."""
    row = _read_row(name)
    return row["value"] if row else None


def get_credential_updated_at(name: str) -> str | None:
    row = _read_row(name)
    return row["updated_at"] if row else None


def credential_status(name: str) -> dict[str, Any]:
    """`{name, configured, last4, updated_at}` for an allow-listed name."""
    _require_allowed(name)
    row = _read_row(name)
    value = (row["value"] or "").strip() if row else ""
    return {
        "name": name,
        "configured": bool(value),
        "last4": mask_last4(value),
        "updated_at": row["updated_at"] if row else None,
    }


def list_credential_statuses() -> list[dict[str, Any]]:
    return [credential_status(name) for name in ALLOWED_CREDENTIALS]


def delete_credential(name: str) -> None:
    _require_allowed(name)
    with _lock:
        conn = _get_conn()
        try:
            conn.execute("DELETE FROM settings_credentials WHERE name = ?", (name,))
            conn.commit()
        finally:
            conn.close()


# === app_prefs ==============================================================

def set_app_pref(name: str, value: str) -> None:
    with _lock:
        conn = _get_conn()
        try:
            conn.execute(
                """
                INSERT INTO settings_app_prefs (name, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                """,
                (name, value, _now()),
            )
            conn.commit()
        finally:
            conn.close()


def get_app_pref(name: str, default: str | None = None) -> str | None:
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT value FROM settings_app_prefs WHERE name = ?", (name,)
        ).fetchone()
    finally:
        conn.close()
    return row["value"] if row else default

