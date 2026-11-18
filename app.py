# /// script
# requires-python = ">=3.12"
# dependencies = ["fastapi>=0.115", "uvicorn>=0.30", "loguru>=0.7", "Pillow>=10"]
# ///
"""Single entrypoint: starts FastAPI backend + Next.js frontend, opens browser."""
from __future__ import annotations

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
    LAUNCH_MODE_ENV,
    REQUEST_ORDER,
    SUPERVISOR_ENV,
    ControlFile,
    LaunchMode,
)

# Arbitrary, uncommon ports (scripts/doctor.py DEFAULT_*_PORT): 3000/8000 collide
# with every other Next.js/Django/http.server dev instance on the machine.
# Override with BACKEND_PORT / FRONTEND_PORT if these clash too (_read_ports).
PORT_REMEDY = "BACKEND_PORT=48001 FRONTEND_PORT=48000 uv run app.py"


def _is_packaged_mode(argv: list[str] | None = None) -> bool:
    args = sys.argv[1:] if argv is None else argv
    return "--packaged" in args or os.environ.get("BLOCKFLOW_PACKAGED") == "1"


AUTO_SETUP_OFF_ENV = "BLOCKFLOW_NO_AUTO_SETUP"


def _install_steps():
    """scripts/install_steps.py (shared with scripts/setup.py; standard library only)."""
    scripts = str(ROOT / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    import install_steps

    return install_steps


def _auto_setup(env=None, out: Callable[[str], None] = print) -> int:
    """Install what a fresh clone is missing before the servers start: the
    frontend packages and the block registry (and FastMCP after a first
    install). Returns 0 to go on, or the exit code to stop with.

    An installed checkout costs two file timestamps and prints nothing. Never
    runs ``uv sync``: uv has already prepared the environment this runs in.
    ``BLOCKFLOW_NO_AUTO_SETUP=1`` skips it all."""
    steps_mod = _install_steps()
    doctor = steps_mod.doctor
    env = env or doctor.Env(root=ROOT)
    if env.environ.get(AUTO_SETUP_OFF_ENV) == "1":
        return 0
    steps = steps_mod.first_start_plan(env)
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
            code, output = env.run(step.cmd, cwd=env.root, timeout=steps_mod.INSTALL_TIMEOUT_S)
        except KeyboardInterrupt:
            if step.cmd == steps_mod.NPM_CI:
                steps_mod.forget_frontend_install(env.root)
            out("\n[app] Install interrupted. Nothing was started; `uv run app.py` finishes it next time.")
            return 130
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
    standalone_dir = frontend_dir / ".next" / "standalone"
    direct = standalone_dir / "server.js"
    if direct.exists():
        return direct
    matches = sorted(standalone_dir.rglob("server.js")) if standalone_dir.exists() else []
    if matches:
        return matches[0]
    raise FileNotFoundError(
        "Missing Next.js standalone server. Run `npm --prefix frontend run build` before packaged launch."
    )


def _backend_command(backend_port: int) -> list[str]:
    return [
        sys.executable, "-m", "uvicorn",
        "backend.main:app",
        "--host", "127.0.0.1",
        "--port", str(backend_port),
    ]


def _frontend_command(*, packaged: bool, frontend_port: int) -> tuple[list[str], Path]:
    if packaged:
        server = _find_standalone_server()
        return ["node", str(server)], server.parent
    return ["npm", "run", "dev", "--", "--port", str(frontend_port)], FRONTEND_DIR


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


EXIT_CODES: dict[LaunchOutcome, int] = {
    LaunchOutcome.STOPPED: 0,
    LaunchOutcome.SERVER_EXITED: 1,
    LaunchOutcome.SETUP_FAILED: 1,
    LaunchOutcome.SETUP_INTERRUPTED: 130,
    LaunchOutcome.BAD_PORT: 1,
    LaunchOutcome.PORT_IN_USE: 1,
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
        self.frontend = self._start_frontend()

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
                return True
            if request is ControlFile.PAUSE_FRONTEND:
                self._pause_frontend()
            elif request is ControlFile.RESUME_FRONTEND:
                self._resume_frontend()
        return self._children_alive()

    def _restart(self) -> None:
        print("[app] Restarting BlockFlow after an update...")
        self._stop(self.procs())
        for stale in (*REQUEST_ORDER, ControlFile.FRONTEND_PAUSED):
            (self.control_dir / stale).unlink(missing_ok=True)
        self.backend = self._start_backend()
        self.frontend = self._start_frontend()
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
            self.frontend = self._start_frontend()

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


def _stop_processes(procs: list[subprocess.Popen]) -> None:
    for p in procs:
        if p.poll() is None:
            if sys.platform == "win32":
                p.terminate()
            else:
                p.send_signal(signal.SIGTERM)
    for p in procs:
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()


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
    A normal stop (Ctrl+C) returns without calling sys.exit, as always."""
    code = EXIT_CODES[_launch()]
    if code:
        sys.exit(code)


def _launch() -> LaunchOutcome:
    _line_buffered_output()
    if "--advanced" in sys.argv:
        os.environ["SGS_ADVANCED"] = "1"
        print("[app] Advanced mode enabled")

    packaged = _is_packaged_mode()
    mode = _launch_mode(packaged)

    ports = _read_ports(os.environ)
    if isinstance(ports, str):
        print(ports)
        return LaunchOutcome.BAD_PORT
    backend_port, frontend_port = ports

    # Install what a fresh clone is missing, in dev mode only. Packaged mode
    # must never mutate the installed app directory.
    if not packaged:
        code = _auto_setup()
        if code:
            return LaunchOutcome.SETUP_INTERRUPTED if code == 130 else LaunchOutcome.SETUP_FAILED

    # Otherwise the wait below would succeed against whatever already holds the
    # port (often a first copy of the app) and this copy's servers fail to bind.
    problem = _port_problem(backend_port, frontend_port)
    if problem:
        print(problem)
        return LaunchOutcome.PORT_IN_USE

    control_dir = Path(tempfile.mkdtemp(prefix="blockflow-supervisor-"))

    def start_backend() -> subprocess.Popen:
        print(f"[app] Starting FastAPI on :{backend_port}...")
        return subprocess.Popen(
            _backend_command(backend_port),
            cwd=str(ROOT),
            env=_backend_env(control_dir=control_dir, packaged=packaged,
                             backend_port=backend_port, frontend_port=frontend_port),
        )

    def start_frontend() -> subprocess.Popen:
        print(f"[app] Starting Next.js {mode.frontend_label} on :{frontend_port}...")
        frontend_cmd, frontend_cwd = _frontend_command(packaged=packaged, frontend_port=frontend_port)
        frontend_env = {
            **os.environ,
            "BACKEND_PORT": str(backend_port),
            # Inlined into the client bundle so browser code (e.g. directBackendUrl)
            # can reach FastAPI directly without going through the Next.js proxy.
            "NEXT_PUBLIC_BACKEND_PORT": str(backend_port),
            "PORT": str(frontend_port),
            "HOSTNAME": "127.0.0.1",
        }
        return subprocess.Popen(frontend_cmd, cwd=str(frontend_cwd), env=frontend_env)

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
        return LaunchOutcome.SERVER_EXITED

    except KeyboardInterrupt:
        print("\n[app] Shutting down...")
        return LaunchOutcome.STOPPED
    finally:
        _stop_processes(supervisor.procs())
        shutil.rmtree(control_dir, ignore_errors=True)
        print("[app] Stopped.")


if __name__ == "__main__":
    main()
