"""Install steps shared by ``scripts/setup.py`` and ``app.py``. Standard library only.

``scripts/setup.py`` runs the full install (Python dev dependencies included)
for contributors and repairs. ``app.py`` runs only the frontend steps a fresh
clone is missing (``first_start_plan``), so ``uv run app.py`` is enough to
start; it never runs ``uv sync``, because uv has already prepared the
environment it runs in.

Both refuse ``npm ci`` only while THIS checkout is running (its frontend
packages would be deleted under it). Another copy on the same ports does not
count: the backend reports a ``checkout_id`` (a hash of its folder, never the
folder itself) at ``/api/app/version``, and ``checkout_id`` here computes the
same value for the local folder.
"""

from __future__ import annotations

import hashlib
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import doctor  # noqa: E402

UV_SYNC = ["uv", "sync", "--extra", "dev"]
NPM_CI = ["npm", "--prefix", "frontend", "ci"]
CODEGEN = ["npm", "--prefix", "frontend", "run", "gen:custom-blocks"]
FASTMCP = ["uv", "run", "--with", "fastmcp", "python", "-c", "import fastmcp"]
INSTALL_TIMEOUT_S = 1800

NODE_INSTALL = "Install Node.js from https://nodejs.org/"
NPM_INSTALL = "npm ships with Node.js: https://nodejs.org/"


def checkout_id(root: Path) -> str:
    """A stable identity for a checkout folder that does not reveal its path.
    Keep in step with ``backend/app_update/install.py:checkout_id``."""
    return hashlib.sha256(str(Path(root).resolve()).encode("utf-8")).hexdigest()[:16]


def this_checkout_running(env: doctor.Env) -> bool:
    """True when the app answering on the configured ports runs from this folder.

    A running app that reports a ``checkout_id`` is compared with ours. An app
    that answers but reports none (an older build) is assumed to be this one,
    as before, because deleting its packages would break it.
    """
    mine = checkout_id(env.root)
    seen_other = False
    for port in (env.frontend_port(), env.backend_port()):
        status, body = env.http_get(f"http://127.0.0.1:{port}{doctor.VERSION_ROUTE}")
        if status == 200 and isinstance(body, dict) and isinstance(body.get("checkout_id"), str):
            if body["checkout_id"] == mine:
                return True
            seen_other = True
    if seen_other:
        return False
    status, body = env.http_get(f"http://127.0.0.1:{env.frontend_port()}/api/providers/catalog")
    return status == 200 and isinstance(body, dict) and "providers" in body


def node_prereqs(env: doctor.Env) -> List[doctor.Check]:
    mins = doctor.minimum_versions(env.root)
    return [
        doctor.check_tool(env, "node", required=True, minimum=mins["node"], install=NODE_INSTALL),
        doctor.check_tool(env, "npm", required=True, install=NPM_INSTALL),
    ]


@dataclass
class Step:
    id: str
    cmd: List[str]
    message: str


def first_start_plan(env: doctor.Env) -> List[Step]:
    """The frontend steps a start needs. Reads two files' timestamps only: no
    command, no network, so an installed checkout starts as fast as before."""
    steps: List[Step] = []
    deps = doctor.check_frontend_deps(env).status != doctor.OK
    if deps:
        steps.append(Step("frontend_deps", NPM_CI,
                          "First start: installing the frontend packages, this can take a few minutes..."))
    if deps or doctor.check_block_registry(env).status != doctor.OK:
        steps.append(Step("block_registry", CODEGEN, "Registering the blocks..."))
    return steps


def forget_frontend_install(root: Path) -> None:
    """After a failed or interrupted ``npm ci``: make sure the next start
    sees the frontend packages as missing and installs them again."""
    try:
        (Path(root) / "frontend" / "node_modules" / ".package-lock.json").unlink(missing_ok=True)
    except OSError:
        pass


def tail(output: str, lines: int = 15) -> str:
    return "\n".join(output.splitlines()[-lines:])


def ensure_fastmcp(env: doctor.Env, out: Callable[[str], None], prefix: str = "") -> Optional[bool]:
    """Download FastMCP into uv's cache when it is not there. None when it
    was already there; otherwise whether the download worked."""
    if doctor.check_mcp(env).status == doctor.OK:
        return None
    code, _ = env.run(FASTMCP, cwd=env.root, timeout=INSTALL_TIMEOUT_S)
    if code != 0:
        out(f"{prefix}Could not download FastMCP for the MCP server; the app works without it. "
            f"Retry later with `{' '.join(FASTMCP)}`.")
        return False
    return True
