"""Where releases come from and the user's update preferences.

The release repository is ONE constant, :data:`DEFAULT_REPO`. It can be
overridden with the ``BLOCKFLOW_UPDATE_REPO`` environment variable (wins) or
the ``update_repo`` app pref (for forks; empty means the default). A set
but empty environment variable, or an invalid value, turns updates off
rather than falling back silently.

App prefs:
  update_checks   "true" | "false"  check GitHub for releases (default true)
  update_channel  "beta" | "stable" which releases count (default below)
  update_skip_tag  a release tag the user chose to skip
  update_snooze    JSON {"tag", "until": epoch seconds} ("Remind me later")

Channel default: ``beta`` while the running version is a pre-release or 0.x
(the whole 0.x line ships as beta pre-releases), ``stable`` from 1.0.0 on.
Beta sees pre-releases and stable releases; stable sees stable releases only.
"""

from __future__ import annotations

import os
import re

from backend.app_update import version as semver

DEFAULT_REPO = "Hearmeman24/Blockflow-Studio"
REPO_ENV = "BLOCKFLOW_UPDATE_REPO"
REPO_PREF = "update_repo"
CHECKS_PREF = "update_checks"
CHANNEL_PREF = "update_channel"
SKIP_PREF = "update_skip_tag"
SNOOZE_PREF = "update_snooze"
CHANNELS = ("beta", "stable")
SNOOZE_SECONDS = 24 * 3600

_REPO_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$")


def _pref(name: str) -> str | None:
    from backend import settings_store

    try:
        return settings_store.get_app_pref(name)
    except Exception:  # noqa: BLE001 - an unreadable settings DB means "unset"
        return None


def valid_repo(value: object) -> str:
    value = value.strip() if isinstance(value, str) else ""
    if not _REPO_RE.match(value) or ".." in value or value.endswith(".git"):
        return ""
    return value


def repo() -> str:
    """``owner/name`` of the release repository, or ``""`` (updates off)."""
    raw = os.environ.get(REPO_ENV)
    if raw is not None:  # a set but empty variable turns updates off
        return valid_repo(raw) if raw.strip() else ""
    raw = _pref(REPO_PREF)
    return valid_repo(raw) if raw and raw.strip() else DEFAULT_REPO


def checks_enabled() -> bool:
    return _pref(CHECKS_PREF) != "false"


def default_channel(current: str) -> str:
    v = semver.parse(current)
    return "beta" if v is None or v.prerelease or v.major == 0 else "stable"


def channel(current: str) -> str:
    value = _pref(CHANNEL_PREF)
    return value if value in CHANNELS else default_channel(current)
