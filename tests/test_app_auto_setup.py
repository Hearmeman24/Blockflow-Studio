"""app.py installs what a fresh clone is missing before it starts the servers.

Every command, HTTP request and port is faked (tests/doctor_fakes.py); nothing
is installed and no process is started.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from doctor_fakes import Fake, load_script, make_root  # noqa: E402

install_steps = load_script("install_steps")

ROOT = Path(__file__).resolve().parent.parent
NPM_CI = ["npm", "--prefix", "frontend", "ci"]
CODEGEN = ["npm", "--prefix", "frontend", "run", "gen:custom-blocks"]
FASTMCP = ["uv", "run", "--with", "fastmcp", "python", "-c", "import fastmcp"]
UV_SYNC = ["uv", "sync", "--extra", "dev"]


def _load_app():
    spec = importlib.util.spec_from_file_location("blockflow_app_auto_setup", ROOT / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


app = _load_app()


@pytest.fixture
def root(tmp_path):
    return make_root(tmp_path)


@pytest.fixture
def fake(root):
    f = Fake(root)
    f.routes.clear()  # nothing is running yet
    return f


def hidden_lock(root: Path) -> Path:
    return root / "frontend" / "node_modules" / ".package-lock.json"


def registry(root: Path) -> Path:
    return root / "frontend" / "src" / "components" / "pipeline" / "custom_blocks" / "_register.ts"


def fresh(root: Path) -> None:
    hidden_lock(root).unlink()
    registry(root).unlink()


def auto(fake, **environ):
    lines: list[str] = []
    code = app._auto_setup(fake.env(**environ), lines.append)
    return code, "\n".join(lines)


def installs(fake):
    return [c for c in fake.calls if c in (NPM_CI, CODEGEN, FASTMCP, UV_SYNC)]


def test_fresh_clone_installs_the_frontend_then_registers_blocks(fake, root):
    fresh(root)
    fake.failing.add("uv run --offline")  # FastMCP not in uv's cache yet
    code, text = auto(fake)
    assert code == 0, text
    assert installs(fake) == [NPM_CI, CODEGEN, FASTMCP]
    assert "First start: installing the frontend packages" in text


def test_never_runs_uv_sync(fake, root):
    fresh(root)
    fake.failing.add("uv sync --check")
    auto(fake)
    assert not any(c[:2] == ["uv", "sync"] for c in fake.calls)


def test_up_to_date_install_runs_nothing_and_stays_quiet(fake):
    code, text = auto(fake)
    assert code == 0
    assert fake.calls == []  # no command, no version probe
    assert text == ""


def test_changed_lockfile_reinstalls(fake, root):
    lock = root / "frontend" / "package-lock.json"
    old = hidden_lock(root).stat().st_mtime
    os.utime(lock, (old + 60, old + 60))
    code, text = auto(fake)
    assert code == 0, text
    assert installs(fake)[:2] == [NPM_CI, CODEGEN]


def test_missing_registry_only_runs_the_codegen(fake, root):
    registry(root).unlink()
    code, _ = auto(fake)
    assert code == 0
    assert installs(fake) == [CODEGEN]


def test_opt_out_skips_everything(fake, root):
    fresh(root)
    code, text = auto(fake, BLOCKFLOW_NO_AUTO_SETUP="1")
    assert code == 0
    assert fake.calls == []
    assert text == ""


def test_missing_npm_stops_with_the_doctor_fix(fake, root):
    fresh(root)
    fake.tools.pop("npm")
    code, text = auto(fake)
    assert code == 1
    assert installs(fake) == []
    assert "npm" in text and "nodejs.org" in text


def test_old_node_stops_with_the_doctor_fix(fake, root):
    fresh(root)
    fake.tools["node"] = "v20.1.0"
    code, text = auto(fake)
    assert code == 1
    assert installs(fake) == []
    assert "older than the required 22.14.0" in text and "nodejs.org" in text


def test_failed_npm_ci_stops_and_names_the_retry(fake, root):
    fresh(root)
    fake.failing.add("npm --prefix frontend")
    code, text = auto(fake)
    assert code == 1
    assert installs(fake) == [NPM_CI]
    assert "npm --prefix frontend ci" in text and "uv run app.py" in text
    assert not hidden_lock(root).exists()


def test_failed_codegen_stops(fake, root):
    registry(root).unlink()
    fake.failing.add("npm --prefix frontend")
    code, text = auto(fake)
    assert code == 1
    assert "gen:custom-blocks" in text


def test_fastmcp_failure_does_not_block_the_start(fake, root):
    fresh(root)
    fake.failing.add("uv run --offline")
    fake.failing.add("uv run --with")
    code, text = auto(fake)
    assert code == 0, text
    assert "FastMCP" in text


def test_ctrl_c_during_install_exits_cleanly_and_the_next_start_retries(fake, root):
    fresh(root)
    real_run = fake.run

    def interrupted(cmd, cwd=None, timeout=30.0):
        if cmd == NPM_CI:
            fake.calls.append(list(cmd))
            hidden_lock(root).parent.mkdir(parents=True, exist_ok=True)
            hidden_lock(root).write_text("{}")  # npm got far enough to write it
            raise KeyboardInterrupt
        return real_run(cmd, cwd, timeout)

    lines: list[str] = []
    env = fake.env()
    env.run = interrupted
    code = app._auto_setup(env, lines.append)
    assert code == 130
    assert "interrupted" in "\n".join(lines).lower()
    assert not hidden_lock(root).exists()

    fake.calls.clear()
    code, _ = auto(fake)
    assert code == 0
    assert NPM_CI in installs(fake)


def test_this_checkout_already_running_is_reported_not_reinstalled(fake, root):
    fresh(root)
    fake.routes[47301] = {"/api/app/version": (200, {"checkout_id": install_steps.checkout_id(root)})}
    code, text = auto(fake)
    assert code == 1
    assert installs(fake) == []
    assert "already running" in text


def test_another_copy_running_does_not_block_the_install(fake, root):
    fresh(root)
    other = {"/api/providers/catalog": (200, {"providers": {}, "models": []}),
             "/api/app/version": (200, {"checkout_id": "f" * 16})}
    fake.routes[47300] = dict(other)
    fake.routes[47301] = dict(other)
    code, text = auto(fake)
    assert code == 0, text
    assert NPM_CI in installs(fake)


def test_main_never_starts_servers_after_a_failed_install(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["app.py"])
    monkeypatch.delenv("BLOCKFLOW_PACKAGED", raising=False)
    monkeypatch.setattr(app, "_auto_setup", lambda *a, **k: 1)

    def no_popen(*a, **k):
        raise AssertionError("a server was started on a half-installed frontend")

    monkeypatch.setattr(subprocess, "Popen", no_popen)
    with pytest.raises(SystemExit) as exc:
        app.main()
    assert exc.value.code == 1


def test_packaged_mode_never_installs(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["app.py", "--packaged"])
    monkeypatch.setattr(app, "_auto_setup", lambda *a, **k: pytest.fail("packaged mode must not install"))

    class Stop(Exception):
        pass

    def stop(*a, **k):
        raise Stop

    monkeypatch.setattr(app, "_find_standalone_server", stop)
    monkeypatch.setattr(app.ProcessSupervisor, "start", lambda self: stop())
    with pytest.raises(Stop):
        app.main()


def test_update_restart_does_not_reinstall(tmp_path, monkeypatch):
    monkeypatch.setattr(app, "_auto_setup", lambda *a, **k: pytest.fail("a restart must not run the installer"))

    class Proc:
        def __init__(self):
            self.args, self.returncode = ["x"], None

        def poll(self):
            return None

    started: list[str] = []
    sup = app.ProcessSupervisor(control_dir=tmp_path,
                                start_backend=lambda: started.append("backend") or Proc(),
                                start_frontend=lambda: started.append("frontend") or Proc(),
                                stop=lambda procs: None)
    sup.start()
    (tmp_path / app.REQ_RESTART).write_text("1")
    assert sup.tick() is True
    assert started == ["backend", "frontend", "backend", "frontend"]


# ------------------------------------------------------------------ output in a pipe

# A child that loads app.py, applies the launcher's output setup, prints one
# launcher line and then blocks on stdin, like a long install step. With block
# buffering the line would sit in the buffer until the child exits; the parent
# must see it while the child is still waiting.
_PIPE_CHILD = """
import importlib.util, sys
spec = importlib.util.spec_from_file_location("app_pipe_child", sys.argv[1])
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)
app._line_buffered_output()
print("[app] First start: installing the frontend packages, this can take a few minutes...")
sys.stdin.readline()  # the "install step": waits until the parent has read the line
print("[app] done")
"""


def test_launcher_lines_reach_a_pipe_before_the_step_finishes():
    import queue
    import threading

    env = {k: v for k, v in os.environ.items() if k != "PYTHONUNBUFFERED"}
    child = subprocess.Popen([sys.executable, "-c", _PIPE_CHILD, str(ROOT / "app.py")],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
    lines: queue.Queue = queue.Queue()
    threading.Thread(target=lambda: lines.put(child.stdout.readline()), daemon=True).start()
    try:
        first = lines.get(timeout=20)
    except queue.Empty:
        first = None
    finally:
        child.stdin.write("\n")
        child.stdin.close()
        child.wait(timeout=20)
        child.stdout.close()
    assert first is not None and "First start" in first, "the launcher's line was buffered until exit"


def test_line_buffering_tolerates_streams_without_reconfigure(monkeypatch):
    import io

    monkeypatch.setattr(sys, "stdout", io.StringIO())  # StringIO has no reconfigure()
    monkeypatch.setattr(sys, "stderr", io.StringIO())
    app._line_buffered_output()  # must not raise


def test_main_sets_up_line_buffering_first(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(sys, "argv", ["app.py"])
    monkeypatch.delenv("BLOCKFLOW_PACKAGED", raising=False)
    monkeypatch.setattr(app, "_line_buffered_output", lambda: calls.append("buffering"))
    monkeypatch.setattr(app, "_auto_setup", lambda *a, **k: calls.append("setup") or 1)
    with pytest.raises(SystemExit):
        app.main()
    assert calls == ["buffering", "setup"]
