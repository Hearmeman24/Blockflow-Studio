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

import sys
from dataclasses import dataclass
from enum import Enum
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


checkout_id = doctor.checkout_id  # also used by the doctor's port checks


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


class StepReason(Enum):
    """Why an install step runs. Not printed; the plan and its tests read it."""

    NOT_INSTALLED = "not_installed"                      # no frontend packages (or an install was cut short)
    LOCKFILE_CHANGED = "lockfile_changed"                # frontend/package-lock.json is newer than the install
    FRONTEND_INSTALLED = "frontend_installed"            # the codegen after a fresh frontend install
    REGISTRY_MISSING = "registry_missing"                # the generated block registry is not there
    PYTHON_DEPS_OUT_OF_DATE = "python_deps_out_of_date"  # uv.lock (with dev extras) is not installed
    FASTMCP_NOT_CACHED = "fastmcp_not_cached"            # FastMCP is not in uv's cache, or does not import
    ALWAYS = "always"                                    # cheap and repeatable (setup.py's codegen)


class FastMCP(Enum):
    """What ``ensure_fastmcp`` did."""

    ALREADY_PRESENT = "already_present"
    DOWNLOADED = "downloaded"
    FAILED = "failed"


@dataclass
class Step:
    id: str
    cmd: List[str]
    message: str
    reason: Optional[StepReason] = None  # None: not needed (setup_plan lists done steps too)


_FRONTEND_REASONS = {doctor.FRONTEND_MISSING: StepReason.NOT_INSTALLED,
                     doctor.FRONTEND_STALE: StepReason.LOCKFILE_CHANGED}


def _frontend_reason(env: doctor.Env) -> Optional[StepReason]:
    return _FRONTEND_REASONS.get(doctor.frontend_deps_state(env))


def first_start_plan(env: doctor.Env) -> List[Step]:
    """The frontend steps a start needs. Reads two files' timestamps only: no
    command, no network, so an installed checkout starts as fast as before."""
    steps: List[Step] = []
    deps = _frontend_reason(env)
    if deps:
        steps.append(Step("frontend_deps", NPM_CI,
                          "First start: installing the frontend packages, this can take a few minutes...", deps))
    if deps:
        steps.append(Step("block_registry", CODEGEN, "Registering the blocks...", StepReason.FRONTEND_INSTALLED))
    elif doctor.check_block_registry(env).status != doctor.OK:
        steps.append(Step("block_registry", CODEGEN, "Registering the blocks...", StepReason.REGISTRY_MISSING))
    return steps


def setup_plan(env: doctor.Env) -> List[Step]:
    """``scripts/setup.py``'s steps in order, each with the reason it runs, or
    ``reason=None`` when it is already done. Runs the doctor's read-only checks."""
    return [
        Step("python_deps", UV_SYNC, "",
             StepReason.PYTHON_DEPS_OUT_OF_DATE if doctor.check_python_deps(env).status != doctor.OK else None),
        Step("frontend_deps", NPM_CI, "", _frontend_reason(env)),
        Step("block_registry", CODEGEN, "", StepReason.ALWAYS),
        Step("mcp_cache", FASTMCP, "",
             StepReason.FASTMCP_NOT_CACHED if doctor.check_mcp(env).status != doctor.OK else None),
    ]


def forget_frontend_install(root: Path) -> None:
    """After a failed or interrupted ``npm ci``: make sure the next start
    sees the frontend packages as missing and installs them again."""
    try:
        (Path(root) / "frontend" / "node_modules" / ".package-lock.json").unlink(missing_ok=True)
    except OSError:
        pass


def tail(output: str, lines: int = 15) -> str:
    return "\n".join(output.splitlines()[-lines:])


def ensure_fastmcp(env: doctor.Env, out: Callable[[str], None], prefix: str = "") -> FastMCP:
    """Download FastMCP into uv's cache when it is not there. A failed
    download is reported through ``out`` and never stops the caller."""
    if doctor.check_mcp(env).status == doctor.OK:
        return FastMCP.ALREADY_PRESENT
    code, _ = env.run(FASTMCP, cwd=env.root, timeout=INSTALL_TIMEOUT_S)
    if code != 0:
        out(f"{prefix}Could not download FastMCP for the MCP server; the app works without it. "
            f"Retry later with `{' '.join(FASTMCP)}`.")
        return FastMCP.FAILED
    return FastMCP.DOWNLOADED
