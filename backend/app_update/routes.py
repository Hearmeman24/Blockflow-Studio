"""Version and update routes.

  restart_automatic: BlockFlow can restart itself after an update that does
  not change app.py (an update that does asks for a manual restart).

  GET  /api/app/version             -> {version, commit, install, branch, dirty, update_supported,
                                        reason?, repo, checkout_id, restart_automatic}
  GET  /api/app/update              -> {current, latest, update_available, notify, dismissed, checked_at,
                                        status, message, channel, checks_enabled, supported, reason?,
                                        install, restart_automatic}
  POST /api/app/update/check        -> same, after a forced check
  POST /api/app/update/dismiss      {tag, action: skip|later|clear} -> same
  POST /api/app/update/apply        {tag, allow_active_jobs?} -> 202 progress
                                    | 409 {code: busy|blocked|not_supported, detail, blockers?}
  GET  /api/app/update/progress     -> {state, step, steps, log_tail, error, message, manual, restart, ...}
  POST /api/app/update/progress/ack -> progress (a finished update goes back to idle)

State-changing routes are protected by backend/origin_guard.py like every
other POST. The release check sends nothing about the user.
"""

from __future__ import annotations

import json
import shutil
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from backend import config, settings_store
from backend.app_update import engine as engine_mod
from backend.app_update import install, releases, settings
from backend.app_update import version as semver
from backend.app_update.supervisor import Supervisor, launch_mode, restarts_automatically

router = APIRouter(tags=["app-update"])

ROOT = config.ROOT_DIR
APP_VERSION = semver.read_app_version(ROOT)  # the running code's version, read once
_INSTALL_TTL_S = 10.0

_lock = threading.Lock()
_cache: dict[str, Any] = {}


def _state_dir() -> Path:
    return Path(config.USER_DATA_DIR) / "updates"


def get_checker() -> releases.UpdateChecker:
    with _lock:
        key = ("checker", str(_state_dir()))
        if key not in _cache:
            _cache[key] = releases.UpdateChecker(cache_dir=_state_dir(), current_version=APP_VERSION)
        return _cache[key]


def _latest_tag() -> str | None:
    status = get_checker().status(network=False)
    return status["latest"]["tag"] if status["update_available"] and status["latest"] else None


def get_engine() -> engine_mod.UpdateEngine:
    with _lock:
        key = ("engine", str(_state_dir()))
        if key not in _cache:
            _cache[key] = engine_mod.UpdateEngine(
                root=ROOT, state_dir=_state_dir(), supervisor=Supervisor(), launch_mode=launch_mode(),
                current_version=APP_VERSION, latest_tag=_latest_tag)
        return _cache[key]


def install_info() -> dict[str, Any]:
    with _lock:
        hit = _cache.get("install")
        if hit and time.monotonic() - hit[0] < _INSTALL_TTL_S:
            return dict(hit[1])
    info = install.detect(ROOT, which=shutil.which, repo=settings.repo(), version=APP_VERSION)
    with _lock:
        _cache["install"] = (time.monotonic(), info)
    return dict(info)


def restart_automatic() -> bool:
    """``restart_automatic`` in /api/app/version and /api/app/update: the
    engine's rule (``restarts_automatically``) before an update is fetched,
    when nobody knows yet whether it changes app.py. So it means "BlockFlow
    restarts itself after an update, unless the update changes app.py"; the
    update's own ``progress.restart.automatic`` is the final answer."""
    return restarts_automatically(supervised=Supervisor().available, mode=launch_mode(), launcher_changed=False)


def on_startup() -> None:
    """Settle an update the previous process left (restart or crash). Never raises."""
    try:
        get_engine().recover()
    except Exception as exc:  # noqa: BLE001
        print(f"[update] could not read the last update's state: {type(exc).__name__}", flush=True)


def _update_status(force: bool = False) -> dict[str, Any]:
    status = get_checker().status(force=force)
    info = install_info()
    out = {**status, "supported": bool(info.get("update_supported")), "install": info.get("install"),
           "restart_automatic": restart_automatic()}
    if info.get("reason"):
        out["reason"] = info["reason"]
    return out


@router.get("/api/app/version")
async def app_version() -> JSONResponse:
    info = await run_in_threadpool(install_info)
    return JSONResponse({**info, "checkout_id": install.checkout_id(ROOT), "restart_automatic": restart_automatic()})


@router.get("/api/app/update")
async def app_update() -> JSONResponse:
    return JSONResponse(await run_in_threadpool(_update_status))


@router.post("/api/app/update/check")
async def app_update_check() -> JSONResponse:
    return JSONResponse(await run_in_threadpool(_update_status, True))


@router.post("/api/app/update/dismiss")
async def app_update_dismiss(body: Any = Body(default=None)) -> JSONResponse:
    tag = body.get("tag") if isinstance(body, dict) else None
    action = body.get("action") if isinstance(body, dict) else None
    if not isinstance(tag, str) or semver.parse_tag(tag) is None or action not in ("skip", "later", "clear"):
        return JSONResponse({"detail": 'Send {"tag": "vX.Y.Z", "action": "skip" | "later" | "clear"}.'},
                            status_code=422)
    if action == "skip":
        settings_store.set_app_pref(settings.SKIP_PREF, tag)
    elif action == "later":
        until = time.time() + settings.SNOOZE_SECONDS
        settings_store.set_app_pref(settings.SNOOZE_PREF, json.dumps({"tag": tag, "until": until}))
    else:
        settings_store.set_app_pref(settings.SKIP_PREF, "")
        settings_store.set_app_pref(settings.SNOOZE_PREF, "")
    return JSONResponse(await run_in_threadpool(_update_status))


@router.post("/api/app/update/apply")
async def app_update_apply(body: Any = Body(default=None)) -> JSONResponse:
    tag = body.get("tag") if isinstance(body, dict) else None
    allow = body.get("allow_active_jobs", False) if isinstance(body, dict) else None
    if not isinstance(tag, str) or not isinstance(allow, bool):
        return JSONResponse({"detail": 'Send {"tag": "vX.Y.Z", "allow_active_jobs"?: true|false}.'},
                            status_code=422)
    info = await run_in_threadpool(install_info)
    if not info.get("update_supported"):
        return JSONResponse({"code": "not_supported", "detail": info.get("reason") or "Not supported."},
                            status_code=409)
    eng = get_engine()
    try:
        # The preflight runs here (quick); the update itself runs in a thread.
        progress = await run_in_threadpool(lambda: eng.start(tag, allow_active_jobs=allow))
    except engine_mod.Busy:
        return JSONResponse({"code": "busy", "detail": "An update is already running."}, status_code=409)
    except engine_mod.Blocked as exc:
        return JSONResponse({"code": "blocked", "detail": str(exc), "blockers": exc.blockers}, status_code=409)
    return JSONResponse(progress, status_code=202)


@router.get("/api/app/update/progress")
async def app_update_progress() -> JSONResponse:
    return JSONResponse(get_engine().progress())


@router.post("/api/app/update/progress/ack")
async def app_update_ack() -> JSONResponse:
    return JSONResponse(await run_in_threadpool(get_engine().acknowledge))
