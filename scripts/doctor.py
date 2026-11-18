#!/usr/bin/env python3
"""BlockFlow Studio doctor: a read-only health check.

    uv run python scripts/doctor.py            # human-readable
    uv run python scripts/doctor.py --json     # machine-readable (safe to paste in a bug report)
    python3 scripts/doctor.py --expect-running # the app should be up: unreachable is a failure

Every check has a stable ``id``, a ``status`` (ok / warn / fail / skip), a
one-line ``message`` and a one-line ``fix``. The exit code is 1 only when a
check fails.

Standard library only. It never modifies anything, never reads the settings
database and never prints a key: provider state comes from the running app's
``GET /api/providers/catalog``, which reports only whether a key is saved.
Paths under your home folder are shown as ``~``.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
DOCTOR_VERSION = 1
DEFAULT_BACKEND_PORT = 47301
DEFAULT_FRONTEND_PORT = 47300
MCP_SERVER_NAME = "blockflow-studio"
# The in-app updater's routes. Either may be absent in older builds: reported as "skip".
VERSION_ROUTE = "/api/app/version"
UPDATE_ROUTE = "/api/app/update"

OK, WARN, FAIL, SKIP = "ok", "warn", "fail", "skip"

RunResult = Tuple[int, str]
HttpResult = Tuple[Optional[int], Any]


@dataclass
class Check:
    id: str
    status: str
    message: str
    fix: str = ""


# --------------------------------------------------------------------- the environment


def _run(cmd: List[str], cwd: Optional[Path] = None, timeout: float = 30.0) -> RunResult:
    """Run a command; (returncode, combined output). 127 when it cannot start."""
    exe = shutil.which(cmd[0]) or cmd[0]
    try:
        proc = subprocess.run([exe, *cmd[1:]], cwd=str(cwd) if cwd else None, capture_output=True, text=True,
                              timeout=timeout, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return 127, ""
    return proc.returncode, ((proc.stdout or "") + (proc.stderr or "")).strip()


def _http_get(url: str, timeout: float = 5.0) -> HttpResult:
    """GET a local URL; (status, parsed JSON or None). (None, None) when unreachable."""
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - local app only
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, None
    except (urllib.error.URLError, OSError, ValueError):
        return None, None
    try:
        return status, json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return status, None


def _port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def _writable_dir(path: str) -> bool:
    return os.path.isdir(path) and os.access(path, os.W_OK)


@dataclass
class Env:
    """Everything the checks touch, so tests can replace it."""

    root: Path = ROOT
    run: Callable[..., RunResult] = _run
    which: Callable[[str], Optional[str]] = shutil.which
    http_get: Callable[..., HttpResult] = _http_get
    port_in_use: Callable[[int], bool] = _port_in_use
    writable_dir: Callable[[str], bool] = _writable_dir
    environ: Dict[str, str] = field(default_factory=lambda: dict(os.environ))
    home: str = field(default_factory=lambda: str(Path.home()))

    def backend_port(self) -> int:
        return _int(self.environ.get("BACKEND_PORT"), DEFAULT_BACKEND_PORT)

    def frontend_port(self) -> int:
        return _int(self.environ.get("FRONTEND_PORT"), DEFAULT_FRONTEND_PORT)


def _int(value: Optional[str], default: int) -> int:
    try:
        return int(value) if value else default
    except ValueError:
        return default


# --------------------------------------------------------------------- helpers


def parse_version(text: str) -> Optional[Tuple[int, ...]]:
    match = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", text or "")
    if not match:
        return None
    return tuple(int(p) for p in match.groups() if p is not None)


def _fmt(version: Tuple[int, ...]) -> str:
    return ".".join(str(p) for p in version)


def minimum_versions(root: Path) -> Dict[str, Optional[Tuple[int, ...]]]:
    """Minimums from the project files: pyproject requires-python, package.json engines.node."""
    out: Dict[str, Optional[Tuple[int, ...]]] = {"python": None, "node": None}
    try:
        text = (root / "pyproject.toml").read_text(encoding="utf-8")
        match = re.search(r'requires-python\s*=\s*"\s*>=\s*([0-9.]+)', text)
        out["python"] = parse_version(match.group(1)) if match else None
    except OSError:
        pass
    try:
        engines = json.loads((root / "package.json").read_text(encoding="utf-8")).get("engines", {})
        match = re.search(r">=\s*([0-9.]+)", str(engines.get("node", "")))
        out["node"] = parse_version(match.group(1)) if match else None
    except (OSError, ValueError):
        pass
    return out


def app_version(root: Path) -> Optional[str]:
    try:
        version = json.loads((root / "package.json").read_text(encoding="utf-8")).get("version")
    except (OSError, ValueError):
        return None
    return version if isinstance(version, str) else None


def tilde(path: str, home: str) -> str:
    """Show a path under the home folder as ~/..., so reports do not carry the user name."""
    if home and (path == home or path.startswith(home.rstrip("/\\") + os.sep) or path.startswith(home + "/")):
        return "~" + path[len(home):]
    return path


def _is_catalog(body: Any) -> bool:
    return isinstance(body, dict) and isinstance(body.get("providers"), dict) and isinstance(body.get("models"), list)


# --------------------------------------------------------------------- prerequisite checks


def check_tool(env: Env, tool: str, *, required: bool, minimum: Optional[Tuple[int, ...]] = None,
               install: str = "") -> Check:
    if not env.which(tool):
        return Check(tool, FAIL if required else WARN, f"{tool} is not installed or not on PATH.", install)
    code, out = env.run([tool, "--version"])
    version = parse_version(out) if code == 0 else None
    if version is None:
        return Check(tool, FAIL if required else WARN, f"{tool} is on PATH but `{tool} --version` failed.", install)
    if minimum and version < minimum:
        return Check(tool, FAIL, f"{tool} {_fmt(version)} is older than the required {_fmt(minimum)}.", install)
    suffix = f" (needs {_fmt(minimum)} or newer)" if minimum else ""
    return Check(tool, OK, f"{tool} {_fmt(version)}{suffix}.")


def check_python(env: Env, minimum: Optional[Tuple[int, ...]]) -> Check:
    """The interpreter uv will use for this project (found, never downloaded)."""
    floor = minimum or (3, 12)
    fix = f"Install Python {_fmt(floor)} or newer: `uv python install {_fmt(floor)}`."
    if not env.which("uv"):
        return Check("python", SKIP, "Needs uv to find the project's Python.", "Install uv first (see the uv check).")
    code, out = env.run(["uv", "python", "find", f">={_fmt(floor)}"], cwd=env.root)
    path = out.strip().splitlines()[-1].strip() if code == 0 and out.strip() else ""
    if not path:
        return Check("python", FAIL, f"No Python {_fmt(floor)} or newer found by uv.", fix)
    code, out = env.run([path, "--version"])
    version = parse_version(out) if code == 0 else None
    if version is None:
        return Check("python", FAIL, "uv found a Python but it did not run.", fix)
    if version < floor:
        return Check("python", FAIL, f"Python {_fmt(version)} is older than the required {_fmt(floor)}.", fix)
    return Check("python", OK, f"Python {_fmt(version)} (needs {_fmt(floor)} or newer).")


def check_python_deps(env: Env) -> Check:
    fix = "Run `uv sync --extra dev` (or `uv run python scripts/setup.py`)."
    if not env.which("uv"):
        return Check("python_deps", SKIP, "Needs uv.", "Install uv first (see the uv check).")
    code, _ = env.run(["uv", "sync", "--check", "--locked", "--extra", "dev"], cwd=env.root, timeout=120)
    if code == 0:
        return Check("python_deps", OK, "Python dependencies (with dev extras) match uv.lock.")
    return Check("python_deps", WARN, "Python dev dependencies are not installed or out of date. "
                 "The app itself still starts with `uv run app.py`; tests and lint need them.", fix)


def check_frontend_deps(env: Env) -> Check:
    fix = ("Stop the app and start it again with `uv run app.py`, which installs them; or, with the app "
           "stopped, run `npm --prefix frontend ci` (or `uv run python scripts/setup.py`).")
    lock = env.root / "frontend" / "package-lock.json"
    installed = env.root / "frontend" / "node_modules" / ".package-lock.json"
    if not installed.exists():
        return Check("frontend_deps", WARN, "Frontend dependencies are not installed "
                     "(`uv run app.py` installs them when it starts).", fix)
    try:
        stale = lock.exists() and installed.stat().st_mtime < lock.stat().st_mtime
    except OSError:
        stale = False
    if stale:
        return Check("frontend_deps", WARN, "frontend/package-lock.json is newer than the installed packages.", fix)
    return Check("frontend_deps", OK, "Frontend dependencies are installed.")


def check_block_registry(env: Env) -> Check:
    generated = env.root / "frontend" / "src" / "components" / "pipeline" / "custom_blocks" / "_register.ts"
    if generated.exists():
        return Check("block_registry", OK, "The block registry has been generated.")
    return Check("block_registry", WARN, "The block registry has not been generated yet "
                 "(the dev server generates it on start).", "Run `npm --prefix frontend run gen:custom-blocks`.")


def check_mcp(env: Env) -> Check:
    fix = ("Run `uv run --with fastmcp python -c \"import fastmcp\"` once to download FastMCP into uv's cache "
           "(or `uv run python scripts/setup.py`).")
    if not env.which("uv"):
        return Check("mcp_importable", SKIP, "Needs uv.", "Install uv first (see the uv check).")
    code, _ = env.run(["uv", "run", "--offline", "--with", "fastmcp", "python", "-c",
                       "import fastmcp, blockflow_mcp.server"], cwd=env.root, timeout=120)
    if code == 0:
        return Check("mcp_importable", OK, "The MCP server imports with FastMCP (`uv run --with fastmcp`).")
    return Check("mcp_importable", WARN, "FastMCP is not in uv's cache yet, or the MCP package failed to import.",
                 fix)


def check_mcp_registered(env: Env) -> Check:
    """Claude Code only; other clients are not inspected."""
    if not env.which("claude"):
        return Check("mcp_registered", SKIP, "Claude Code CLI not found; other MCP clients are not checked.",
                     "Register the server in your MCP client (see AGENTS.md, step 5).")
    code, out = env.run(["claude", "mcp", "get", MCP_SERVER_NAME], cwd=env.root, timeout=30)
    fix = (f"`claude mcp add {MCP_SERVER_NAME} -- uv run --directory \"{tilde(str(env.root), env.home)}\" "
           "--with fastmcp mcp_server.py` (use the full path).")
    if code != 0:
        return Check("mcp_registered", WARN, f"No MCP server named {MCP_SERVER_NAME} in Claude Code for this folder.",
                     fix)
    if "mcp_server.py" not in out:
        return Check("mcp_registered", WARN, f"{MCP_SERVER_NAME} is registered but does not run mcp_server.py.", fix)
    return Check("mcp_registered", OK, f"Claude Code has an MCP server named {MCP_SERVER_NAME}.")


# --------------------------------------------------------------------- running-app checks


def check_ports_and_reachability(env: Env, expect_running: bool) -> Tuple[List[Check], bool]:
    """Port checks plus backend and frontend reachability. Returns (checks, backend_up)."""
    checks: List[Check] = []
    bport, fport = env.backend_port(), env.frontend_port()
    down = FAIL if expect_running else WARN

    status, body = env.http_get(f"http://127.0.0.1:{bport}/api/providers/catalog")
    backend_up = status == 200 and _is_catalog(body)
    if backend_up:
        checks.append(Check("backend_port", OK, f"Port {bport} is serving this app's backend."))
        checks.append(Check("backend", OK, f"Backend answers at http://127.0.0.1:{bport}."))
    elif env.port_in_use(bport):
        checks.append(Check("backend_port", FAIL, f"Port {bport} is in use by another program.",
                            "Stop that program, or start this app with another port: BACKEND_PORT=<port> "
                            "uv run app.py (and set BLOCKFLOW_URL for the MCP server)."))
        checks.append(Check("backend", down, "The BlockFlow Studio backend is not reachable.", "See backend_port."))
    else:
        checks.append(Check("backend_port", OK, f"Port {bport} is free."))
        checks.append(Check("backend", down, "The app is not running.", "Start it from the repository root: "
                            "`uv run app.py`."))

    fstatus, fbody = env.http_get(f"http://127.0.0.1:{fport}/api/providers/catalog")
    frontend_up = fstatus == 200 and _is_catalog(fbody)
    if frontend_up:
        checks.append(Check("frontend_port", OK, f"Port {fport} is serving this app's frontend."))
        checks.append(Check("frontend", OK, f"Frontend answers at http://localhost:{fport}."))
    elif env.port_in_use(fport):
        if backend_up:
            # Next.js answers on the port but its /api proxy failed: still compiling, or another app.
            checks.append(Check("frontend_port", WARN, f"Port {fport} answers but not as this app's frontend "
                                "(it may still be starting).", "Wait a few seconds and run the doctor again."))
        else:
            checks.append(Check("frontend_port", FAIL, f"Port {fport} is in use by another program.",
                                "Stop that program, or start this app with FRONTEND_PORT=<port> uv run app.py."))
        checks.append(Check("frontend", down, "The BlockFlow Studio frontend is not reachable.",
                            "See frontend_port."))
    else:
        checks.append(Check("frontend_port", OK, f"Port {fport} is free."))
        checks.append(Check("frontend", down, "The frontend is not running.", "Start the app: `uv run app.py`."))
    return checks, backend_up


def check_providers(env: Env) -> Check:
    _, body = env.http_get(f"http://127.0.0.1:{env.backend_port()}/api/providers/catalog")
    providers = body.get("providers") if isinstance(body, dict) else None
    if not isinstance(providers, dict):
        return Check("providers", WARN, "Could not read the provider catalog.", "Restart the app and try again.")
    # Only the provider name and the configured flag are read; nothing else from the reply is printed.
    configured = sorted(str(p.get("name") or pid) for pid, p in providers.items()
                        if isinstance(p, dict) and p.get("configured") is True)
    if not configured:
        return Check("providers", WARN, "No provider key is saved.",
                     f"The user enters a Kie or PiAPI key in the app: http://localhost:{env.frontend_port()} "
                     "-> Settings -> API keys (never in chat or a file).")
    return Check("providers", OK, f"Key saved for: {', '.join(configured)}.")


def check_balances(env: Env) -> Check:
    status, body = env.http_get(f"http://127.0.0.1:{env.backend_port()}/api/providers/balances", timeout=20)
    entries = body.get("balances") if isinstance(body, dict) else None
    if status != 200 or not isinstance(entries, list):
        return Check("balances", WARN, "Could not read provider balances.",
                     "Check your network connection, then Settings -> API keys -> Check key.")
    configured = [e for e in entries if isinstance(e, dict) and e.get("configured") is True]
    if not configured:
        return Check("balances", SKIP, "No provider key is saved.", "See the providers check.")
    bad = [str(e.get("label") or e.get("provider")) for e in configured if e.get("status") not in ("ok", "unavailable")]
    good = [str(e.get("label") or e.get("provider")) for e in configured if e.get("status") in ("ok", "unavailable")]
    if bad:
        return Check("balances", WARN, f"Balance not reachable for: {', '.join(bad)}.",
                     "The key may be wrong or the provider unreachable: Settings -> API keys -> Check key.")
    return Check("balances", OK, f"Balance reachable for: {', '.join(good)}.")


def check_output_folder(env: Env) -> Check:
    _, body = env.http_get(f"http://127.0.0.1:{env.backend_port()}/api/settings/output-folder")
    in_use = body.get("in_use") if isinstance(body, dict) else None
    if not isinstance(in_use, str) or not in_use:
        return Check("output_folder", WARN, "Could not read the output folder.", "Open Settings -> App.")
    shown = tilde(in_use, env.home)
    if body.get("configured_unavailable"):
        return Check("output_folder", WARN, f"The chosen output folder is missing; using {shown}.",
                     "Reconnect the drive or choose another folder in Settings -> App.")
    if not env.writable_dir(in_use):
        return Check("output_folder", FAIL, f"The output folder {shown} is not writable.",
                     "Choose another folder in Settings -> App, or fix its permissions.")
    return Check("output_folder", OK, f"Output folder {shown} is writable.")


def check_version(env: Env, backend_up: bool) -> Check:
    local = app_version(env.root) or "unknown"
    if not backend_up:
        return Check("version", SKIP, f"BlockFlow Studio {local} in this folder; the update check needs the app "
                     "running.", "Start it: `uv run app.py`.")
    base = f"http://127.0.0.1:{env.backend_port()}"
    status, info = env.http_get(base + VERSION_ROUTE, timeout=10)
    version, details = local, []
    if status == 200 and isinstance(info, dict):
        version = str(info.get("version") or local)
        if isinstance(info.get("install"), str):
            details.append(f"{info['install']} install")
        if isinstance(info.get("commit"), str) and info["commit"]:
            details.append(f"commit {info['commit'][:7]}")
    label = f"BlockFlow Studio {version}" + (f" ({', '.join(details)})" if details else "")

    status, update = env.http_get(base + UPDATE_ROUTE, timeout=10)
    if status != 200 or not isinstance(update, dict):
        return Check("version", SKIP, f"{label} (this app has no update check).", "")
    latest = update.get("latest")
    latest_version = latest.get("version") if isinstance(latest, dict) else None
    if update.get("update_available") is True:
        return Check("version", WARN, f"{label}; {latest_version or 'a newer version'} is available.",
                     "Install it from the app (Settings -> App), or by hand as AGENTS.md "
                     "describes under Releases and updates.")
    check_status = update.get("status")
    if check_status not in (None, "ok"):
        return Check("version", OK, f"{label}; update check: {check_status}.")
    return Check("version", OK, f"{label}, up to date.")


# --------------------------------------------------------------------- run


def run_checks(env: Optional[Env] = None, *, expect_running: bool = False) -> List[Check]:
    env = env or Env()
    mins = minimum_versions(env.root)
    checks = [
        check_tool(env, "git", required=False, install="Install git: https://git-scm.com/downloads"),
        check_tool(env, "uv", required=True, install="Install uv: https://docs.astral.sh/uv/getting-started/installation/"),
        check_python(env, mins["python"]),
        check_tool(env, "node", required=True, minimum=mins["node"],
                   install=f"Install Node.js {_fmt(mins['node']) if mins['node'] else '22'} or newer: "
                           "https://nodejs.org/"),
        check_tool(env, "npm", required=True, install="npm ships with Node.js: https://nodejs.org/"),
        check_python_deps(env),
        check_frontend_deps(env),
        check_block_registry(env),
        check_mcp(env),
        check_mcp_registered(env),
    ]
    running, backend_up = check_ports_and_reachability(env, expect_running)
    checks.extend(running)
    if backend_up:
        checks.extend([check_providers(env), check_balances(env), check_output_folder(env)])
    else:
        for cid in ("providers", "balances", "output_folder"):
            checks.append(Check(cid, SKIP, "Needs the app running.", "Start it: `uv run app.py`."))
    checks.append(check_version(env, backend_up))
    return checks


def summarize(checks: List[Check]) -> Dict[str, int]:
    return {s: sum(1 for c in checks if c.status == s) for s in (OK, WARN, FAIL, SKIP)}


def report(checks: List[Check]) -> Dict[str, Any]:
    counts = summarize(checks)
    return {
        "doctor_version": DOCTOR_VERSION,
        "ok": counts[FAIL] == 0,
        "summary": counts,
        "platform": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
        "checks": [asdict(c) for c in checks],
    }


def render_text(checks: List[Check]) -> str:
    lines = ["BlockFlow Studio doctor", ""]
    width = max(len(c.id) for c in checks)
    for c in checks:
        lines.append(f"[{c.status:<4}] {c.id:<{width}}  {c.message}")
        if c.status in (WARN, FAIL) and c.fix:
            lines.append(f"       {'':<{width}}  fix: {c.fix}")
    counts = summarize(checks)
    lines += ["", f"{counts[OK]} ok, {counts[WARN]} warn, {counts[FAIL]} fail, {counts[SKIP]} skip"]
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None, env: Optional[Env] = None, out: Callable[[str], None] = print) -> int:
    parser = argparse.ArgumentParser(description="Read-only health check for BlockFlow Studio.")
    parser.add_argument("--json", action="store_true", help="print a JSON report (contains no keys)")
    parser.add_argument("--expect-running", action="store_true",
                        help="treat an app that is not running as a failure")
    args = parser.parse_args(argv)
    checks = run_checks(env, expect_running=args.expect_running)
    out(json.dumps(report(checks), indent=2) if args.json else render_text(checks))
    return 1 if any(c.status == FAIL for c in checks) else 0


if __name__ == "__main__":
    sys.exit(main())
