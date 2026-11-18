#!/usr/bin/env python3
"""BlockFlow Studio setup: install what the app and its tests need, idempotently.

    uv run python scripts/setup.py           # install what is missing
    uv run python scripts/setup.py --check   # only report what would run

Steps, each skipped when already satisfied:
  1. prerequisites (git optional; uv, Python, Node.js and npm at the project's minimums)
  2. `uv sync --extra dev`               Python dependencies, incl. pytest and ruff
  3. `npm --prefix frontend ci`          frontend dependencies (refused while this checkout's app is running)
  4. `npm --prefix frontend run gen:custom-blocks`   block registry (always; cheap and repeatable)
  5. `uv run --with fastmcp python -c "import fastmcp"`   FastMCP into uv's cache for the MCP server

`uv run app.py` installs the frontend steps itself on start; this script is
the full install and repair command (it adds the Python dev dependencies for
tests and lint). The shared step logic is in ``scripts/install_steps.py``.

It never starts the app or the MCP server, never asks for or reads an API key,
and never touches the user data or output folders. Standard library only.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Callable, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import doctor  # noqa: E402
import install_steps  # noqa: E402
from install_steps import CODEGEN, FASTMCP, INSTALL_TIMEOUT_S, NPM_CI, UV_SYNC  # noqa: E402


def next_steps(env: doctor.Env) -> List[str]:
    port = env.frontend_port()
    return [
        "Next:",
        "  1. Start the app (keep it running):  uv run app.py",
        f"     then open http://localhost:{port}",
        "  2. Enter a Kie and/or PiAPI key in the app's Welcome dialog or Settings -> API keys.",
        "     Keys are typed into the app only, never into a terminal, a chat or a file.",
        "  3. Register the MCP server with Claude Code (other clients: see AGENTS.md, step 5):",
        f'     claude mcp add blockflow-studio -- uv run --directory "{env.root}" --with fastmcp mcp_server.py',
        "  4. Check everything:  uv run python scripts/doctor.py --expect-running",
    ]


def main(argv: Optional[List[str]] = None, env: Optional[doctor.Env] = None,
         out: Callable[[str], None] = print) -> int:
    parser = argparse.ArgumentParser(description="Install what BlockFlow Studio needs (idempotent).")
    parser.add_argument("--check", action="store_true", help="only report what would run; change nothing")
    args = parser.parse_args(argv)
    env = env or doctor.Env()
    mins = doctor.minimum_versions(env.root)

    out("BlockFlow Studio setup" + (" (check only)" if args.check else ""))
    prereqs = [
        doctor.check_tool(env, "git", required=False, install="Install git: https://git-scm.com/downloads"),
        doctor.check_tool(env, "uv", required=True,
                          install="Install uv: https://docs.astral.sh/uv/getting-started/installation/"),
        doctor.check_python(env, mins["python"]),
        *install_steps.node_prereqs(env),
    ]
    for check in prereqs:
        out(f"[{check.status:<4}] {check.id}: {check.message}" + (f"  fix: {check.fix}" if check.status != "ok"
                                                                  and check.fix else ""))
    if any(c.status == doctor.FAIL for c in prereqs):
        out("Install the missing prerequisites above, then run this again. Nothing was changed.")
        return 1

    steps = [
        ("python_deps", UV_SYNC, doctor.check_python_deps(env).status != doctor.OK),
        ("frontend_deps", NPM_CI, doctor.check_frontend_deps(env).status != doctor.OK),
        ("block_registry", CODEGEN, True),
        ("mcp_cache", FASTMCP, doctor.check_mcp(env).status != doctor.OK),
    ]
    for step_id, cmd, needed in steps:
        shown = " ".join(cmd)
        if not needed:
            out(f"[ok  ] {step_id}: already done")
            continue
        if args.check:
            out(f"[todo] {step_id}: would run `{shown}`")
            continue
        if cmd is NPM_CI and install_steps.this_checkout_running(env):
            out(f"[fail] {step_id}: the app is running from this folder, and `{shown}` would delete the "
                "frontend packages it uses. "
                "Stop the app (Ctrl+C in its terminal), then run this again.")
            return 1
        out(f"[run ] {step_id}: {shown}")
        code, output = env.run(cmd, cwd=env.root, timeout=INSTALL_TIMEOUT_S)
        if code != 0:
            if cmd is NPM_CI:
                install_steps.forget_frontend_install(env.root)
            out(f"[fail] {step_id}: {shown} failed (exit {code}).\n{install_steps.tail(output)}")
            return 1
        out(f"[ok  ] {step_id}: done")

    out("")
    out("\n".join(next_steps(env)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
