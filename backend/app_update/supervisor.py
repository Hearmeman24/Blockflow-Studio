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

``app.py`` keeps its own copy of these names; tests/test_app_supervisor.py
runs both sides together.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Callable

ENV = "BLOCKFLOW_SUPERVISOR_DIR"
LAUNCH_MODE_ENV = "BLOCKFLOW_LAUNCH_MODE"
PAUSE = "pause-frontend"
PAUSED = "frontend-paused"
RESUME = "resume-frontend"
RESTART = "restart"


def launch_mode() -> str:
    """``dev`` | ``packaged`` when started by app.py, else ``unknown``."""
    mode = os.environ.get(LAUNCH_MODE_ENV, "")
    return mode if mode in ("dev", "packaged") else "unknown"


def restart_command(mode: str) -> str:
    return "uv run app.py --packaged" if mode == "packaged" else "uv run app.py"


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

    def _request(self, name: str) -> None:
        if not self.available:
            return
        assert self.directory is not None
        tmp = self.directory / f".{name}.tmp"
        tmp.write_text(str(os.getpid()), encoding="utf-8")
        os.replace(tmp, self.directory / name)

    def pause_frontend(self, timeout: float = 30.0) -> bool:
        """Ask app.py to stop the frontend; True once it confirms."""
        if not self.available:
            return False
        assert self.directory is not None
        (self.directory / PAUSED).unlink(missing_ok=True)
        self._request(PAUSE)
        deadline = self._clock() + timeout
        while self._clock() < deadline:
            if (self.directory / PAUSED).exists():
                return True
            self._sleep(0.2)
        (self.directory / PAUSE).unlink(missing_ok=True)
        return False

    def resume_frontend(self) -> None:
        self._request(RESUME)

    def restart(self) -> None:
        self._request(RESTART)
