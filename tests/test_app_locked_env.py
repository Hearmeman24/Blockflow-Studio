"""`uv run app.py` runs on the versions in uv.lock.

An inline script block (``# /// script`` with ``dependencies``) makes uv build
a separate environment for app.py from the newest releases and ignore the
project's lock, so users would run versions that CI never tested, and the
update engine's ``uv sync --frozen`` would not change what the app runs. Without
it, uv runs app.py in the project environment (``.venv``, synced from uv.lock,
without the dev extras), and the backend it starts uses that same interpreter.
"""

from __future__ import annotations

import importlib.util
import re
import sys
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def _load_app():
    spec = importlib.util.spec_from_file_location("blockflow_app_entry_locked", ROOT / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_app_py_declares_no_dependencies_of_its_own():
    source = (ROOT / "app.py").read_text(encoding="utf-8")
    # PEP 723 block: any of it makes `uv run app.py` ignore uv.lock.
    assert not re.search(r"(?m)^# /// script\s*$", source)
    assert not re.search(r"(?m)^#\s*dependencies\s*=", source)
    assert not (ROOT / "app.py.lock").exists()


def test_the_backend_runs_on_the_launchers_interpreter():
    # The project environment uv prepared for app.py is the one the backend uses.
    assert _load_app()._backend_command(1)[0] == sys.executable


def test_the_app_needs_only_what_the_project_declares():
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    names = {re.split(r"[<>=!~ \[]", d, maxsplit=1)[0].lower() for d in project["dependencies"]}
    assert {"fastapi", "uvicorn"} <= names
    app = _load_app()
    assert set(app.SERVER_MODULES) <= {"fastapi", "uvicorn"}


def test_a_start_outside_the_project_environment_says_how_to_start(monkeypatch, capsys):
    app = _load_app()
    monkeypatch.setattr(sys, "argv", ["app.py"])
    monkeypatch.setattr(app.importlib.util, "find_spec", lambda name: None)
    monkeypatch.setattr(app, "_auto_setup", lambda *a, **k: pytest.fail("must not install without the packages"))
    with pytest.raises(SystemExit) as exc:
        app.main()
    assert exc.value.code == 1
    out = capsys.readouterr().out
    assert "[app] " in out and "uv run app.py" in out and str(ROOT) in out and "Traceback" not in out


def test_the_documented_mcp_registration_bounds_fastmcp():
    """FastMCP is not in uv.lock (it is an overlay with ``--with``); the documented
    commands bound it to the tested release line, as the doctor and setup.py do."""
    sys.path.insert(0, str(ROOT / "scripts"))
    import doctor

    req = doctor.FASTMCP_REQUIREMENT
    for name in ("README.md", "AGENTS.md", "mcp_server.py"):
        text = (ROOT / name).read_text(encoding="utf-8")
        adds = [ln for ln in text.splitlines() if "claude mcp add" in ln and "mcp_server.py" in ln]
        runs = [ln for ln in text.splitlines() if "uv run" in ln and "mcp_server.py" in ln]
        assert runs, f"{name} shows no command that runs mcp_server.py"
        for line in adds + runs:
            assert f'--with "{req}"' in line, f"{name}: {line.strip()}"
    agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    assert f'"--with", "{req}", "mcp_server.py"' in agents  # the JSON client config


def test_the_check_passes_in_the_project_environment():
    assert _load_app()._missing_server_modules() == []
