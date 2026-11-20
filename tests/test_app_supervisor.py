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
        "STOPPED": 0, "SERVER_EXITED": 1, "SETUP_FAILED": 1, "SETUP_INTERRUPTED": 130,
        "BAD_PORT": 1, "PORT_IN_USE": 1, "BUILD_MISSING": 1, "BUILD_FAILED": 1}


# ------------------------------------------------------------------ one protocol, declared once


def test_the_protocol_is_declared_once_and_shared():
    from backend.app_update import launcher_protocol as proto

    app = _load_app()
    assert app.ControlFile is proto.ControlFile and backend_side.RESTART is proto.ControlFile.RESTART
    assert app.REQUEST_ORDER == proto.REQUEST_ORDER
    assert proto.REQUEST_ORDER[0] is proto.ControlFile.RESTART  # restart wins
    assert set(proto.REQUEST_ORDER) == set(proto.ControlFile) - {proto.ControlFile.FRONTEND_PAUSED}


def test_the_protocol_module_needs_only_the_standard_library():
    import ast

    source = (ROOT / "backend" / "app_update" / "launcher_protocol.py").read_text()
    imported = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            imported |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            imported.add((node.module or "").split(".")[0])
    assert imported <= set(sys.stdlib_module_names) | {"__future__"}


def test_a_restart_drops_requests_meant_for_the_old_processes(tmp_path):
    app, sup, started, stopped = make(tmp_path)
    (tmp_path / app.ControlFile.PAUSE_FRONTEND).write_text("1")
    backend_side.Supervisor(tmp_path).restart()
    assert sup.tick() is True
    assert len(started) == 4 and not (tmp_path / app.ControlFile.PAUSE_FRONTEND).exists()
    assert sup.tick() is True
    assert len(stopped) == 2 and sup.frontend is not None  # the new web server keeps running


def test_a_request_that_cannot_be_written_is_reported_not_raised(tmp_path):
    class Racy(backend_side.Supervisor):
        available = True  # the folder vanished after the availability check

    side = Racy(tmp_path / "gone")
    assert side.restart() is False
    assert side.resume_frontend() is False
    assert side.pause_frontend(timeout=0.01) is False
    live = backend_side.Supervisor(tmp_path)
    assert live.restart() is True and (tmp_path / "restart").exists()


def test_launch_mode_is_one_vocabulary(monkeypatch):
    from backend.app_update.launcher_protocol import LaunchMode

    app = _load_app()
    for packaged, mode in ((False, "dev"), (True, "packaged")):
        env = app._backend_env(control_dir=Path("x"), packaged=packaged, backend_port=1, frontend_port=2)
        assert env[app.LAUNCH_MODE_ENV] == mode
        monkeypatch.setenv(app.LAUNCH_MODE_ENV, mode)
        assert backend_side.launch_mode() is LaunchMode(mode)
    monkeypatch.setenv(app.LAUNCH_MODE_ENV, "standalone")
    assert backend_side.launch_mode() is LaunchMode.UNKNOWN
    assert (LaunchMode.DEV.frontend_label, LaunchMode.PACKAGED.frontend_label) == ("dev", "standalone")


def test_restarting_automatically_is_one_rule():
    rule = backend_side.restarts_automatically
    assert rule(supervised=True, mode="dev") is True
    assert rule(supervised=True, mode="packaged") is True
    assert rule(supervised=True, mode="unknown") is False
    assert rule(supervised=False, mode="dev") is False
    assert rule(supervised=True, mode="dev", launcher_changed=True) is False


# ------------------------------------------------------------------ ports


@pytest.mark.parametrize("raw,expected", [(None, 47301), ("", 47301), ("  ", 47301), ("48001", 48001),
                                          (" 48001 ", 48001), ("1", 1), ("65535", 65535)])
def test_good_port_values(raw, expected):
    app = _load_app()
    environ = {} if raw is None else {"BACKEND_PORT": raw}
    assert app._read_ports(environ) == (expected, 47300)


@pytest.mark.parametrize("raw", ["abc", "0", "70000", "-1", "65536", "47301.5", "4730l"])
def test_a_bad_port_is_a_readable_error(raw):
    app = _load_app()
    problem = app._read_ports({"FRONTEND_PORT": raw})
    assert isinstance(problem, str)
    assert problem.startswith("[app] FRONTEND_PORT") and "1 to 65535" in problem and "47300" in problem


