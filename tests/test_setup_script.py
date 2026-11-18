"""scripts/setup.py: idempotent setup against fake commands, HTTP and ports.

Nothing here installs anything, starts a process or reads the user's data.
"""

from __future__ import annotations

import builtins
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from doctor_fakes import Fake, load_script, make_root  # noqa: E402

setup = load_script("setup")
install_steps = load_script("install_steps")

UV_SYNC = ["uv", "sync", "--extra", "dev"]
NPM_CI = ["npm", "--prefix", "frontend", "ci"]
CODEGEN = ["npm", "--prefix", "frontend", "run", "gen:custom-blocks"]
FASTMCP = ["uv", "run", "--with", "fastmcp", "python", "-c", "import fastmcp"]
INSTALLS = (UV_SYNC, NPM_CI, CODEGEN, FASTMCP)


@pytest.fixture
def root(tmp_path):
    return make_root(tmp_path)


@pytest.fixture
def fake(root):
    f = Fake(root)
    f.routes.clear()  # the app is not running during setup
    return f


@pytest.fixture(autouse=True)
def no_prompts(monkeypatch):
    def refuse(*_a, **_k):
        raise AssertionError("setup must never ask for input (and never for a key)")

    monkeypatch.setattr(builtins, "input", refuse)


def run(fake, *argv):
    lines: list[str] = []
    code = setup.main(list(argv), fake.env(), lines.append)
    return code, "\n".join(lines)


def installs(fake):
    return [c for c in fake.calls if c in INSTALLS]


def fresh(fake, root):
    (root / "frontend" / "node_modules" / ".package-lock.json").unlink()
    fake.failing |= {"uv sync --check", "uv run --offline"}


def test_fresh_checkout_installs_everything_in_order(fake, root):
    fresh(fake, root)
    code, text = run(fake)
    assert code == 0
    assert installs(fake) == [UV_SYNC, NPM_CI, CODEGEN, FASTMCP]
    assert "uv run app.py" in text
    assert f'claude mcp add blockflow-studio -- uv run --directory "{root}" --with fastmcp mcp_server.py' in text
    assert "scripts/doctor.py" in text
    assert "Settings -> API keys" in text


def test_second_run_skips_what_is_already_done(fake):
    code, text = run(fake)
    assert code == 0
    # Only the block codegen runs again: it is cheap and always regenerates the same files.
    assert installs(fake) == [CODEGEN]
    assert text.count("already done") == 3


def test_check_mode_reports_and_changes_nothing(fake, root):
    fresh(fake, root)
    code, text = run(fake, "--check")
    assert code == 0
    assert installs(fake) == []
    for cmd in INSTALLS:
        assert " ".join(cmd) in text
    assert "would run" in text


def test_missing_prerequisite_stops_before_installing(fake, root):
    fresh(fake, root)
    fake.tools.pop("node")
    code, text = run(fake)
    assert code == 1
    assert installs(fake) == []
    assert "node" in text and "nodejs.org" in text


def test_old_prerequisite_stops_before_installing(fake):
    fake.tools["node"] = "v20.1.0"
    code, text = run(fake)
    assert code == 1 and installs(fake) == []
    assert "older than the required 22.14.0" in text


def test_git_is_optional(fake):
    fake.tools.pop("git")
    code, _ = run(fake)
    assert code == 0


def test_refuses_npm_ci_while_the_app_is_running(fake, root):
    (root / "frontend" / "node_modules" / ".package-lock.json").unlink()
    fake.routes[47300] = {"/api/providers/catalog": (200, {"providers": {}, "models": []})}
    code, text = run(fake)
    assert code == 1
    assert NPM_CI not in fake.calls
    assert "Stop the app" in text


def test_refuses_npm_ci_while_this_checkout_is_running(fake, root):
    (root / "frontend" / "node_modules" / ".package-lock.json").unlink()
    fake.routes[47300] = {"/api/providers/catalog": (200, {"providers": {}, "models": []}),
                          "/api/app/version": (200, {"version": "0.2.0",
                                                     "checkout_id": install_steps.checkout_id(root)})}
    code, text = run(fake)
    assert code == 1
    assert NPM_CI not in fake.calls
    assert "Stop the app" in text


def test_installs_while_another_copy_of_the_app_is_running(fake, root):
    (root / "frontend" / "node_modules" / ".package-lock.json").unlink()
    other = {"/api/providers/catalog": (200, {"providers": {}, "models": []}),
             "/api/app/version": (200, {"version": "0.2.0", "checkout_id": "0" * 16})}
    fake.routes[47300] = dict(other)
    fake.routes[47301] = dict(other)
    code, text = run(fake)
    assert code == 0, text
    assert NPM_CI in fake.calls


def test_checkout_id_is_stable_and_differs_per_folder(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    assert install_steps.checkout_id(a) == install_steps.checkout_id(a)
    assert install_steps.checkout_id(a) != install_steps.checkout_id(b)
    assert str(a) not in install_steps.checkout_id(a) and len(install_steps.checkout_id(a)) == 16


def test_a_failing_step_stops_the_rest(fake, root):
    fresh(fake, root)
    fake.failing.add("uv sync --extra")
    code, text = run(fake)
    assert code == 1
    assert installs(fake) == [UV_SYNC]  # attempted and failed; nothing after it ran
    assert "uv sync --extra dev failed" in text


def test_never_starts_long_running_processes(fake, root):
    fresh(fake, root)
    run(fake)
    for cmd in fake.calls:
        joined = " ".join(cmd)
        assert "app.py" not in joined and "mcp_server.py" not in joined and "npm run dev" not in joined
