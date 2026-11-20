"""Fakes for scripts/doctor.py and scripts/setup.py: commands, HTTP, ports and a project tree.

Nothing here runs a real command, opens a socket or reads the user's data.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app_update import frontend_build  # noqa: E402


def load_script(name: str):
    """Import scripts/<name>.py as a module (scripts/ is not a package)."""
    scripts = str(ROOT / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


doctor = load_script("doctor")


FAKE_KEY = "kie-SECRET-abcdefghijklmnopqrstuvwxyz0123456789"
HOME = "/home/ana"
OUT = f"{HOME}/.local/share/blockflow-studio/output"


def catalog(kie=True, piapi=False, leak=False):
    providers = {"kie": {"id": "kie", "name": "Kie", "configured": kie},
                 "piapi": {"id": "piapi", "name": "PiAPI", "configured": piapi}}
    if leak:  # a backend bug that put a key in the reply must still not reach the output
        providers["kie"]["api_key"] = FAKE_KEY
        providers["kie"]["name"] = "Kie"
    return {"providers": providers, "models": [{"id": "seedream-5-pro"}], "modes": []}


def balances(kie="ok", piapi=None):
    out = [{"provider": "kie", "label": "Kie", "configured": kie is not None, "status": kie or "not_configured",
            "amount": 45.0, "unit": "credits"}]
    out.append({"provider": "piapi", "label": "PiAPI", "configured": piapi is not None,
                "status": piapi or "not_configured"})
    return {"ok": True, "balances": out}


class Fake:
    """A healthy machine with the app running; tests change one thing each."""

    def __init__(self, root: Path):
        self.root = root
        self.tools = {"git": "git version 2.45.1", "uv": "uv 0.9.17", "node": "v22.14.0", "npm": "10.9.0",
                      "claude": "2.1.0 (Claude Code)"}
        self.python = "Python 3.12.4"
        self.failing: set[str] = set()   # command keys that exit non-zero
        self.routes = {
            47301: {"/api/providers/catalog": (200, catalog()),
                    "/api/providers/balances": (200, balances()),
                    "/api/settings/output-folder": (200, {"in_use": OUT, "configured_unavailable": False}),
                    "/api/app/version": (200, {"version": "0.2.0", "commit": "abc1234def", "install": "git",
                                               "dirty": False, "update_supported": True,
                                               "launch_mode": "packaged",
                                               "checkout_id": doctor.checkout_id(root)}),
                    "/api/app/update": (200, {"current": "0.2.0", "latest": None, "update_available": False,
                                              "status": "ok", "supported": True})},
            47300: {"/api/providers/catalog": (200, catalog())},
        }
        self.busy_ports: set[int] = set()
        self.writable = {OUT}
        self.calls: list[list[str]] = []
        self.extra_envs: dict[str, dict[str, str]] = {}  # " ".join(cmd) -> the extra environment it ran with
        self.on_build = None  # called when the frontend build runs (a test can make it leave a server)

    def which(self, name):
        return f"/usr/bin/{name}" if name in self.tools else None

    def run(self, cmd, cwd=None, timeout=30.0, extra_env=None):
        self.calls.append(list(cmd))
        if extra_env is not None:
            self.extra_envs[" ".join(cmd)] = dict(extra_env)
        key = " ".join(cmd[:3])
        if key in self.failing or cmd[0] in self.failing or " ".join(cmd) in self.failing:
            return 1, "error"
        if list(cmd) == frontend_build.BUILD_CMD:
            if self.on_build:
                self.on_build()
            else:
                make_build(self.root)
            return 0, "built"
        if cmd[1:] == ["--version"]:
            if cmd[0] == "/py/python3":
                return 0, self.python
            return 0, self.tools[cmd[0]]
        if cmd[:3] == ["uv", "python", "find"]:
            return 0, "/py/python3\n"
        if cmd[:3] == ["claude", "mcp", "get"]:
            return 0, "blockflow-studio:\n  Command: uv\n  Args: run --directory /x --with fastmcp mcp_server.py"
        return 0, ""

    def http_get(self, url, timeout=5.0):
        rest = url.split("127.0.0.1:", 1)[1]
        port, path = int(rest.split("/", 1)[0]), "/" + rest.split("/", 1)[1]
        server = self.routes.get(port)
        if server is None:
            return None, None
        return server.get(path, (404, None))

    def env(self, **environ):
        return doctor.Env(root=self.root, run=self.run, which=self.which, http_get=self.http_get,
                          port_in_use=lambda p: p in self.busy_ports or p in self.routes,
                          writable_dir=lambda p: p in self.writable, environ=environ, home=HOME)


def make_root(tmp_path: Path) -> Path:
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "x"\nrequires-python = ">=3.12"\n')
    (tmp_path / "package.json").write_text(json.dumps({"version": "0.2.0", "engines": {"node": ">=22.14.0"}}))
    fe = tmp_path / "frontend"
    (fe / "node_modules").mkdir(parents=True)
    (fe / "package-lock.json").write_text("{}")
    (fe / "node_modules" / ".package-lock.json").write_text("{}")
    reg = fe / "src" / "components" / "pipeline" / "custom_blocks"
    reg.mkdir(parents=True)
    (reg / "_register.ts").write_text("")
    (fe / "src" / "app").mkdir(parents=True)
    (fe / "src" / "app" / "page.tsx").write_text("page")
    make_build(tmp_path)
    frontend_build.write_stamp(tmp_path, frontend_build.fingerprint(tmp_path, 47301), 47301)
    return tmp_path


_build_count = 0


def make_build(root: Path) -> Path:
    """What `npm run build` leaves: the standalone server with a new BUILD_ID (no stamp)."""
    global _build_count
    _build_count += 1
    server = root / "frontend" / ".next" / "standalone" / "server.js"
    (server.parent / ".next").mkdir(parents=True, exist_ok=True)
    server.write_text("server")
    (server.parent / ".next" / "BUILD_ID").write_text(f"build-{_build_count}")
    return server
