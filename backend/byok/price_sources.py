"""Which price ledger is active: a refreshed remote copy, or the bundled one.

The only network call is an HTTP GET for one static JSON file at
``PRICE_LEDGER_URL``; nothing about the user, their keys or their jobs is
sent. Refresh is off while no URL is configured (the default) or when the
user turns ``price_ledger_updates`` off in Settings.

- Conditional requests (ETag / If-Modified-Since), a short timeout and a size
  cap; the body must pass ``price_ledger.validate_ledger``.
- The last good copy is cached in the user data dir (``price_ledger/``) and
  used only for the URL it came from.
- At most one automatic refresh every 12 hours (``refresh(force=True)`` for
  on demand). A remote ledger older than the bundled one is ignored.
- Every failure falls back to the cached copy, then the bundled one, and is
  reported through ``status()``; nothing here raises into a request.

Configuration: ``PRICE_LEDGER_URL`` / ``PRICE_LEDGER_REPO`` (GitHub
``owner/name``, used only for "report a price change" links) come from the
environment, then the app prefs ``price_ledger_url`` / ``price_ledger_repo``,
then the defaults below (the public ledger repository). A set but empty
environment variable or pref turns that part off. A 404 from the URL (the
file is not published yet) is reported quietly as ``not_available``.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

from backend.byok import price_ledger
from backend.byok.errors import ProviderError
from backend.byok.http import Transport, UrllibTransport
from backend.statuses import PriceRefreshStatus

logger = logging.getLogger(__name__)

PRICE_LEDGER_URL = "https://raw.githubusercontent.com/Hearmeman24/blockflow-prices/main/prices.json"
PRICE_LEDGER_REPO = "Hearmeman24/blockflow-prices"
URL_ENV, REPO_ENV = "PRICE_LEDGER_URL", "PRICE_LEDGER_REPO"
URL_PREF, REPO_PREF, UPDATES_PREF = "price_ledger_url", "price_ledger_repo", "price_ledger_updates"

REFRESH_INTERVAL_S = 12 * 3600
TIMEOUT_S = 10.0
MAX_BYTES = 2_000_000
USER_AGENT = "BlockFlow price ledger"
AUTO_REFRESH = True  # start a background refresh from active_ledger() when one is due

_REPO_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$")


def _default_cache_dir() -> Path:
    from backend import config

    return config.USER_DATA_DIR / "price_ledger"


CACHE_DIR: Path | None = None  # tests point this at tmp_path
transport: Transport = UrllibTransport()
clock: Callable[[], float] = time.time

_lock = threading.Lock()
_state: dict[str, Any] = {}


def reset_state() -> None:
    with _lock:
        _state.clear()


def _cache_dir() -> Path:
    return CACHE_DIR if CACHE_DIR is not None else _default_cache_dir()


# ------------------------------------------------------------------ configuration


def _pref(name: str) -> str | None:
    from backend import settings_store

    try:
        return settings_store.get_app_pref(name)
    except Exception:  # noqa: BLE001 - an unreadable settings DB means "unset"
        return None


def valid_url(value: Any) -> str:
    """``value`` if it is a plain https URL (no credentials), else ``""``."""
    if not isinstance(value, str):
        return ""
    value = value.strip()
    try:
        parts = urlsplit(value)
    except ValueError:
        return ""
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or " " in value:
        return ""
    return value


def valid_repo(value: Any) -> str:
    value = value.strip() if isinstance(value, str) else ""
    return value if _REPO_RE.match(value) and ".." not in value else ""


def _setting(env: str, pref: str, default: str) -> str:
    """The environment wins, then the app pref, then the default. A set but
    empty value means "off" and is returned as ``""``."""
    value = os.environ.get(env)
    if value is not None:
        return value.strip()
    value = _pref(pref)
    if value is not None:
        return value.strip()
    return default


def configured_url() -> str:
    value = _setting(URL_ENV, URL_PREF, PRICE_LEDGER_URL)
    return valid_url(value) if value else ""


def configured_repo() -> str:
    value = _setting(REPO_ENV, REPO_PREF, PRICE_LEDGER_REPO)
    return valid_repo(value) if value else ""


def updates_enabled() -> bool:
    return _pref(UPDATES_PREF) != "false"


# ------------------------------------------------------------------ loading


def _when(ledger: price_ledger.Ledger) -> datetime:
    return datetime.fromisoformat(ledger.generated_at.replace("Z", "+00:00"))


def _memo_load(path: Path) -> price_ledger.Ledger | None:
    """Load and validate ``path`` once per modification time."""
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        return None
    key = ("file", str(path))
    with _lock:
        hit = _state.get(key)
        if hit and hit[0] == mtime:
            return hit[1]
    try:
        ledger = price_ledger.load_file(path)
    except price_ledger.LedgerError as exc:
        logger.warning("ignoring price ledger %s: %s", path.name, exc)
        ledger = None
    with _lock:
        _state[key] = (mtime, ledger)
    return ledger


def bundled() -> price_ledger.Ledger:
    ledger = _memo_load(price_ledger.BUNDLED_PATH)
    if ledger is None:
        raise price_ledger.LedgerError("the bundled price ledger is missing or invalid")
    return ledger


def _meta() -> dict[str, Any]:
    try:
        data = json.loads((_cache_dir() / "meta.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _cached(url: str) -> price_ledger.Ledger | None:
    if not url or _meta().get("url") != url:
        return None
    return _memo_load(_cache_dir() / "prices.json")


def active_ledger() -> tuple[price_ledger.Ledger, str]:
    """``(ledger, "ledger" | "bundled")``. Never raises for remote problems."""
    base = bundled()
    url = configured_url()
    if not url or not updates_enabled():
        return base, "bundled"
    if AUTO_REFRESH:
        _refresh_in_background()
    remote = _cached(url)
    if remote is not None and _when(remote) > _when(base):
        return remote, "ledger"
    return base, "bundled"


# ------------------------------------------------------------------ refresh


def _record(result: dict[str, Any]) -> dict[str, Any]:
    result = {**result, "at": clock()}
    with _lock:
        _state["last_result"] = result
    return result


def _write_cache(body: bytes, meta: dict[str, Any]) -> None:
    directory = _cache_dir()
    directory.mkdir(parents=True, exist_ok=True)
    for name, data in (("prices.json", body), ("meta.json", json.dumps(meta).encode())):
        tmp = directory / f".{name}.tmp"
        tmp.write_bytes(data)
        os.replace(tmp, directory / name)


def refresh(force: bool = False) -> dict[str, Any]:
    """Fetch the remote ledger if due (or ``force``). Returns
    ``{ok, status, message?, at}``; ``status`` is one of updated |
    not_modified | skipped | not_configured | disabled | older_than_bundled |
    not_available (HTTP 404) | invalid | too_large | error."""
    url = configured_url()
    if not url:
        return _record({"ok": False, "status": PriceRefreshStatus.NOT_CONFIGURED,
                        "message": "No price ledger URL is configured."})
    if not updates_enabled():
        return _record({"ok": False, "status": PriceRefreshStatus.DISABLED, "message": "Price list updates are turned off."})
    with _lock:
        last = _state.get("last_attempt", 0.0)
        if not force and clock() - last < REFRESH_INTERVAL_S:
            return {"ok": True, "status": PriceRefreshStatus.SKIPPED, "message": "Refreshed recently.",
                    "at": _state.get("last_result", {}).get("at")}
        _state["last_attempt"] = clock()
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    meta = _meta() if _cached(url) is not None else {}
    if meta.get("etag"):
        headers["If-None-Match"] = meta["etag"]
    if meta.get("last_modified"):
        headers["If-Modified-Since"] = meta["last_modified"]
    try:
        resp = transport("GET", url, headers, None, TIMEOUT_S)
    except ProviderError as exc:
        return _record({"ok": False, "status": PriceRefreshStatus.ERROR, "message": f"Could not download the price list ({exc.kind})."})
    except Exception as exc:  # noqa: BLE001 - never raise into a request
        return _record({"ok": False, "status": PriceRefreshStatus.ERROR,
                        "message": f"Could not download the price list ({type(exc).__name__})."})
    if resp.status == 304:
        return _record({"ok": True, "status": PriceRefreshStatus.NOT_MODIFIED, "message": "The price list has not changed."})
    if resp.status == 404:
        return _record({"ok": False, "status": PriceRefreshStatus.NOT_AVAILABLE,
                        "message": "The online price list is not available yet; the bundled prices are used."})
    if resp.status != 200:
        return _record({"ok": False, "status": PriceRefreshStatus.ERROR, "message": f"The price list URL answered HTTP {resp.status}."})
    lengths = {k.lower(): v for k, v in (resp.headers or {}).items()}
    declared = lengths.get("content-length", "")
    if (declared.isdigit() and int(declared) > MAX_BYTES) or len(resp.body) > MAX_BYTES:
        return _record({"ok": False, "status": PriceRefreshStatus.TOO_LARGE,
                        "message": f"The price list is larger than {MAX_BYTES // 1_000_000} MB."})
    try:
        ledger = price_ledger.validate_ledger(json.loads(resp.body.decode("utf-8")))
    except (UnicodeDecodeError, ValueError) as exc:
        return _record({"ok": False, "status": PriceRefreshStatus.INVALID, "message": f"The price list is not valid: {str(exc)[:200]}"})
    if _when(ledger) <= _when(bundled()):
        return _record({"ok": True, "status": PriceRefreshStatus.OLDER_THAN_BUNDLED,
                        "message": "The downloaded price list is not newer than the one bundled with the app."})
    _write_cache(resp.body, {"url": url, "etag": lengths.get("etag"), "last_modified": lengths.get("last-modified"),
                             "fetched_at": clock(), "generated_at": ledger.generated_at})
    return _record({"ok": True, "status": PriceRefreshStatus.UPDATED, "message": f"Price list from {ledger.generated_date} loaded."})


def _refresh_in_background() -> None:
    with _lock:
        due = clock() - _state.get("last_attempt", 0.0) >= REFRESH_INTERVAL_S
        running = _state.get("thread")
        if not due or (running is not None and running.is_alive()):
            return
        thread = threading.Thread(target=refresh, name="price-ledger-refresh", daemon=True)
        _state["thread"] = thread
    thread.start()


def status() -> dict[str, Any]:
    base = bundled()
    active, layer = active_ledger()
    url = configured_url()
    with _lock:
        last = _state.get("last_result")

    def describe(ledger: price_ledger.Ledger) -> dict[str, Any]:
        return {"schema_version": ledger.schema_version, "generated_at": ledger.generated_at,
                "entries": len(ledger.entries)}

    return {"active": layer, "ledger": describe(active), "bundled": describe(base),
            "remote": {"configured": bool(url), "enabled": updates_enabled(), "url": url,
                       "repo": configured_repo(), "refresh_interval_hours": REFRESH_INTERVAL_S // 3600},
            "last_refresh": dict(last) if last else None}