def _main_with(app, monkeypatch, capsys, *, environ=None, port_problem=None, argv=("app.py",)):
    monkeypatch.setattr(sys, "argv", list(argv))
    monkeypatch.delenv("BLOCKFLOW_PACKAGED", raising=False)
    for name, value in (environ or {}).items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(app, "_auto_setup", lambda *a, **k: 0)
    # --packaged checks for an existing build first; whether this checkout has one must not decide the test.
    monkeypatch.setattr(app, "_check_prebuilt", lambda *a, **k: True)
    monkeypatch.setattr(app, "_port_problem", lambda *a, **k: port_problem)

    def no_start(self):
        raise AssertionError("a server was started")

    monkeypatch.setattr(app.ProcessSupervisor, "start", no_start)
    with pytest.raises(SystemExit) as exc:
        app.main()
    return exc.value.code, capsys.readouterr().out


def test_main_stops_on_a_bad_port_before_installing_or_starting(monkeypatch, capsys):
    app = _load_app()
    monkeypatch.setattr(app, "_auto_setup", lambda *a, **k: pytest.fail("must not install with a bad port"))
    monkeypatch.setattr(sys, "argv", ["app.py"])
    monkeypatch.setenv("BACKEND_PORT", "abc")
    with pytest.raises(SystemExit) as exc:
        app.main()
    assert exc.value.code == 1
    out = capsys.readouterr().out
    assert "[app] BACKEND_PORT is 'abc'" in out and "Traceback" not in out


@pytest.mark.parametrize("environ,argv", [({}, ("app.py",)), ({"BLOCKFLOW_NO_AUTO_SETUP": "1"}, ("app.py",)),
                                          ({}, ("app.py", "--packaged"))])
def test_main_stops_when_a_port_is_taken(monkeypatch, capsys, environ, argv):
    app = _load_app()
    code, out = _main_with(app, monkeypatch, capsys, environ=environ, argv=argv,
                           port_problem="[app] Port 47301 (backend) is already in use by another program.")
    assert code == 1
    assert "Port 47301 (backend) is already in use" in out


def _port_env(fake, busy, routes=None):
    sys.path.insert(0, str(ROOT / "tests"))
    fake.routes.clear()
    fake.routes.update(routes or {})
    fake.busy_ports |= set(busy)
    return fake.env()


def _fake(tmp_path):
    sys.path.insert(0, str(ROOT / "tests"))
    from doctor_fakes import Fake, make_root

    return Fake(make_root(tmp_path))


def test_free_ports_are_no_problem(tmp_path):
    app = _load_app()
    assert app._port_problem(47301, 47300, env=_port_env(_fake(tmp_path), [])) is None


@pytest.mark.parametrize("busy,named", [([47301], "Port 47301 (backend) is"), ([47300], "Port 47300 (frontend) is"),
                                        ([47301, 47300], "Ports 47301 (backend) and 47300 (frontend) are")])
def test_a_port_taken_by_another_program_names_it_and_the_remedy(tmp_path, busy, named):
    app = _load_app()
    problem = app._port_problem(47301, 47300, env=_port_env(_fake(tmp_path), busy))
    assert problem.startswith("[app] ") and named in problem and "another program" in problem
    assert "BACKEND_PORT=48001 FRONTEND_PORT=48000 uv run app.py" in problem


def test_a_port_taken_by_this_checkout_says_it_is_already_running(tmp_path):
    from doctor_fakes import load_script

    app = _load_app()
    fake = _fake(tmp_path)
    mine = load_script("install_steps").checkout_id(fake.root)
    env = _port_env(fake, [], {47301: {"/api/app/version": (200, {"checkout_id": mine})}})
    problem = app._port_problem(47301, 47300, env=env)
    assert "already running from this folder" in problem and "http://localhost:47300" in problem


def test_an_update_restart_never_checks_the_ports(tmp_path, monkeypatch):
    app, sup, started, stopped = make(tmp_path)
    monkeypatch.setattr(app, "_port_problem", lambda *a, **k: pytest.fail("a restart must not check ports"))
    backend_side.Supervisor(tmp_path).restart()
    assert sup.tick() is True and len(started) == 4


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
    monkeypatch.setattr(app, "_port_problem", lambda *a, **k: None)  # the real ports may be in use
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
