"""The update check: the newest release of the configured GitHub repository.

One unauthenticated GET to ``api.github.com/repos/<repo>/releases`` (the
``/releases/latest`` endpoint ignores pre-releases, and the beta ships
pre-releases). Nothing about the user is sent: a generic User-Agent, no
token, no cookies, no identifiers.

- At most one automatic check every 6 hours (persisted, so restarts do not
  re-check), plus on demand (``status(force=True)``).
- Conditional requests (ETag), a short timeout and a size cap. Only the
  fields the UI needs are cached, in ``<user data>/updates/releases.json``,
  and only for the repository they came from.
- A 404 (repository not published yet), 403/429 (rate limit) or a network
  failure becomes a quiet ``status``; the last good result stays in use.
  Nothing here raises into a request or logs above INFO.
- Release text is untrusted: control characters are removed, length is
  capped, and the release URL is rebuilt for the configured repository. The
  UI renders it as plain text.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from backend.app_update import settings
from backend.app_update import version as semver
from backend.byok.errors import ProviderError
from backend.byok.http import HttpResponse, Transport, UrllibTransport

logger = logging.getLogger(__name__)

API_URL = "https://api.github.com/repos/{repo}/releases?per_page=30"
USER_AGENT = "BlockFlow-update-check"
CHECK_INTERVAL_S = 6 * 3600
TIMEOUT_S = 8.0
MAX_BYTES = 3_000_000
MAX_NOTES = 8_000
MAX_NAME = 200
MAX_RELEASES = 100

_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩]")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

MESSAGES = {
    "ok": "Checked for updates.",
    "disabled": "Update checks are turned off.",
    "not_configured": "No release repository is configured.",
    "not_found": "No releases are published yet.",
    "rate_limited": "GitHub is limiting requests right now; BlockFlow will try again later.",
    "offline": "Could not reach GitHub. BlockFlow will try again later.",
    "error": "GitHub answered with an error. BlockFlow will try again later.",
    "invalid": "GitHub sent an answer BlockFlow could not read.",
    "too_large": "GitHub sent an unexpectedly large answer.",
    "never": "Not checked yet.",
}


def clean_text(value: Any, limit: int) -> tuple[str, bool]:
    """Plain text: newlines normalised, control and bidi characters removed,
    at most ``limit`` characters. Returns (text, truncated)."""
    if not isinstance(value, str):
        return "", False
    text = _CONTROL_RE.sub("", value.replace("\r\n", "\n").replace("\r", "\n").replace("\t", "    "))
    text = text.strip()
    if len(text) > limit:
        return text[: limit - 1].rstrip() + "…", True
    return text, False


def release_url(repo: str, tag: str) -> str:
    return f"https://github.com/{repo}/releases/tag/{quote(tag, safe='')}"


def normalise(raw: Any, repo: str) -> list[dict[str, Any]]:
    """The releases the updater can use, newest first. Drafts, malformed
    entries and tags that are not ``vX.Y.Z[-pre]`` are dropped."""
    out: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return out
    for item in raw[:MAX_RELEASES]:
        if not isinstance(item, dict) or item.get("draft") is True:
            continue
        tag = item.get("tag_name")
        parsed = semver.parse_tag(tag) if isinstance(tag, str) else None
        if parsed is None:
            continue
        name, _ = clean_text(item.get("name") or tag, MAX_NAME)
        notes, truncated = clean_text(item.get("body") or "", MAX_NOTES)
        published = item.get("published_at")
        out.append({
            "version": str(parsed), "tag": tag, "name": name or tag, "notes": notes, "notes_truncated": truncated,
            "published_at": published if isinstance(published, str) and _DATE_RE.match(published) else None,
            "url": release_url(repo, tag),
            "prerelease": bool(item.get("prerelease") is True or parsed.prerelease),
        })
    out.sort(key=lambda r: semver.parse(r["version"]), reverse=True)
    return out


def pick_latest(rels: list[dict[str, Any]], *, channel: str) -> dict[str, Any] | None:
    for rel in rels:  # newest first
        if channel == "stable" and rel["prerelease"]:
            continue
        return rel
    return None


class UpdateChecker:
    def __init__(self, *, cache_dir: Path, current_version: str, transport: Transport | None = None,
                 clock: Callable[[], float] = time.time) -> None:
        self.cache_dir = Path(cache_dir)
        self.current_version = current_version
        self.transport = transport or UrllibTransport()
        self.clock = clock
        self._lock = threading.Lock()

    # ------------------------------------------------------------ cache

    @property
    def _cache_path(self) -> Path:
        return self.cache_dir / "releases.json"

    def _read_cache(self) -> dict[str, Any]:
        try:
            data = json.loads(self._cache_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _write_cache(self, data: dict[str, Any]) -> None:
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            tmp = self._cache_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data), encoding="utf-8")
            os.replace(tmp, self._cache_path)
        except OSError as exc:  # a read-only data dir must not break the check
            logger.info("could not save the update check cache: %s", type(exc).__name__)

    # ------------------------------------------------------------ check

    def _fetch(self, repo: str, cache: dict[str, Any]) -> dict[str, Any]:
        """One request. Returns the new cache contents."""
        same_repo = cache.get("repo") == repo
        releases = cache.get("releases") if same_repo and isinstance(cache.get("releases"), list) else []
        base = {"repo": repo, "releases": releases, "etag": cache.get("etag") if same_repo else None,
                "checked_at": self.clock()}
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                   "User-Agent": USER_AGENT}
        if base["etag"]:
            headers["If-None-Match"] = base["etag"]
        try:
            resp: HttpResponse = self.transport("GET", API_URL.format(repo=repo), headers, None, TIMEOUT_S)
        except ProviderError:
            return {**base, "status": "offline"}
        except Exception as exc:  # noqa: BLE001 - never raise into a request
            logger.info("update check failed: %s", type(exc).__name__)
            return {**base, "status": "offline"}
        lower = {k.lower(): v for k, v in (resp.headers or {}).items()}
        if resp.status == 304:
            return {**base, "status": "ok"}
        if resp.status == 404:
            return {**base, "status": "not_found"}
        if resp.status == 429 or (resp.status == 403 and lower.get("x-ratelimit-remaining") == "0"):
            return {**base, "status": "rate_limited"}
        if resp.status != 200:
            return {**base, "status": "error", "http_status": resp.status}
        declared = lower.get("content-length", "")
        if (declared.isdigit() and int(declared) > MAX_BYTES) or len(resp.body) > MAX_BYTES:
            return {**base, "status": "too_large"}
        try:
            raw = json.loads(resp.body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return {**base, "status": "invalid"}
        if not isinstance(raw, list):
            return {**base, "status": "invalid"}
        return {**base, "status": "ok", "releases": normalise(raw, repo), "etag": lower.get("etag")}

    def check(self, *, force: bool = False) -> dict[str, Any]:
        """Run a check when due (or ``force``); returns the cache contents."""
        repo = settings.repo()
        with self._lock:
            cache = self._read_cache()
            if not repo or not settings.checks_enabled():
                return cache
            last = cache.get("checked_at") if cache.get("repo") == repo else None
            due = not isinstance(last, (int, float)) or self.clock() - last >= CHECK_INTERVAL_S or last > self.clock()
            if not (force or due):
                return cache
            cache = self._fetch(repo, cache)
            self._write_cache(cache)
            return cache

    # ------------------------------------------------------------ status

    def _dismissed(self, tag: str) -> str | None:
        if settings._pref(settings.SKIP_PREF) == tag:
            return "skipped"
        raw = settings._pref(settings.SNOOZE_PREF)
        try:
            snooze = json.loads(raw) if raw else None
        except ValueError:
            snooze = None
        if isinstance(snooze, dict) and snooze.get("tag") == tag and isinstance(snooze.get("until"), (int, float)):
            if snooze["until"] > self.clock():
                return "snoozed"
        return None

    def status(self, *, force: bool = False, network: bool = True) -> dict[str, Any]:
        """The update status. ``network=False`` answers from the cache only."""
        cache = self.check(force=force) if network else self._read_cache()
        repo = settings.repo()
        channel = settings.channel(self.current_version)
        enabled = settings.checks_enabled()
        if not repo:
            status = "not_configured"
        elif not enabled:
            status = "disabled"
        elif cache.get("repo") != repo:
            status = "never"
        else:
            status = cache.get("status") if cache.get("status") in MESSAGES else "error"
        usable = enabled and cache.get("repo") == repo and isinstance(cache.get("releases"), list)
        rels = cache["releases"] if usable else []
        latest = pick_latest(rels, channel=channel) if repo else None
        current = semver.parse(self.current_version)
        newer = bool(latest and current and semver.parse(latest["version"]) > current)
        dismissed = self._dismissed(latest["tag"]) if newer and latest else None
        return {
            "current": self.current_version,
            "latest": latest,
            "update_available": newer,
            "notify": newer and dismissed is None,
            "dismissed": dismissed,
            "checked_at": cache.get("checked_at") if cache.get("repo") == repo else None,
            "status": status,
            "message": MESSAGES[status],
            "channel": channel,
            "checks_enabled": enabled,
            "repo": repo,
            "check_interval_hours": CHECK_INTERVAL_S // 3600,
        }
