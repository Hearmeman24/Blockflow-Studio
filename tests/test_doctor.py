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
           "frontend_build", "mcp_importable", "mcp_registered", "backend_port", "backend", "frontend_port", "frontend",
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


def _edit_a_page(root):
    page = root / "frontend" / "src" / "app" / "page.tsx"
    page.write_text(page.read_text() + " edited")


def test_frontend_build_says_the_production_build_is_served(fake):
    got = by_id(doctor.run_checks(fake.env()))["frontend_build"]
    assert got.status == "ok" and "serving the production build" in got.message


def test_frontend_build_in_development_mode_is_not_used(fake, root):
    fake.routes[47301]["/api/app/version"][1]["launch_mode"] = "dev"
    _edit_a_page(root)  # a stale build does not matter to the development server
    got = by_id(doctor.run_checks(fake.env()))["frontend_build"]
    assert got.status == "ok" and "development server" in got.message and "--dev" in got.message


def test_frontend_build_ignores_the_mode_of_an_app_from_another_folder(fake, root):
    fake.routes[47301]["/api/app/version"][1]["launch_mode"] = "dev"
    fake.routes[47301]["/api/app/version"][1]["checkout_id"] = "f" * 16
    _edit_a_page(root)
    got = by_id(doctor.run_checks(fake.env()))["frontend_build"]
    assert got.status == "warn" and "development server" not in got.message and "serving" not in got.message


def test_frontend_build_stale_while_served_says_restart(fake, root):
    _edit_a_page(root)
    got = by_id(doctor.run_checks(fake.env()))["frontend_build"]
    assert got.status == "warn" and "older than" in got.message
    assert "uv run app.py" in got.fix and "rebuilds" in got.fix


def test_frontend_build_missing_while_the_app_is_down(fake, root):
    fake.routes.clear()
    import shutil
    shutil.rmtree(root / "frontend" / ".next")
    got = by_id(doctor.run_checks(fake.env()))["frontend_build"]
    assert got.status == "warn" and "not been built" in got.message and "uv run app.py" in got.fix


def test_frontend_build_for_another_backend_port_is_stale(fake):
    fake.routes = {48001: fake.routes[47301], 48000: fake.routes[47300]}
    got = by_id(doctor.run_checks(fake.env(BACKEND_PORT="48001", FRONTEND_PORT="48000")))["frontend_build"]
    assert got.status == "warn"


def test_a_build_in_progress_is_not_a_failure(fake, root):
    fake.routes.clear()
    with doctor.frontend_build.building(root):
        got = by_id(doctor.run_checks(fake.env(), expect_running=True))
    assert got["frontend_build"].status == "warn" and "being built" in got["frontend_build"].message
    assert got["frontend"].status == "warn" and "being built" in got["frontend"].message
    assert "Ready at" in got["frontend"].fix


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
    assert data["ok"] is True and data["summary"] == {"ok": 19, "warn": 0, "fail": 0, "skip": 0}
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
    assert text.count("fix:") == 1 and "18 ok, 1 warn, 0 fail, 0 skip" in text


def test_doctor_never_runs_a_state_changing_command(fake):
    doctor.run_checks(fake.env())
    for cmd in fake.calls:
        joined = " ".join(cmd)
        assert cmd[1:] == ["--version"] or "--check" in cmd or "--offline" in cmd or cmd[:3] in (
            ["uv", "python", "find"], ["claude", "mcp", "get"]), joined


def test_statuses_and_check_ids_are_declared_once():
    assert doctor.STATUSES == ("ok", "warn", "fail", "skip")
    assert doctor.CHECK_IDS == tuple(ALL_IDS)
    with pytest.raises(ValueError):
        doctor.Check("backend", "broken", "x")
    with pytest.raises(ValueError):
        doctor.Check("not_a_check", "ok", "x")
    assert list(doctor.summarize([])) == list(doctor.STATUSES)


