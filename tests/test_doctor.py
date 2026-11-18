"""scripts/doctor.py: every check against fake commands, a fake HTTP layer and fake ports.

Nothing here runs a real command, opens a socket or reads the user's data.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from doctor_fakes import FAKE_KEY, HOME, OUT, ROOT, Fake, balances, catalog, doctor, make_root  # noqa: E402


@pytest.fixture
def root(tmp_path):
    return make_root(tmp_path)


@pytest.fixture
def fake(root):
    return Fake(root)


def by_id(checks):
    return {c.id: c for c in checks}


ALL_IDS = ["git", "uv", "python", "node", "npm", "python_deps", "frontend_deps", "block_registry",
           "mcp_importable", "mcp_registered", "backend_port", "backend", "frontend_port", "frontend",
           "providers", "balances", "output_folder", "version"]


def test_everything_fine(fake):
    checks = doctor.run_checks(fake.env())
    assert [c.id for c in checks] == ALL_IDS
    assert {c.id: c.status for c in checks if c.status != "ok"} == {}
    got = by_id(checks)
    assert got["providers"].message == "Key saved for: Kie."
    assert got["balances"].message == "Balance reachable for: Kie."
    assert got["output_folder"].message == "Output folder ~/.local/share/blockflow-studio/output is writable."
    assert got["version"].message == "BlockFlow Studio 0.2.0 (git install, commit abc1234), up to date."
    assert got["python"].message == "Python 3.12.4 (needs 3.12 or newer)."


def test_exit_code_is_zero_on_warnings_and_one_on_failure(fake):
    lines: list[str] = []
    fake.routes[47301]["/api/providers/catalog"] = (200, catalog(kie=False))
    assert doctor.main([], fake.env(), lines.append) == 0
    assert "[warn] providers" in lines[0]
    fake.tools.pop("uv")
    assert doctor.main([], fake.env(), lines.append) == 1


def test_missing_and_too_old_prerequisites(fake):
    fake.tools.pop("node")
    fake.tools["git"] = "nope"
    fake.python = "Python 3.11.9"
    got = by_id(doctor.run_checks(fake.env()))
    assert got["node"].status == "fail" and "not installed" in got["node"].message
    assert "nodejs.org" in got["node"].fix and "22.14.0" in got["node"].fix
    assert got["git"].status == "warn"  # optional: the app runs without git
    assert got["python"].status == "fail" and "3.11.9 is older than the required 3.12" in got["python"].message

    fake.tools["node"] = "v20.11.1"
    got = by_id(doctor.run_checks(fake.env()))
    assert got["node"].status == "fail"
    assert got["node"].message == "node 20.11.1 is older than the required 22.14.0."


def test_minimums_come_from_the_project_files(root, fake):
    (root / "package.json").write_text(json.dumps({"engines": {"node": ">=24.1.0"}}))
    got = by_id(doctor.run_checks(fake.env()))
    assert got["node"].status == "fail" and "24.1.0" in got["node"].message
    assert doctor.minimum_versions(ROOT)["python"] == (3, 12)


def test_no_uv_skips_what_needs_it(fake):
    fake.tools.pop("uv")
    got = by_id(doctor.run_checks(fake.env()))
    assert got["uv"].status == "fail" and "astral.sh" in got["uv"].fix
    assert got["python"].status == got["python_deps"].status == got["mcp_importable"].status == "skip"


def test_dependencies_not_installed(root, fake):
    (root / "frontend" / "node_modules" / ".package-lock.json").unlink()
    (root / "frontend" / "src" / "components" / "pipeline" / "custom_blocks" / "_register.ts").unlink()
    fake.failing |= {"uv sync --check", "uv run --offline"}
    got = by_id(doctor.run_checks(fake.env()))
    assert got["frontend_deps"].status == "warn" and "npm --prefix frontend ci" in got["frontend_deps"].fix
    assert got["python_deps"].status == "warn" and "uv sync --extra dev" in got["python_deps"].fix
    assert got["block_registry"].status == "warn" and "gen:custom-blocks" in got["block_registry"].fix
    assert got["mcp_importable"].status == "warn" and "--with fastmcp" in got["mcp_importable"].fix


def test_mcp_registration(fake):
    fake.failing.add("claude mcp get")
    got = by_id(doctor.run_checks(fake.env()))
    assert got["mcp_registered"].status == "warn"
    assert "claude mcp add blockflow-studio -- uv run --directory" in got["mcp_registered"].fix
    fake.tools.pop("claude")
    assert by_id(doctor.run_checks(fake.env()))["mcp_registered"].status == "skip"


def test_backend_down(fake):
    fake.routes.clear()
    got = by_id(doctor.run_checks(fake.env()))
    assert got["backend_port"].status == "ok" and "free" in got["backend_port"].message
    assert got["backend"].status == "warn" and "uv run app.py" in got["backend"].fix
    assert got["frontend"].status == "warn"
    assert got["providers"].status == got["balances"].status == got["output_folder"].status == "skip"
    # With --expect-running the same state is a failure.
    got = by_id(doctor.run_checks(fake.env(), expect_running=True))
    assert got["backend"].status == "fail" and got["frontend"].status == "fail"


def test_ports_busy_with_another_program(fake):
    fake.routes.clear()
    fake.busy_ports |= {47301, 47300}
    got = by_id(doctor.run_checks(fake.env()))
    assert got["backend_port"].status == "fail" and "another program" in got["backend_port"].message
    assert "BACKEND_PORT" in got["backend_port"].fix and "BLOCKFLOW_URL" in got["backend_port"].fix
    assert got["frontend_port"].status == "fail" and "FRONTEND_PORT" in got["frontend_port"].fix


def test_custom_ports_from_the_environment(fake):
    fake.routes = {48001: fake.routes[47301], 48000: fake.routes[47300]}
    got = by_id(doctor.run_checks(fake.env(BACKEND_PORT="48001", FRONTEND_PORT="48000")))
    assert got["backend"].status == "ok" and "48001" in got["backend"].message
    assert got["frontend"].status == "ok"


def test_frontend_still_starting(fake):
    fake.routes[47300] = {}
    got = by_id(doctor.run_checks(fake.env()))
    assert got["frontend_port"].status == "warn" and "starting" in got["frontend_port"].message


def test_no_provider_configured(fake):
    fake.routes[47301]["/api/providers/catalog"] = (200, catalog(kie=False, piapi=False))
    fake.routes[47301]["/api/providers/balances"] = (200, balances(kie=None))
    got = by_id(doctor.run_checks(fake.env()))
    assert got["providers"].status == "warn"
    assert "Settings -> API keys" in got["providers"].fix and "never in chat" in got["providers"].fix
    assert got["balances"].status == "skip"


def test_balance_errors_and_unreachable(fake):
    fake.routes[47301]["/api/providers/catalog"] = (200, catalog(kie=True, piapi=True))
    fake.routes[47301]["/api/providers/balances"] = (200, balances(kie="ok", piapi="error"))
    got = by_id(doctor.run_checks(fake.env()))
    assert got["balances"].status == "warn" and got["balances"].message == "Balance not reachable for: PiAPI."
    fake.routes[47301]["/api/providers/balances"] = (None, None)
    assert by_id(doctor.run_checks(fake.env()))["balances"].status == "warn"


def test_output_folder_problems(fake):
    fake.writable.clear()
    got = by_id(doctor.run_checks(fake.env()))
    assert got["output_folder"].status == "fail" and "not writable" in got["output_folder"].message
    fake.routes[47301]["/api/settings/output-folder"] = (200, {"in_use": OUT, "configured_unavailable": True})
    assert by_id(doctor.run_checks(fake.env()))["output_folder"].status == "warn"


@pytest.mark.parametrize("update,status,text", [
    ({"current": "0.2.0", "latest": {"version": "0.4.0", "tag": "v0.4.0"}, "update_available": True}, "warn",
     "0.4.0 is available"),
    ({"current": "0.2.0", "latest": {"version": "0.2.0"}, "update_available": False}, "ok", "up to date"),
    ({"current": "0.2.0", "latest": None, "update_available": False, "status": "offline"}, "ok",
     "update check: offline"),
])
def test_update_status_from_the_app(fake, update, status, text):
    fake.routes[47301]["/api/app/update"] = (200, update)
    got = by_id(doctor.run_checks(fake.env()))["version"]
    assert got.status == status and text in got.message
    if status == "warn":
        assert "AGENTS.md" in got.fix


def test_update_routes_absent_is_skip(fake):
    del fake.routes[47301]["/api/app/update"]
    del fake.routes[47301]["/api/app/version"]
    got = by_id(doctor.run_checks(fake.env()))["version"]
    assert got.status == "skip" and got.message == "BlockFlow Studio 0.2.0 (this app has no update check)."
    # Version route present, update route absent: still skip, but with the running version.
    fake.routes[47301]["/api/app/version"] = (200, {"version": "0.2.1", "commit": None, "install": "zip"})
    got = by_id(doctor.run_checks(fake.env()))["version"]
    assert got.status == "skip" and "0.2.1 (zip install)" in got.message


def test_version_skipped_while_the_app_is_down(fake):
    fake.routes.clear()
    got = by_id(doctor.run_checks(fake.env()))["version"]
    assert got.status == "skip" and "0.2.0" in got.message


def test_json_shape_and_no_secrets(fake, capsys):
    fake.routes[47301]["/api/providers/catalog"] = (200, catalog(leak=True))
    fake.routes[47300]["/api/providers/catalog"] = (200, catalog(leak=True))
    lines: list[str] = []
    assert doctor.main(["--json"], fake.env(), lines.append) == 0
    text = lines[0]
    data = json.loads(text)
    assert set(data) == {"doctor_version", "ok", "summary", "platform", "checks"}
    assert data["ok"] is True and data["summary"] == {"ok": 18, "warn": 0, "fail": 0, "skip": 0}
    for check in data["checks"]:
        assert set(check) == {"id", "status", "message", "fix"}
        assert check["status"] in {"ok", "warn", "fail", "skip"}
        assert "\n" not in check["message"] and "\n" not in check["fix"]
    assert [c["id"] for c in data["checks"]] == ALL_IDS
    assert FAKE_KEY not in text and "SECRET" not in text and "api_key" not in text
    assert HOME not in text  # paths under the home folder are shown as ~


def test_human_output_lists_fixes_only_for_problems(fake):
    fake.routes[47301]["/api/providers/catalog"] = (200, catalog(kie=False))
    lines: list[str] = []
    doctor.main([], fake.env(), lines.append)
    text = lines[0]
    assert text.count("fix:") == 1 and "17 ok, 1 warn, 0 fail, 0 skip" in text


def test_doctor_never_runs_a_state_changing_command(fake):
    doctor.run_checks(fake.env())
    for cmd in fake.calls:
        joined = " ".join(cmd)
        assert cmd[1:] == ["--version"] or "--check" in cmd or "--offline" in cmd or cmd[:3] in (
            ["uv", "python", "find"], ["claude", "mcp", "get"]), joined


def test_tilde():
    assert doctor.tilde("/home/ana/x/y", "/home/ana") == "~/x/y"
    assert doctor.tilde("/home/anabel/x", "/home/ana") == "/home/anabel/x"
    assert doctor.tilde("/srv/out", "/home/ana") == "/srv/out"
