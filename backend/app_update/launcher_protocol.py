"""What ``app.py`` and the backend agree on, declared once.

``app.py`` imports this module before any dependency is installed, so it uses
the standard library only and imports nothing else from ``backend``.

The control-file protocol: ``app.py`` gives the backend a private folder in
``BLOCKFLOW_SUPERVISOR_DIR`` and polls it about once a second; the backend
asks by creating a request file there (see ``backend/app_update/supervisor.py``).
"""

from __future__ import annotations

from enum import StrEnum

SUPERVISOR_ENV = "BLOCKFLOW_SUPERVISOR_DIR"
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
