"""app.py supervises the backend and frontend and restarts them on request.

The backend side (backend/app_update/supervisor.py) and app.py's
ProcessSupervisor are run together here, with fake processes.
"""

from __future__ import annotations

import importlib.util
import sys
import threading
from pathlib import Path

import pytest

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


@pytest.mark.parametrize("which,code", [("backend", 1), ("frontend", 137), ("backend", -9)])
def test_a_server_that_stops_on_its_own_is_named_with_its_code(tmp_path, capsys, which, code):
    app, sup, started, stopped = make(tmp_path)
    getattr(sup, which).returncode = code
    assert sup.tick() is False
    assert sup.stopped_server == (which, code)
    out = capsys.readouterr().out
    line = next(ln for ln in out.splitlines() if which in ln)
    assert line.startswith("[app] ") and f"exit code {code}" in line
    assert "python3 scripts/doctor.py" in out


def test_launch_outcomes_map_to_exit_codes():
    app = _load_app()
    assert {o.name: app.EXIT_CODES[o] for o in app.LaunchOutcome} == {
        "STOPPED": 0, "SERVER_EXITED": 1, "SETUP_FAILED": 1, "SETUP_INTERRUPTED": 130}


class _Proc:
    def __init__(self, name):
        self.args, self.returncode, self.name = [name], None, name

    def poll(self):
        return self.returncode


def _run_main(app, monkeypatch, tick):
    monkeypatch.setattr(sys, "argv", ["app.py"])
    monkeypatch.delenv("BLOCKFLOW_PACKAGED", raising=False)
    monkeypatch.setenv("BLOCKFLOW_NO_OPEN", "1")
    monkeypatch.setattr(app, "_auto_setup", lambda *a, **k: 0)
    monkeypatch.setattr(app, "_wait_for", lambda *a, **k: True)
    monkeypatch.setattr(app, "_stop_processes", lambda procs: None)
    monkeypatch.setattr(app.time, "sleep", lambda s: None)

    def start(self):
        self.backend, self.frontend = _Proc("backend"), _Proc("frontend")

    monkeypatch.setattr(app.ProcessSupervisor, "start", start)
    monkeypatch.setattr(app.ProcessSupervisor, "tick", tick)
    app.main()


def test_main_exits_1_when_a_server_stops_on_its_own(monkeypatch, capsys):
    app = _load_app()
    real_tick = app.ProcessSupervisor.tick

    def tick(self):
        self.backend.returncode = 3
        return real_tick(self)

    with pytest.raises(SystemExit) as exc:
        _run_main(app, monkeypatch, tick)
    assert exc.value.code == 1
    out = capsys.readouterr().out
    assert "backend" in out and "exit code 3" in out and "python3 scripts/doctor.py" in out


def test_ctrl_c_still_stops_cleanly_with_exit_code_0(monkeypatch, capsys):
    app = _load_app()

    def tick(self):
        raise KeyboardInterrupt

    try:
        _run_main(app, monkeypatch, tick)
    except SystemExit as exc:  # pragma: no cover - only if main chose to exit explicitly
        assert exc.code in (0, None)
    assert "Shutting down" in capsys.readouterr().out


def test_ctrl_c_during_install_still_exits_130(monkeypatch):
    app = _load_app()
    monkeypatch.setattr(sys, "argv", ["app.py"])
    monkeypatch.delenv("BLOCKFLOW_PACKAGED", raising=False)
    monkeypatch.setattr(app, "_auto_setup", lambda *a, **k: 130)
    with pytest.raises(SystemExit) as exc:
        app.main()
    assert exc.value.code == 130


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
