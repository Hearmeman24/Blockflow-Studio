"""The MCP server's status copies must match the backend enums.

``blockflow_mcp`` talks to the backend over HTTP only and does not import
``backend``; it keeps its own tuples. This test is what keeps them in step.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend import mcp_runs  # noqa: E402
from backend.statuses import TERMINAL_JOB_STATUSES, JobStatus  # noqa: E402
from blockflow_mcp import tools_jobs  # noqa: E402


def test_mcp_job_statuses_match_the_backend_in_order():
    assert tools_jobs.STATUSES == tuple(s.value for s in JobStatus)
    assert tools_jobs.TERMINAL == tuple(s.value for s in JobStatus if s in TERMINAL_JOB_STATUSES)


def test_mcp_run_recorded_statuses_match_the_backend_run_recorder():
    assert tools_jobs.RUN_RECORDED == tuple(s.value for s in mcp_runs.RUN_RECORDED_STATUSES)
    assert set(tools_jobs.RUN_RECORDED) == {"COMPLETED", "FAILED", "TIMED_OUT"}


def test_blockflow_mcp_does_not_import_the_backend():
    for path in (ROOT / "blockflow_mcp").glob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert "from backend" not in text and "import backend" not in text, path.name
