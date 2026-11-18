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
from typing import Callable

ROOT = Path(__file__).resolve().parent
FRONTEND_DIR = ROOT / "frontend"
# Arbitrary, uncommon ports: 3000/8000 collide with every other Next.js/Django/
# http.server dev instance on the machine. Override via env if these clash too.
BACKEND_PORT = int(os.environ.get("BACKEND_PORT", 47301))
FRONTEND_PORT = int(os.environ.get("FRONTEND_PORT", 47300))


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
        out(f"[app] BlockFlow Studio is already running from this folder at http://localhost:{env.frontend_port()}. "
            "Use that one, or stop it (Ctrl+C in its terminal) and start again.")
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


# Restart protocol with the backend (backend/app_update/supervisor.py keeps the
# same names): the backend creates a request file in this private folder and
# the loop below acts on it within about a second.
SUPERVISOR_ENV = "BLOCKFLOW_SUPERVISOR_DIR"
LAUNCH_MODE_ENV = "BLOCKFLOW_LAUNCH_MODE"
REQ_PAUSE = "pause-frontend"
ACK_PAUSED = "frontend-paused"
REQ_RESUME = "resume-frontend"
REQ_RESTART = "restart"


def _backend_env(*, control_dir: Path, packaged: bool, backend_port: int, frontend_port: int) -> dict[str, str]:
    return {
        **os.environ,
        SUPERVISOR_ENV: str(control_dir),
        LAUNCH_MODE_ENV: "packaged" if packaged else "dev",
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


EXIT_CODES: dict[LaunchOutcome, int] = {
    LaunchOutcome.STOPPED: 0,
    LaunchOutcome.SERVER_EXITED: 1,
    LaunchOutcome.SETUP_FAILED: 1,
    LaunchOutcome.SETUP_INTERRUPTED: 130,
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
        if self._take(REQ_RESTART):
            print("[app] Restarting BlockFlow after an update...")
            self._stop(self.procs())
            (self.control_dir / ACK_PAUSED).unlink(missing_ok=True)
            self.backend = self._start_backend()
            self.frontend = self._start_frontend()
            self._wait()
            return True
        if self._take(REQ_PAUSE):
            if self.frontend is not None:
                print("[app] Pausing the web interface for an update...")
                self._stop([self.frontend])
                self.frontend = None
            (self.control_dir / ACK_PAUSED).write_text("1", encoding="utf-8")
        if self._take(REQ_RESUME):
            (self.control_dir / ACK_PAUSED).unlink(missing_ok=True)
            if self.frontend is None:
                print("[app] Resuming the web interface...")
                self.frontend = self._start_frontend()
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

    # Install what a fresh clone is missing, in dev mode only. Packaged mode
    # must never mutate the installed app directory.
    if not packaged:
        code = _auto_setup()
        if code:
            return LaunchOutcome.SETUP_INTERRUPTED if code == 130 else LaunchOutcome.SETUP_FAILED

    control_dir = Path(tempfile.mkdtemp(prefix="blockflow-supervisor-"))
    mode = "standalone" if packaged else "dev"

    def start_backend() -> subprocess.Popen:
        print(f"[app] Starting FastAPI on :{BACKEND_PORT}...")
        return subprocess.Popen(
            _backend_command(BACKEND_PORT),
            cwd=str(ROOT),
            env=_backend_env(control_dir=control_dir, packaged=packaged,
                             backend_port=BACKEND_PORT, frontend_port=FRONTEND_PORT),
        )

    def start_frontend() -> subprocess.Popen:
        print(f"[app] Starting Next.js {mode} on :{FRONTEND_PORT}...")
        frontend_cmd, frontend_cwd = _frontend_command(packaged=packaged, frontend_port=FRONTEND_PORT)
        frontend_env = {
            **os.environ,
            "BACKEND_PORT": str(BACKEND_PORT),
            # Inlined into the client bundle so browser code (e.g. directBackendUrl)
            # can reach FastAPI directly without going through the Next.js proxy.
            "NEXT_PUBLIC_BACKEND_PORT": str(BACKEND_PORT),
            "PORT": str(FRONTEND_PORT),
            "HOSTNAME": "127.0.0.1",
        }
        return subprocess.Popen(frontend_cmd, cwd=str(frontend_cwd), env=frontend_env)

    def wait_for_servers() -> None:
        print("[app] Waiting for servers to start...")
        if not _wait_for(f"http://127.0.0.1:{BACKEND_PORT}/api/runs?limit=1", timeout=20):
            print("[app] WARNING: Backend did not respond in time")
        if not _wait_for(f"http://127.0.0.1:{FRONTEND_PORT}", timeout=30):
            print("[app] WARNING: Frontend did not respond in time")

    supervisor = ProcessSupervisor(control_dir=control_dir, start_backend=start_backend,
                                   start_frontend=start_frontend, wait=wait_for_servers)

    try:
        supervisor.start()
        wait_for_servers()

        url = f"http://localhost:{FRONTEND_PORT}"
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
