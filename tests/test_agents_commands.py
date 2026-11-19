"""AGENTS.md documents commands that work from a fresh clone.

Two forms looked right and were not: `npm exec tsc -- --noEmit` run from the
repository root prints tsc's help (no tsconfig there), and `uv run --with
fastmcp pytest` runs `.venv/bin/pytest`, which cannot import the `--with`
overlay, so the FastMCP registration test skipped itself.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENTS = (ROOT / "AGENTS.md").read_text(encoding="utf-8")

TSC = "npm --prefix frontend exec -- tsc --noEmit -p frontend"
MCP = "uv run --with fastmcp python -m pytest tests/test_mcp_*.py -q"
BROKEN_TSC = "npm --prefix frontend exec tsc -- --noEmit"
BROKEN_MCP = "uv run --with fastmcp pytest"


def test_agents_documents_the_working_commands():
    assert f"`{TSC}`" in AGENTS
    assert f"`{MCP}`" in AGENTS


def test_agents_has_no_broken_forms():
    assert BROKEN_TSC not in AGENTS
    assert BROKEN_MCP not in AGENTS


def test_mcp_skip_reason_names_the_documented_command():
    source = (ROOT / "tests" / "test_mcp_server.py").read_text(encoding="utf-8")
    reason = re.search(r'importorskip\("fastmcp", reason="run with `([^`]+)`"', source)
    assert reason, "tests/test_mcp_server.py needs a fastmcp skip reason naming the command"
    documented = MCP.removesuffix(" -q")
    assert reason.group(1) == documented
    assert BROKEN_MCP not in source
