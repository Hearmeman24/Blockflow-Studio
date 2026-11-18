"""Talking to ``app.py``, which supervises the backend and frontend processes.

``app.py`` gives the backend a private control folder in
``BLOCKFLOW_SUPERVISOR_DIR`` and polls it about once a second. The backend
asks by creating a request file there:

  pause-frontend   stop the web server (before files under it change);
                   app.py answers by creating ``frontend-paused``
  resume-frontend  start the web server again
  restart          stop and start both processes (picks up the new code)

Files, not signals: this works the same on macOS, Linux and Windows and
under wrappers (npm bin, a coding agent, a terminal multiplexer), because the
top process never exits. Without the variable (the backend was started some
other way: uvicorn directly, a debugger) automatic restart is not available
and the update asks the user to restart.

The names, the order app.py handles them in and the launch modes are
declared once in ``backend/app_update/launcher_protocol.py``, which app.py
imports too.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Callable

from backend.app_update.launcher_protocol import LAUNCH_MODE_ENV, SUPERVISOR_ENV, ControlFile, LaunchMode

ENV = SUPERVISOR_ENV
PAUSE = ControlFile.PAUSE_FRONTEND
PAUSED = ControlFile.FRONTEND_PAUSED
RESUME = ControlFile.RESUME_FRONTEND
RESTART = ControlFile.RESTART

__all__ = ["ENV", "LAUNCH_MODE_ENV", "PAUSE", "PAUSED", "RESUME", "RESTART", "Supervisor", "launch_mode",
           "restart_command", "restarts_automatically"]


def launch_mode() -> LaunchMode:
    """``dev`` | ``packaged`` when started by app.py, else ``unknown``."""
    return LaunchMode.parse(os.environ.get(LAUNCH_MODE_ENV, ""))


def restart_command(mode: str) -> str:
    return "uv run app.py --packaged" if mode == LaunchMode.PACKAGED else "uv run app.py"


def restarts_automatically(*, supervised: bool, mode: str, launcher_changed: bool = False) -> bool:
    """The one rule for whether BlockFlow restarts itself after an update:
    app.py supervises this backend (its control folder exists and it set the
    launch mode) and the update does not change app.py itself (a running
    launcher cannot reload its own code, so that needs a manual restart).

    Before an update is fetched nobody knows yet whether it changes app.py;
    callers that answer then (``/api/app/version``, ``/api/app/update``)
    pass ``launcher_changed=False``, so their ``restart_automatic`` means
    "can restart itself, unless the update changes app.py"."""
    return supervised and LaunchMode.parse(mode).supervised and not launcher_changed


class Supervisor:
    def __init__(self, directory: str | Path | None = None, *, sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic) -> None:
        raw = directory if directory is not None else os.environ.get(ENV)
        self.directory = Path(raw) if raw else None
        self._sleep = sleep
        self._clock = clock

    @property
    def available(self) -> bool:
        return self.directory is not None and self.directory.is_dir()

    def _request(self, name: str) -> bool:
        """Create the request file. False when it could not be written (no
        supervisor, or its folder vanished or refused the write)."""
        if not self.available:
            return False
        assert self.directory is not None
        tmp = self.directory / f".{name}.tmp"
        try:
            tmp.write_text(str(os.getpid()), encoding="utf-8")
            os.replace(tmp, self.directory / name)
        except OSError:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            return False
        return True

    def pause_frontend(self, timeout: float = 30.0) -> bool:
        """Ask app.py to stop the frontend; True once it confirms."""
        if not self.available:
            return False
        assert self.directory is not None
        try:
            (self.directory / PAUSED).unlink(missing_ok=True)
        except OSError:
            return False
        if not self._request(PAUSE):
            return False
        deadline = self._clock() + timeout
        while self._clock() < deadline:
            if (self.directory / PAUSED).exists():
                return True
            self._sleep(0.2)
        try:
            (self.directory / PAUSE).unlink(missing_ok=True)
        except OSError:
            pass
        return False

    def resume_frontend(self) -> bool:
        """Ask app.py to start the frontend again; True when the request was written."""
        return self._request(RESUME)

    def restart(self) -> bool:
        """Ask app.py to restart both processes; True when the request was
        written. False means nothing will restart this process."""
        return self._request(RESTART)
