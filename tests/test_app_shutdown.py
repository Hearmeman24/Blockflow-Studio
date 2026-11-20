"""Stopping the app: one Ctrl+C (or SIGTERM, or SIGHUP) always ends in a clean stop.

A terminal's Ctrl+C reaches app.py twice (from the terminal and again from uv,
which forwards it), and a page holding the jobs event stream open keeps
uvicorn's graceful shutdown waiting. The launcher therefore ignores every stop
signal after the first, bounds uvicorn's graceful shutdown, starts each server
in its own process group and kills a group that has not exited after a short
grace period. Fake processes and a fake clock; no server is started.
"""

from __future__ import annotations

import importlib.util
import signal
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def _load_app():
    spec = importlib.util.spec_from_file_location("blockflow_app_entry_shutdown", ROOT / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


class FakeServer:
    """A child process. ``exits_on_term``: it stops when asked; otherwise only a kill stops it."""

    def __init__(self, clock, pid, *, exits_on_term=True, already_exited=False):
        self.clock, self.pid, self.exits_on_term = clock, pid, exits_on_term
        self.returncode = 0 if already_exited else None
        self.got: list[str] = []
        self.waits: list[float] = []

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self.waits.append(timeout)
        if self.returncode is None:
            self.clock.now += timeout or 0
            raise subprocess.TimeoutExpired("server", timeout)
        return self.returncode


def _signaller(log):
    def signal_tree(proc, *, kill):
        log.append((proc.pid, "kill" if kill else "term"))
        proc.got.append("kill" if kill else "term")
        if kill or proc.exits_on_term:
            proc.returncode = -9 if kill else 0
    return signal_tree


# ------------------------------------------------------------------ stopping the servers


def test_servers_that_stop_when_asked_are_not_killed():
    app, clock, log = _load_app(), Clock(), []
    procs = [FakeServer(clock, 11), FakeServer(clock, 12)]
    app._stop_processes(procs, signal_tree=_signaller(log), clock=clock)
    assert log == [(11, "term"), (12, "term")]


def test_a_server_that_ignores_the_request_is_killed_after_one_shared_grace_period():
    app, clock, log = _load_app(), Clock(), []
    stuck = [FakeServer(clock, 21, exits_on_term=False), FakeServer(clock, 22, exits_on_term=False)]
    app._stop_processes(stuck, grace=5.0, signal_tree=_signaller(log), clock=clock)
    assert log == [(21, "term"), (22, "term"), (21, "kill"), (22, "kill")]
    # One deadline for all of them: the second server gets what is left of it, not 5 more seconds.
    assert stuck[0].waits[0] == pytest.approx(5.0) and stuck[1].waits[0] == pytest.approx(0.0)
    assert clock.now - 100.0 <= 5.0 + 1e-9


def test_a_server_that_already_exited_is_left_alone():
    app, clock, log = _load_app(), Clock(), []
    app._stop_processes([FakeServer(clock, 31, already_exited=True)], signal_tree=_signaller(log), clock=clock)
    assert log == []


@pytest.mark.skipif(sys.platform == "win32", reason="process groups are POSIX")
def test_the_whole_process_group_is_signalled(monkeypatch):
    app = _load_app()
    sent = []
    monkeypatch.setattr(app.os, "killpg", lambda pgid, sig: sent.append((pgid, sig)))
    proc = FakeServer(Clock(), 41)
    app._signal_tree(proc, kill=False)
    app._signal_tree(proc, kill=True)
    # npm run dev -> next dev -> its workers: the group takes them all.
    assert sent == [(41, signal.SIGTERM), (41, signal.SIGKILL)]


@pytest.mark.skipif(sys.platform == "win32", reason="process groups are POSIX")
def test_a_server_outside_its_own_group_is_signalled_directly(monkeypatch):
    app = _load_app()

    def no_group(pgid, sig):
        raise ProcessLookupError

    class Proc(FakeServer):
        def send_signal(self, sig):
            self.got.append(sig)

    monkeypatch.setattr(app.os, "killpg", no_group)
    proc = Proc(Clock(), 42)
    app._signal_tree(proc, kill=False)
    assert proc.got == [signal.SIGTERM]


@pytest.mark.skipif(sys.platform == "win32", reason="process groups are POSIX")
def test_servers_start_in_their_own_process_group(monkeypatch, tmp_path):
    app = _load_app()
    seen = {}

    def popen(cmd, **kwargs):
        seen.update(kwargs, cmd=cmd)
        return "proc"

    monkeypatch.setattr(app.subprocess, "Popen", popen)
    assert app._spawn(["x"], cwd=tmp_path, env={"A": "1"}) == "proc"
    # Ctrl+C then reaches only the launcher, which stops each server (and what it started) in order.
    assert seen["start_new_session"] is True and seen["cwd"] == str(tmp_path) and seen["env"] == {"A": "1"}


def test_uvicorn_stops_waiting_for_open_connections_before_the_kill():
    app = _load_app()
    command = app._backend_command(8123)
    flag = command.index("--timeout-graceful-shutdown")
    assert 0 < int(command[flag + 1]) < app.STOP_GRACE_S


# ------------------------------------------------------------------ the stop signals


def test_only_the_first_stop_signal_interrupts():
    app = _load_app()
    signals = app.StopSignals()
    with pytest.raises(KeyboardInterrupt):
        signals.handle(signal.SIGINT, None)
    assert signals.handle(signal.SIGINT, None) is None  # uv's forwarded copy of the same Ctrl+C
    assert signals.handle(signal.SIGTERM, None) is None


def test_no_signal_interrupts_once_the_shutdown_began():
    app = _load_app()
    signals = app.StopSignals()
    signals.begin_shutdown()
    assert signals.handle(signal.SIGINT, None) is None


def test_install_and_restore_leave_the_handlers_as_they_were():
    app = _load_app()
    before = {s: signal.getsignal(s) for s in app.STOP_SIGNALS}
    signals = app.StopSignals()
    signals.install()
    try:
        assert all(signal.getsignal(s) == signals.handle for s in app.STOP_SIGNALS)
    finally:
        signals.restore()
    assert {s: signal.getsignal(s) for s in app.STOP_SIGNALS} == before
    assert signal.SIGINT in app.STOP_SIGNALS and signal.SIGTERM in app.STOP_SIGNALS


# ------------------------------------------------------------------ the whole launcher


class _Proc:
    def __init__(self, name):
        self.args, self.returncode, self.name = [name], None, name

    def poll(self):
        return self.returncode


def _run_main(app, monkeypatch, *, tick, stop):
    monkeypatch.setattr(sys, "argv", ["app.py"])
    monkeypatch.delenv("BLOCKFLOW_PACKAGED", raising=False)
    monkeypatch.setenv("BLOCKFLOW_NO_OPEN", "1")
    monkeypatch.setattr(app, "_auto_setup", lambda *a, **k: 0)
    monkeypatch.setattr(app, "_port_problem", lambda *a, **k: None)
    monkeypatch.setattr(app, "_wait_for", lambda *a, **k: True)
    monkeypatch.setattr(app, "_stop_processes", stop)
    monkeypatch.setattr(app.time, "sleep", lambda s: None)

    def start(self):
        self.backend, self.frontend = _Proc("backend"), _Proc("frontend")

    monkeypatch.setattr(app.ProcessSupervisor, "start", start)
    monkeypatch.setattr(app.ProcessSupervisor, "tick", tick)
    before = signal.getsignal(signal.SIGINT)
    app.main()  # returns: exit code 0
    assert signal.getsignal(signal.SIGINT) == before  # the launcher's handlers are gone again


def _deliver(sig):
    """What the operating system does: call the handler installed for ``sig``."""
    handler = signal.getsignal(sig)
    assert callable(handler), f"no handler for {sig!r}"
    handler(sig, None)


def test_a_second_ctrl_c_during_the_shutdown_does_not_abort_it(monkeypatch, capsys):
    app = _load_app()
    stopped = []

    def tick(self):
        _deliver(signal.SIGINT)  # the terminal's Ctrl+C
        return True

    def stop(procs):
        _deliver(signal.SIGINT)  # uv forwards the same Ctrl+C while the servers stop
        _deliver(signal.SIGINT)  # and an impatient user presses it again
        stopped.extend(p.name for p in procs)

    _run_main(app, monkeypatch, tick=tick, stop=stop)
    out = capsys.readouterr().out
    assert stopped == ["backend", "frontend"]
    assert "Shutting down" in out and "[app] Stopped." in out and "Traceback" not in out


@pytest.mark.parametrize("name", ["SIGTERM", "SIGHUP"])
def test_sigterm_and_sighup_stop_like_ctrl_c(monkeypatch, capsys, name):
    if not hasattr(signal, name):
        pytest.skip(f"{name} does not exist here")
    app = _load_app()
    stopped = []

    def tick(self):
        _deliver(getattr(signal, name))
        return True

    _run_main(app, monkeypatch, tick=tick, stop=lambda procs: stopped.extend(p.name for p in procs))
    out = capsys.readouterr().out
    assert stopped == ["backend", "frontend"] and "[app] Stopped." in out


def test_a_server_that_stops_on_its_own_still_stops_the_other_with_exit_1(monkeypatch, capsys):
    app = _load_app()
    stopped = []

    def tick(self):
        self.backend.returncode = 3
        return app.ProcessSupervisor._children_alive(self)

    with pytest.raises(SystemExit) as exc:
        _run_main(app, monkeypatch, tick=tick, stop=lambda procs: stopped.extend(p.name for p in procs))
    assert exc.value.code == 1
    assert stopped == ["backend", "frontend"] and "[app] Stopped." in capsys.readouterr().out
