"""app.py supervises the backend and frontend and restarts them on request.

The backend side (backend/app_update/supervisor.py) and app.py's
ProcessSupervisor are run together here, with fake processes.
"""

from __future__ import annotations

import importlib.util
import threading
from pathlib import Path

from backend.app_update import supervisor as backend_side

ROOT = Path(__file__).resolve().parent.parent


def _load_app():
    spec = importlib.util.spec_from_file_location("blockflow_app_entry_sup", ROOT / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeProc:
    count = 0

    def __init__(self, name):
        FakeProc.count += 1
        self.name = f"{name}{FakeProc.count}"
        self.returncode = None
        self.args = [name]

    def poll(self):
        return self.returncode


def make(tmp_path):
    app = _load_app()
    started: list[str] = []
    stopped: list[str] = []

    def start(kind):
        def _start():
            p = FakeProc(kind)
            started.append(p.name)
            return p
        return _start

    def stop(procs):
        for p in procs:
            stopped.append(p.name)
            p.returncode = 0

    sup = app.ProcessSupervisor(control_dir=tmp_path, start_backend=start("backend"),
                                start_frontend=start("frontend"), stop=stop, wait=lambda: None)
    sup.start()
    return app, sup, started, stopped


def test_names_match_the_backend_side():
    app = _load_app()
    assert app.SUPERVISOR_ENV == backend_side.ENV
    assert app.LAUNCH_MODE_ENV == backend_side.LAUNCH_MODE_ENV
    assert (app.REQ_PAUSE, app.ACK_PAUSED, app.REQ_RESUME, app.REQ_RESTART) == (
        backend_side.PAUSE, backend_side.PAUSED, backend_side.RESUME, backend_side.RESTART)


def test_restart_request_restarts_both_children(tmp_path):
    app, sup, started, stopped = make(tmp_path)
    assert started == [n for n in started if n]  # backend then frontend
    backend_side.Supervisor(tmp_path).restart()
    assert sup.tick() is True
    assert len(stopped) == 2
    assert len(started) == 4
    assert not (tmp_path / app.REQ_RESTART).exists()
    assert sup.tick() is True  # new children are healthy


def test_pause_and_resume_the_frontend_with_handshake(tmp_path):
    app, sup, started, stopped = make(tmp_path)
    side = backend_side.Supervisor(tmp_path, sleep=lambda s: sup.tick())
    assert side.pause_frontend(timeout=5) is True
    assert stopped == [n for n in stopped if n.startswith("frontend")] and len(stopped) == 1
    # A stopped frontend is not a reason to shut down while paused.
    assert sup.tick() is True
    side.resume_frontend()
    assert sup.tick() is True
    assert sum(1 for n in started if n.startswith("frontend")) == 2
    assert not (tmp_path / app.ACK_PAUSED).exists()


def test_pause_without_a_supervisor_answers_false(tmp_path):
    side = backend_side.Supervisor(tmp_path / "missing", sleep=lambda s: None)
    assert side.available is False
    assert side.pause_frontend(timeout=0.01) is False
    side.restart()  # a no-op, never raises
    assert not (tmp_path / "missing").exists()


def test_unexpected_exits_still_shut_down(tmp_path):
    app, sup, started, stopped = make(tmp_path)
    sup.backend.returncode = 1
    assert sup.tick() is False
    app2, sup2, *_ = make(tmp_path / "b")
    sup2.frontend.returncode = 1
    assert sup2.tick() is False


def test_backend_environment_carries_the_protocol(tmp_path, monkeypatch):
    app = _load_app()
    env = app._backend_env(control_dir=tmp_path, packaged=True, backend_port=1, frontend_port=2)
    assert env[app.SUPERVISOR_ENV] == str(tmp_path)
    assert env[app.LAUNCH_MODE_ENV] == "packaged"
    assert env["BACKEND_PORT"] == "1" and env["FRONTEND_PORT"] == "2"


def test_pause_handshake_across_threads(tmp_path):
    app, sup, started, stopped = make(tmp_path)
    stop = threading.Event()

    def loop():
        while not stop.is_set():
            sup.tick()
            stop.wait(0.02)

    t = threading.Thread(target=loop)
    t.start()
    try:
        assert backend_side.Supervisor(tmp_path).pause_frontend(timeout=5) is True
    finally:
        stop.set()
        t.join()
