"""Install steps shared by ``scripts/setup.py`` and ``app.py``. Standard library only.

``scripts/setup.py`` runs the full install (Python dev dependencies included)
for contributors and repairs. ``app.py`` runs only the frontend steps a fresh
clone is missing (``first_start_plan``), so ``uv run app.py`` is enough to
start; it never runs ``uv sync``, because uv has already prepared the
environment it runs in. A normal start (not ``--dev``) also builds the
production web interface when its build is missing or stale
(``backend/app_update/frontend_build.py`` says when), so the build runs only
after an install, an update or a change to the frontend or a block.

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
from typing import Callable, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

import doctor  # noqa: E402
from doctor import frontend_build  # noqa: E402  (standard library only, like this module)

UV_SYNC = ["uv", "sync", "--extra", "dev"]
NPM_CI = ["npm", "--prefix", "frontend", "ci"]
CODEGEN = ["npm", "--prefix", "frontend", "run", "gen:custom-blocks"]
FASTMCP = ["uv", "run", "--with", "fastmcp", "python", "-c", "import fastmcp"]
BUILD = frontend_build.BUILD_CMD
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
    BUILD_MISSING = "build_missing"                      # no production build of the web interface yet
    BUILD_STALE = "build_stale"                          # the sources, a block, the packages or the port changed
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


BUILD_WHEN = "only after an install, an update or a block change"
BUILD_MESSAGES = {
    StepReason.BUILD_MISSING: f"Building the web interface, this takes a minute or two ({BUILD_WHEN})...",
    StepReason.BUILD_STALE: f"The app, a block or the backend port changed: rebuilding the web interface, about a minute "
                            f"({BUILD_WHEN})...",
}


def build_reason(env: doctor.Env, *, reinstalled: bool = False) -> Optional[StepReason]:
    """Why the production build must run, or None when it is current. After
    ``npm ci`` it always runs: the installed packages are one of its inputs."""
    state = frontend_build.build_state(env.root, env.backend_port())
    if state is frontend_build.BuildState.MISSING:
        return StepReason.BUILD_MISSING
    if state is frontend_build.BuildState.STALE or reinstalled:
        return StepReason.BUILD_STALE
    return None


def build_step(env: doctor.Env, *, reinstalled: bool = False) -> Optional[Step]:
    reason = build_reason(env, reinstalled=reinstalled)
    return Step("frontend_build", BUILD, BUILD_MESSAGES[reason], reason) if reason else None


def first_start_plan(env: doctor.Env, *, build: bool = False) -> List[Step]:
    """The frontend steps a start needs: packages and block registry from two
    files' timestamps and, with ``build`` (every start but ``--dev``), the
    production build from its stamp (a hash of a few MB of sources, tens of
    milliseconds). No command, no network."""
    steps: List[Step] = []
    deps = _frontend_reason(env)
    if deps:
        steps.append(Step("frontend_deps", NPM_CI,
                          "First start: installing the frontend packages, this can take a few minutes...", deps))
    if deps:
        steps.append(Step("block_registry", CODEGEN, "Registering the blocks...", StepReason.FRONTEND_INSTALLED))
    elif doctor.check_block_registry(env).status != doctor.OK:
        steps.append(Step("block_registry", CODEGEN, "Registering the blocks...", StepReason.REGISTRY_MISSING))
    if build:
        step = build_step(env, reinstalled=deps is not None)
        if step:
            steps.append(step)
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
        Step("frontend_build", BUILD, "", build_reason(env, reinstalled=_frontend_reason(env) is not None)),
    ]


def run_step(env: doctor.Env, step: Step) -> Tuple[int, str]:
    """Run one step: the build through ``build_frontend``, the others as they are."""
    if step.cmd == BUILD:
        return build_frontend(env)
    return env.run(step.cmd, cwd=env.root, timeout=INSTALL_TIMEOUT_S)


def build_frontend(env: doctor.Env) -> Tuple[int, str]:
    """``npm run build`` with the backend port fixed, then the stamp that
    marks the build current. The fingerprint is taken before the build, so
    an edit made while it runs reads as stale next time. (exit code, output)."""
    port = env.backend_port()
    fp = frontend_build.fingerprint(env.root, port)
    with frontend_build.building(env.root):
        code, output = env.run(BUILD, cwd=env.root, timeout=frontend_build.BUILD_TIMEOUT_S,
                               extra_env=frontend_build.build_env({}, port))
    if code == 0 and not frontend_build.write_stamp(env.root, fp, port):
        return 1, (output + "\nThe build finished but left no standalone server "
                   "(frontend/.next/standalone/server.js).").strip()
    return code, output


def build_failed_lines(code: int, output: str, prefix: str = "") -> List[str]:
    """What to print when the production build fails: the end of its output,
    then the ways forward."""
    lines = [f"{prefix}`{' '.join(BUILD)}` failed (exit {code})."]
    if output:
        lines.append(tail(output, 25))
    lines.append(f"{prefix}The web interface could not be built. If you added or changed a block, the error above "
                 "names it (custom_blocks/generated/<slug>.tsx and generated_private/<slug>.tsx are copies of "
                 "<slug>/frontend.block.tsx): fix that file, or move the block out of private_blocks/, then start "
                 "again. A build also needs the internet (it downloads the fonts).")
    lines.append(f"{prefix}`uv run app.py --dev` starts the development server instead, which shows build errors "
                 "in the page; `uv run python scripts/setup.py` repairs the install.")
    return lines


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
