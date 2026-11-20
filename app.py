"""Single entrypoint: starts FastAPI backend + Next.js frontend, opens browser.

Run it from the repository folder. uv then runs it in the project environment
(``.venv``, synced from ``uv.lock``), and the backend uses the same Python, so
the app runs on the locked versions. This file declares no dependencies of its
own (no inline ``# /// script`` block): that would make uv ignore the lock.

    uv run app.py              the production web interface: built when it is missing or stale
                               (after an install, an update or a block change), then served by
                               the Next.js standalone server
    uv run app.py --dev        the Next.js development server (`npm run dev`), for working on
                               blocks or the app (also BLOCKFLOW_DEV=1)
    uv run app.py --packaged   the existing build as it is; never installs or builds
                               (also BLOCKFLOW_PACKAGED=1)
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from enum import Enum
from pathlib import Path
from typing import Callable, Mapping

ROOT = Path(__file__).resolve().parent
FRONTEND_DIR = ROOT / "frontend"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Standard library only (it is imported before anything is installed).
from backend.app_update.launcher_protocol import (  # noqa: E402
    ALL_IPV4_HOST,
    LAUNCH_MODE_ENV,
    ORIGINS_ENV,
    REQUEST_ORDER,
    SUPERVISOR_ENV,
    ControlFile,
    LaunchMode,
    frontend_host,
    settings_db_path,
)

# Arbitrary, uncommon ports (scripts/doctor.py DEFAULT_*_PORT): 3000/8000 collide
# with every other Next.js/Django/http.server dev instance on the machine.
# Override with BACKEND_PORT / FRONTEND_PORT if these clash too (_read_ports).
PORT_REMEDY = "BACKEND_PORT=48001 FRONTEND_PORT=48000 uv run app.py"


def _is_packaged_mode(argv: list[str] | None = None) -> bool:
    args = sys.argv[1:] if argv is None else argv
    return "--packaged" in args or os.environ.get("BLOCKFLOW_PACKAGED") == "1"


def _is_dev_mode(argv: list[str] | None = None) -> bool:
    args = sys.argv[1:] if argv is None else argv
    return "--dev" in args or os.environ.get("BLOCKFLOW_DEV") == "1"


class FrontendMode(Enum):
    """Which web interface a launch serves. ``--dev`` wins over ``--packaged``."""

    BUILD = "build"        # the default: build when missing or stale, then the standalone server
    DEV = "dev"            # --dev / BLOCKFLOW_DEV=1: `npm run dev`
    PREBUILT = "prebuilt"  # --packaged / BLOCKFLOW_PACKAGED=1: the existing build; never installs or builds


def _frontend_mode(argv: list[str] | None = None) -> FrontendMode:
    if _is_dev_mode(argv):
        return FrontendMode.DEV
    return FrontendMode.PREBUILT if _is_packaged_mode(argv) else FrontendMode.BUILD


class FrontendUnavailable(Exception):
    """The web interface cannot start (its build failed or is missing); the
    message is the launcher's readable lines."""


AUTO_SETUP_OFF_ENV = "BLOCKFLOW_NO_AUTO_SETUP"