def test_scripts_import_with_the_standard_library_only():
    import subprocess

    code = ("import sys; sys.path.insert(0, sys.argv[1]); import doctor, install_steps, setup; "
            "print(len(doctor.CHECK_IDS))")
    proc = subprocess.run([sys.executable, "-I", "-S", "-c", code, str(ROOT / "scripts")],
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == str(len(ALL_IDS))


@pytest.mark.parametrize("name,check", [("BACKEND_PORT", "backend_port"), ("FRONTEND_PORT", "frontend_port")])
@pytest.mark.parametrize("raw", ["abc", "0", "70000", "-5"])
def test_a_bad_port_setting_fails_that_port_check_instead_of_checking_the_default(fake, name, check, raw):
    got = by_id(doctor.run_checks(fake.env(**{name: raw})))
    assert got[check].status == "fail"
    assert name in got[check].message and repr(raw) in got[check].message
    assert "1 to 65535" in got[check].fix
    reach = check.replace("_port", "")
    assert got[reach].status != "ok" and "See " + check in got[reach].fix


@pytest.mark.parametrize("raw", ["", "  "])
def test_an_empty_port_setting_means_the_default(fake, raw):
    got = by_id(doctor.run_checks(fake.env(BACKEND_PORT=raw)))
    assert got["backend_port"].status == "ok" and "47301" in got["backend_port"].message


def test_parse_port_is_the_one_rule():
    assert doctor.port_setting({}, "BACKEND_PORT", 47301) == (47301, None)
    assert doctor.port_setting({"BACKEND_PORT": "48001"}, "BACKEND_PORT", 47301) == (48001, None)
    port, problem = doctor.port_setting({"BACKEND_PORT": "x" * 200}, "BACKEND_PORT", 47301)
    assert port == 47301 and "BACKEND_PORT" in problem and len(problem) < 300


def test_busy_backend_port_says_which_case(fake, root):
    sys.path.insert(0, str(ROOT / "scripts"))
    mine = doctor.checkout_id(root)
    # This app's own backend answers, but the catalog fails (500 or still starting).
    fake.routes[47301] = {"/api/providers/catalog": (500, None),
                          "/api/app/version": (200, {"checkout_id": mine})}
    got = by_id(doctor.run_checks(fake.env()))["backend_port"]
    assert got.status == "fail"
    assert "this app's backend" in got.message and "another program" not in got.message
    assert "terminal" in got.fix
    # Another copy of BlockFlow (another folder).
    fake.routes[47301]["/api/app/version"] = (200, {"checkout_id": "f" * 16})
    got = by_id(doctor.run_checks(fake.env()))["backend_port"]
    assert got.status == "fail" and "another copy of BlockFlow Studio" in got.message
    assert "BACKEND_PORT" in got.fix
    # Something answers HTTP but says nothing about itself.
    fake.routes[47301] = {"/api/providers/catalog": (500, None)}
    got = by_id(doctor.run_checks(fake.env()))["backend_port"]
    assert got.status == "fail" and "HTTP 500" in got.message and "another program" in got.message
    assert "terminal" in got.fix and "BACKEND_PORT" in got.fix


def test_frontend_deps_fix_says_which_case(root, fake):
    import os

    lock = root / "frontend" / "package-lock.json"
    installed = root / "frontend" / "node_modules" / ".package-lock.json"
    os.utime(installed, (1_000_000, 1_000_000))
    stale = by_id(doctor.run_checks(fake.env()))["frontend_deps"]
    assert stale.status == "warn" and "newer" in stale.message
    assert "changed" in stale.fix and "reinstalls" in stale.fix
    installed.unlink()
    missing = by_id(doctor.run_checks(fake.env()))["frontend_deps"]
    assert missing.status == "warn" and "not installed" in missing.message
    assert "changed" not in missing.fix and "installs them" in missing.fix
    assert lock.exists()


def test_tilde():
    assert doctor.tilde("/home/ana/x/y", "/home/ana") == "~/x/y"
    assert doctor.tilde("/home/anabel/x", "/home/ana") == "/home/anabel/x"
    assert doctor.tilde("/srv/out", "/home/ana") == "/srv/out"
