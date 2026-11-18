"""AGENTS.md lists where every state machine is declared, and the list is true.

The `## State machines` section holds a `| Machine | Where | States |` table.
Each backticked path in its Where column is a file that exists, and no file is
listed twice.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HEADING = "## State machines"
PATH = re.compile(r"`([^`\s]+)`")


def section() -> str:
    text = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    match = re.search(rf"^{re.escape(HEADING)}\n(.*?)(?=^## )", text, re.S | re.M)
    assert match, f"AGENTS.md has no '{HEADING}' section"
    return match.group(1)


def listed_paths() -> list[str]:
    rows = [line for line in section().splitlines() if line.startswith("|")]
    assert rows and [c.strip() for c in rows[0].strip("|").split("|")][:3] == ["Machine", "Where", "States"], \
        "the section needs a | Machine | Where | States | table"
    paths: list[str] = []
    for row in rows[2:]:
        cells = [c.strip() for c in row.strip().strip("|").split("|")]
        assert len(cells) == 3, row
        found = PATH.findall(cells[1])
        assert found, f"no path in the Where column of: {row}"
        paths.extend(found)
    return paths


def test_section_exists_and_lists_machines():
    assert listed_paths()


def test_every_listed_path_exists():
    missing = [p for p in listed_paths() if not (ROOT / p).is_file()]
    assert not missing, f"listed in AGENTS.md but not in the repository: {missing}"


def test_every_path_is_listed_once():
    paths = listed_paths()
    dupes = sorted({p for p in paths if paths.count(p) > 1})
    assert not dupes, f"listed more than once: {dupes}"