def _install_steps():
    """scripts/install_steps.py (shared with scripts/setup.py; standard library only)."""
    scripts = str(ROOT / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    import install_steps

    return install_steps


def _auto_setup(env=None, out: Callable[[str], None] = print, *, build: bool = False) -> int:
    """Install what a fresh clone is missing before the servers start: the
    frontend packages and the block registry (and FastMCP after a first
    install), and with ``build`` the production web interface when its build
    is missing or stale. Returns 0 to go on, or the exit code to stop with.

    An installed, built checkout costs two file timestamps and one hash of the
    frontend sources (tens of milliseconds) and prints nothing. Never runs
    ``uv sync``: uv has already prepared the environment this runs in.
    ``BLOCKFLOW_NO_AUTO_SETUP=1`` skips it all."""
    steps_mod = _install_steps()
    doctor = steps_mod.doctor
    env = env or doctor.Env(root=ROOT)
    if env.environ.get(AUTO_SETUP_OFF_ENV) == "1":
        return 0
    steps = steps_mod.first_start_plan(env, build=build)
    if not steps:
        return 0
    if steps_mod.this_checkout_running(env):
        out(_already_running(env.frontend_port()))
        return 1
    for check in steps_mod.node_prereqs(env):
        if check.status == doctor.FAIL:
            out(f"[app] Cannot install the frontend: {check.message} {check.fix}".rstrip())
            out("[app] Nothing was started. Run `uv run app.py` again once it is installed.")
            return 1
    installed = False
    for step in steps:
        shown = " ".join(step.cmd)
        out(f"[app] {step.message}")
        try:
            code, output = steps_mod.run_step(env, step)
        except KeyboardInterrupt:
            if step.cmd == steps_mod.NPM_CI:
                steps_mod.forget_frontend_install(env.root)
            out("\n[app] Install interrupted. Nothing was started; `uv run app.py` finishes it next time.")
            return 130
        if code != 0 and step.cmd == steps_mod.BUILD:
            for line in steps_mod.build_failed_lines(code, output, prefix="[app] "):
                out(line)
            out("[app] Nothing was started.")
            return 1
        if code != 0:
            if step.cmd == steps_mod.NPM_CI:
                steps_mod.forget_frontend_install(env.root)
            out(f"[app] `{shown}` failed (exit {code}).")
            if output:
                out(steps_mod.tail(output))
            out("[app] Nothing was started. Check your internet connection, then run `uv run app.py` again "
                "(or `uv run python scripts/setup.py` to repair).")
            return 1
        installed = installed or step.cmd == steps_mod.NPM_CI
    if installed:
        out("[app] Checking FastMCP for the MCP server...")
        steps_mod.ensure_fastmcp(env, out, prefix="[app] ")
    return 0


def _ensure_frontend_build(env=None, out: Callable[[str], None] = print) -> None:
    """Before the standalone server (re)starts: build it when it is missing or
    stale. The first start has normally built it already (``_auto_setup``) and
    an update builds it in its own step, so this is a stamp check that finds
    nothing to do; it builds only when something changed under a running app.
    Raises ``FrontendUnavailable`` with readable lines when the build fails."""
    steps_mod = _install_steps()
    env = env or steps_mod.doctor.Env(root=ROOT)
    if env.environ.get(AUTO_SETUP_OFF_ENV) == "1":
        return  # the opt-out covers the build too: whatever build is there is served
    step = steps_mod.build_step(env)
    if step is None:
        return
    out(f"[app] {step.message}")
    code, output = steps_mod.build_frontend(env)
    if code != 0:
        raise FrontendUnavailable("\n".join(steps_mod.build_failed_lines(code, output, prefix="[app] ")))


def _check_prebuilt(env=None, out: Callable[[str], None] = print) -> bool:
    """``--packaged``: the existing build is used as it is. False (after a
    readable line) when there is none; a stale one is served with a warning."""
    steps_mod = _install_steps()
    env = env or steps_mod.doctor.Env(root=ROOT)
    try:
        _find_standalone_server(env.root / "frontend")
    except FileNotFoundError:
        out("[app] --packaged serves an existing build of the web interface, and there is none. Start without "
            "--packaged (`uv run app.py`), which builds it, or run `uv run python scripts/setup.py` first.")
        return False
    fb = steps_mod.frontend_build
    if fb.build_state(env.root, env.backend_port()) is not fb.BuildState.CURRENT:
        out("[app] Warning: this build of the web interface is older than the code, the blocks or the backend "
            "port (or was not made by BlockFlow). --packaged serves it as it is; `uv run app.py` rebuilds it.")
    return True


# What the backend server imports first; both come from uv.lock through the project environment.
SERVER_MODULES = ("fastapi", "uvicorn")


def _missing_server_modules() -> list[str]:
    return [name for name in SERVER_MODULES if importlib.util.find_spec(name) is None]


def _outside_project_line(missing: list[str]) -> str:
    """Started with a Python that lacks the app's packages: usually `uv run app.py` from
    another folder, where uv finds no project and so no uv.lock."""
    return (f"[app] This Python does not have the packages BlockFlow Studio needs ({', '.join(missing)}). Start it "
            f"from the repository folder, where uv uses the versions in uv.lock: `cd \"{ROOT}\"`, then "
            "`uv run app.py`.")


def _already_running(frontend_port: int) -> str:
    return (f"[app] BlockFlow Studio is already running from this folder at http://localhost:{frontend_port}. "
            "Use that one, or stop it (Ctrl+C in its terminal) and start again.")


def _read_ports(environ: Mapping[str, str]) -> tuple[int, int] | str:
    """(backend, frontend) from BACKEND_PORT / FRONTEND_PORT, or the line to
    stop with when one is not a port number. Same rule as the doctor's."""
    doctor = _install_steps().doctor
    ports = []
    for name in ("BACKEND_PORT", "FRONTEND_PORT"):
        default = doctor.PORT_DEFAULTS[name]
        port, problem = doctor.port_setting(dict(environ), name, default)
        if problem:
            return f"[app] {problem} {doctor.port_fix(name, default)}"
        ports.append(port)
    return ports[0], ports[1]


def _port_problem(backend_port: int, frontend_port: int, env=None) -> str | None:
    """The line to stop with when a port is already taken, else None. Checked
    once, before the servers first start: an update restart reuses the ports
    of the servers it just stopped and never comes through here."""
    steps_mod = _install_steps()
    env = env or steps_mod.doctor.Env(root=ROOT)
    busy = [(port, role) for port, role in ((backend_port, "backend"), (frontend_port, "frontend"))
            if env.port_in_use(port)]
    if not busy:
        return None
    if steps_mod.this_checkout_running(env):
        return _already_running(frontend_port)
    named = " and ".join(f"{port} ({role})" for port, role in busy)
    which = f"Ports {named} are" if len(busy) > 1 else f"Port {named} is"
    return (f"[app] {which} already in use by another program (often another copy of BlockFlow), so "
            f"BlockFlow Studio cannot start. Stop it, or start this copy on other ports: `{PORT_REMEDY}` "
            "(then register the MCP server with BLOCKFLOW_URL=http://127.0.0.1:48001).")


def _wait_for(url: str, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return True
        except Exception:
            time.sleep(0.5)
    return False


def _find_standalone_server(frontend_dir: Path = FRONTEND_DIR) -> Path:
    server = _install_steps().frontend_build.standalone_server(frontend_dir)
    if server is not None:
        return server
    raise FileNotFoundError(
        "Missing Next.js standalone server. Start with `uv run app.py`, which builds it, before a packaged launch."
    )


# Stopping: each server gets STOP_GRACE_S seconds in all to exit after SIGTERM,
# then its process group is killed. Uvicorn stops waiting for open connections
# sooner (an open page holds the jobs event stream, which never ends by itself).
STOP_GRACE_S = 5.0
BACKEND_GRACEFUL_SHUTDOWN_S = 2
KILL_WAIT_S = 2.0


def _backend_command(backend_port: int) -> list[str]:
    return [
        sys.executable, "-m", "uvicorn",
        "--timeout-graceful-shutdown", str(BACKEND_GRACEFUL_SHUTDOWN_S),
        "backend.main:app",
        "--host", "127.0.0.1",
        "--port", str(backend_port),
    ]


def _frontend_command(*, packaged: bool, frontend_port: int, host: str) -> tuple[list[str], Path]:
    if packaged:
        server = _find_standalone_server()
        return ["node", str(server)], server.parent
    return ["npm", "run", "dev", "--", "--port", str(frontend_port), "--hostname", host], FRONTEND_DIR


def _current_frontend_host() -> str:
    """Where the web interface listens, decided now: ``BLOCKFLOW_ALLOWED_ORIGINS``
    (environment, else the repository ``.env``) or the stored ``allowed_origins``
    preference, read-only (launcher_protocol.frontend_host). Called on every
    start of the web interface, so a restart applies a change."""
    return frontend_host(os.environ, ROOT / ".env", settings_db_path(os.environ))


def _listen_line(host: str) -> str:
    """The one launcher line about where the web interface listens."""
    if host == ALL_IPV4_HOST:
        return (f"[app] The web interface listens on every network address ({host}): {ORIGINS_ENV} or the "
                "allowed origins setting is set, so other devices can open it. Clear both and restart to keep "
                "it on this computer only.")
    return (f"[app] The web interface listens on this computer only ({host}). To use it from another device, "
            f"set {ORIGINS_ENV} to that address and restart (see README.md).")


def _frontend_env(*, backend_port: int, frontend_port: int, host: str,
                  base: Mapping[str, str] | None = None) -> dict[str, str]:
    """The web server's environment. ``PORT`` and ``HOSTNAME`` are read by the
    standalone server when it starts; ``next dev`` takes ``--port`` and
    ``--hostname`` instead. The backend port is also fixed in a production
    build (the build stamp includes it) and read by ``next dev`` at start."""
    return {
        **(os.environ if base is None else base),
        "BACKEND_PORT": str(backend_port),
        # Inlined into the client bundle so browser code (e.g. directBackendUrl)
        # can reach FastAPI directly without going through the Next.js proxy.
        "NEXT_PUBLIC_BACKEND_PORT": str(backend_port),
        "PORT": str(frontend_port),
        # 127.0.0.1 unless allowed origins are set (launcher_protocol.frontend_host):
        # on shared Wi-Fi anyone could otherwise read the GET routes and /outputs.
        "HOSTNAME": host,
    }


# Restart protocol with the backend, declared in backend/app_update/launcher_protocol.py:
# the backend creates a request file in this private folder and the loop below
# acts on it within about a second, in REQUEST_ORDER.
REQ_PAUSE = ControlFile.PAUSE_FRONTEND
ACK_PAUSED = ControlFile.FRONTEND_PAUSED
REQ_RESUME = ControlFile.RESUME_FRONTEND
REQ_RESTART = ControlFile.RESTART


def _launch_mode(packaged: bool) -> LaunchMode:
    return LaunchMode.PACKAGED if packaged else LaunchMode.DEV


def _backend_env(*, control_dir: Path, packaged: bool, backend_port: int, frontend_port: int) -> dict[str, str]:
    return {
        **os.environ,
        SUPERVISOR_ENV: str(control_dir),
        LAUNCH_MODE_ENV: _launch_mode(packaged).value,
        # The backend allows browser requests only from these ports (backend/origin_guard.py).
        "BACKEND_PORT": str(backend_port),
        "FRONTEND_PORT": str(frontend_port),
    }


class LaunchOutcome(Enum):
    """How a launch ended; ``EXIT_CODES`` gives the launcher's exit code."""

    STOPPED = "stopped"                      # Ctrl+C: a normal stop
    SERVER_EXITED = "server_exited"          # the backend or frontend stopped on its own
    SETUP_FAILED = "setup_failed"            # the first-start install could not finish
    SETUP_INTERRUPTED = "setup_interrupted"  # Ctrl+C during the first-start install
    BAD_PORT = "bad_port"                    # BACKEND_PORT / FRONTEND_PORT is not a port number
    PORT_IN_USE = "port_in_use"              # a port is taken (another program, or this app already)
    BUILD_MISSING = "build_missing"          # --packaged, and there is no build to serve
    BUILD_FAILED = "build_failed"            # the web interface could not be built when it restarted


EXIT_CODES: dict[LaunchOutcome, int] = {
    LaunchOutcome.STOPPED: 0,
    LaunchOutcome.SERVER_EXITED: 1,
    LaunchOutcome.SETUP_FAILED: 1,
    LaunchOutcome.SETUP_INTERRUPTED: 130,
    LaunchOutcome.BAD_PORT: 1,
    LaunchOutcome.PORT_IN_USE: 1,
    LaunchOutcome.BUILD_MISSING: 1,
    LaunchOutcome.BUILD_FAILED: 1,
}


class ProcessSupervisor:
    """Owns the backend and frontend processes. ``tick()`` handles restart /
    pause / resume requests and returns False when the app should stop (a
    child exited on its own). The top process never exits for a restart, so
    this works the same on every OS and under wrappers."""

    def __init__(self, *, control_dir: Path, start_backend: Callable[[], subprocess.Popen],
                 start_frontend: Callable[[], subprocess.Popen],
                 stop: Callable[[list], None] | None = None, wait: Callable[[], None] | None = None) -> None:
        self.control_dir = Path(control_dir)
        self._start_backend = start_backend
        self._start_frontend = start_frontend
        self._stop = stop or _stop_processes
        self._wait = wait or (lambda: None)
        self.backend: subprocess.Popen | None = None
        self.frontend: subprocess.Popen | None = None
        # (name, exit code) of the server that stopped on its own, once tick() saw it.
        self.stopped_server: tuple[str, int | None] | None = None
        # Why the web server could not be (re)started (its build failed), once it happened.
        self.frontend_error: str | None = None

    def _take(self, name: str) -> bool:
        path = self.control_dir / name
        if not path.exists():
            return False
        try:
            path.unlink()
        except OSError:
            pass
        return True

    def start(self) -> None:
        self.control_dir.mkdir(parents=True, exist_ok=True)
        self.backend = self._start_backend()
        self._launch_frontend()

    def _launch_frontend(self) -> None:
        """Start the web server; when it cannot start (``FrontendUnavailable``,
        a failed build) say why, and the next tick stops the app."""
        try:
            self.frontend = self._start_frontend()
        except FrontendUnavailable as exc:
            self.frontend = None
            self.frontend_error = str(exc)
            print(self.frontend_error)
            print("[app] BlockFlow Studio is shutting down because the web interface cannot start.")

    def procs(self) -> list:
        return [p for p in (self.backend, self.frontend) if p is not None]

    def tick(self) -> bool:
        # Requests in REQUEST_ORDER (launcher_protocol explains it): a restart
        # wins and drops the requests left for the processes it replaces.
        for request in REQUEST_ORDER:
            if not self._take(request):
                continue
            if request is ControlFile.RESTART:
                self._restart()
                return self.frontend_error is None
            if request is ControlFile.PAUSE_FRONTEND:
                self._pause_frontend()
            elif request is ControlFile.RESUME_FRONTEND:
                self._resume_frontend()
        return self.frontend_error is None and self._children_alive()

    def _restart(self) -> None:
        print("[app] Restarting BlockFlow after an update...")
        self._stop(self.procs())
        for stale in (*REQUEST_ORDER, ControlFile.FRONTEND_PAUSED):
            (self.control_dir / stale).unlink(missing_ok=True)
        self.backend = self._start_backend()
        self._launch_frontend()
        if self.frontend_error is None:
            self._wait()

    def _pause_frontend(self) -> None:
        if self.frontend is not None:
            print("[app] Pausing the web interface for an update...")
            self._stop([self.frontend])
            self.frontend = None
        (self.control_dir / ACK_PAUSED).write_text("1", encoding="utf-8")

    def _resume_frontend(self) -> None:
        (self.control_dir / ACK_PAUSED).unlink(missing_ok=True)
        if self.frontend is None:
            print("[app] Resuming the web interface...")
            self._launch_frontend()

    def _children_alive(self) -> bool:
        for name, p in (("backend", self.backend), ("frontend", self.frontend)):
            if p is not None and p.poll() is not None:
                self.stopped_server = (name, p.returncode)
                print(f"[app] The {name} server stopped on its own (exit code {p.returncode}), so BlockFlow "
                      "Studio is shutting down.")
                print("[app] Run `python3 scripts/doctor.py` to find the cause, then start it again with "
                      "`uv run app.py`.")
                return False
        return True


def _spawn(cmd: list[str], *, cwd: Path, env: Mapping[str, str]) -> subprocess.Popen:
    """Start a server. On macOS and Linux it gets its own process group, so a
    terminal's Ctrl+C reaches only the launcher, which stops each server and
    everything it started (``npm run dev`` -> ``next dev`` -> workers) in order."""
    extra = {} if sys.platform == "win32" else {"start_new_session": True}
    return subprocess.Popen(cmd, cwd=str(cwd), env=env, **extra)


def _signal_tree(p: subprocess.Popen, *, kill: bool) -> None:
    """SIGTERM (or, with ``kill``, SIGKILL) to the server's process group; to
    the server alone when it does not lead one. Windows: terminate / kill."""
    if sys.platform == "win32":
        p.kill() if kill else p.terminate()
        return
    sig = signal.SIGKILL if kill else signal.SIGTERM
    try:
        os.killpg(p.pid, sig)
        return
    except (ProcessLookupError, PermissionError):
        pass
    try:
        p.send_signal(sig)
    except (ProcessLookupError, OSError):
        pass


def _stop_processes(procs: list[subprocess.Popen], *, grace: float = STOP_GRACE_S,
                    signal_tree: Callable[..., None] = _signal_tree,
                    clock: Callable[[], float] = time.monotonic) -> None:
    """Ask every running server to stop, wait up to ``grace`` seconds in all
    (one deadline, not one per server), then kill whatever is still running.
    Shutdown is never cut short by a later Ctrl+C: ``StopSignals`` ignores it."""
    live = [p for p in procs if p.poll() is None]
    for p in live:
        signal_tree(p, kill=False)
    deadline = clock() + grace
    for p in live:
        try:
            p.wait(timeout=max(0.0, deadline - clock()))
        except subprocess.TimeoutExpired:
            pass
    for p in live:
        if p.poll() is None:
            signal_tree(p, kill=True)
            try:
                p.wait(timeout=KILL_WAIT_S)
            except subprocess.TimeoutExpired:
                pass


# Every signal that stops the app: Ctrl+C, a supervisor or `kill`, a closed terminal.
STOP_SIGNALS = tuple(getattr(signal, name) for name in ("SIGINT", "SIGTERM", "SIGHUP") if hasattr(signal, name))


class StopSignals:
    """The first stop signal raises ``KeyboardInterrupt`` where the launcher
    is; every later one is ignored, so the shutdown it started always
    finishes. A terminal's Ctrl+C reaches app.py twice (from the terminal, and
    again from uv, which forwards it), and people press it again when a stop
    takes a few seconds."""

    def __init__(self) -> None:
        self.stopping = False
        self._previous: dict[int, object] = {}

    def install(self) -> None:
        for sig in STOP_SIGNALS:
            try:
                self._previous[sig] = signal.signal(sig, self.handle)
            except (ValueError, OSError):  # not the main thread, or not settable here
                pass

    def restore(self) -> None:
        for sig, previous in self._previous.items():
            try:
                signal.signal(sig, previous)
            except (ValueError, OSError, TypeError):
                pass
        self._previous.clear()

    def begin_shutdown(self) -> None:
        self.stopping = True

    def handle(self, signum, frame) -> None:
        if self.stopping:
            return
        self.stopping = True
        raise KeyboardInterrupt


def _line_buffered_output() -> None:
    """Flush the launcher's own lines as they are printed, in a pipe too.

    Python block-buffers stdout when it is not a terminal, so with the output
    piped (a coding agent running the app in the background) the first-start
    lines would only appear when the launcher exits. Streams without
    ``reconfigure`` (replaced by a wrapper) are left alone."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(line_buffering=True)
        except (ValueError, OSError):
            pass


def main() -> None:
    """Run the app; exit with the code of how the launch ended (EXIT_CODES).
    A normal stop (Ctrl+C, SIGTERM, SIGHUP) returns without calling sys.exit."""
    signals = StopSignals()
    signals.install()
    try:
        outcome = _launch(signals)
    except KeyboardInterrupt:  # stopped before the servers started (_launch handles it after)
        print("\n[app] Interrupted. Nothing was started.")
        outcome = LaunchOutcome.SETUP_INTERRUPTED
    finally:
        signals.restore()
    code = EXIT_CODES[outcome]
    if code:
        sys.exit(code)


def _launch(signals: StopSignals) -> LaunchOutcome:
    _line_buffered_output()
    if "--advanced" in sys.argv:
        os.environ["BLOCKFLOW_ADVANCED"] = "1"
        print("[app] Advanced mode enabled")

    frontend_mode = _frontend_mode()
    # The built web interface (default and --packaged) runs as LaunchMode.PACKAGED.
    packaged = frontend_mode is not FrontendMode.DEV
    mode = _launch_mode(packaged)

    ports = _read_ports(os.environ)
    if isinstance(ports, str):
        print(ports)
        return LaunchOutcome.BAD_PORT
    backend_port, frontend_port = ports

    missing = _missing_server_modules()
    if missing:
        print(_outside_project_line(missing))
        return LaunchOutcome.SETUP_FAILED

    # Install what a fresh clone is missing and, unless --dev, build the web
    # interface when it is missing or stale. --packaged never changes the app
    # directory: it serves the build that is there.
    if frontend_mode is FrontendMode.PREBUILT:
        if not _check_prebuilt():
            return LaunchOutcome.BUILD_MISSING
    else:
        code = _auto_setup(build=frontend_mode is FrontendMode.BUILD)
        if code:
            return LaunchOutcome.SETUP_INTERRUPTED if code == 130 else LaunchOutcome.SETUP_FAILED
    if frontend_mode is FrontendMode.BUILD:
        print("[app] Serving the built web interface. Working on blocks or the app? `uv run app.py --dev` runs "
              "the development server instead.")

    # Otherwise the wait below would succeed against whatever already holds the
    # port (often a first copy of the app) and this copy's servers fail to bind.
    problem = _port_problem(backend_port, frontend_port)
    if problem:
        print(problem)
        return LaunchOutcome.PORT_IN_USE

    control_dir = Path(tempfile.mkdtemp(prefix="blockflow-supervisor-"))

    def start_backend() -> subprocess.Popen:
        print(f"[app] Starting FastAPI on :{backend_port}...")
        return _spawn(
            _backend_command(backend_port),
            cwd=ROOT,
            env=_backend_env(control_dir=control_dir, packaged=packaged,
                             backend_port=backend_port, frontend_port=frontend_port),
        )

    def start_frontend() -> subprocess.Popen:
        if frontend_mode is FrontendMode.BUILD:
            # A no-op stamp check after the first start or an update's own build step.
            _ensure_frontend_build()
        host = _current_frontend_host()  # again on every (re)start: settings may have changed
        print(_listen_line(host))
        try:
            frontend_cmd, frontend_cwd = _frontend_command(packaged=packaged, frontend_port=frontend_port, host=host)
        except FileNotFoundError as exc:
            raise FrontendUnavailable(f"[app] {exc}") from exc
        print(f"[app] Starting Next.js {mode.frontend_label} on :{frontend_port}...")
        return _spawn(frontend_cmd, cwd=frontend_cwd,
                      env=_frontend_env(backend_port=backend_port, frontend_port=frontend_port, host=host))

    def wait_for_servers() -> None:
        print("[app] Waiting for servers to start...")
        if not _wait_for(f"http://127.0.0.1:{backend_port}/api/runs?limit=1", timeout=20):
            print("[app] WARNING: Backend did not respond in time")
        if not _wait_for(f"http://127.0.0.1:{frontend_port}", timeout=30):
            print("[app] WARNING: Frontend did not respond in time")

    supervisor = ProcessSupervisor(control_dir=control_dir, start_backend=start_backend,
                                   start_frontend=start_frontend, wait=wait_for_servers)

    try:
        supervisor.start()
        if supervisor.frontend_error:
            return LaunchOutcome.BUILD_FAILED
        wait_for_servers()

        url = f"http://localhost:{frontend_port}"
        if os.environ.get("BLOCKFLOW_NO_OPEN") == "1":
            print(f"[app] Ready at {url}")
        else:
            print(f"[app] Opening {url}")
            if sys.platform == "darwin":
                subprocess.Popen(["open", url])
            elif sys.platform == "win32":
                os.startfile(url)
            elif sys.platform == "linux":
                subprocess.Popen(["xdg-open", url])

        print("[app] Running. Press Ctrl+C to stop.")
        # Handle update requests; stop when either process exits on its own.
        while supervisor.tick():
            time.sleep(1)
        return LaunchOutcome.BUILD_FAILED if supervisor.frontend_error else LaunchOutcome.SERVER_EXITED

    except KeyboardInterrupt:
        print("\n[app] Shutting down...")
        return LaunchOutcome.STOPPED
    finally:
        signals.begin_shutdown()  # from here on no signal interrupts: the stop below always finishes
        _stop_processes(supervisor.procs())
        shutil.rmtree(control_dir, ignore_errors=True)
        print("[app] Stopped.")


if __name__ == "__main__":
    main()
