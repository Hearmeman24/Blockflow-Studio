"""The published tree carries no private notes, tracker IDs or pointers into them.

Documentation shipped with the repository is README.md and AGENTS.md only.
Private notes live in the git-ignored ``internal_docs/`` folder, which nothing
tracked may link to or read from; the only allowed mentions are the rule text
in AGENTS.md and the ignore entry in .gitignore.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
THIS = Path(__file__).resolve().relative_to(ROOT).as_posix()

PRIVATE_DOCS = "internal" + "_docs"
OLD_DOCS = "public" + "_docs"
# Issue-tracker IDs and tracker tooling from the private workflow.
TRACKER = re.compile(
    r"sgs-ui-(?:wisp|[0-9a-z]{3}\b)"
    r"|\bwisp\b"
    r"|\bbeads?\b"
    r"|\bbd init\b",
    re.I,
)
PRIVATE_PATH = re.compile(re.escape(PRIVATE_DOCS) + r"/")
# Files allowed to name the private folder: the rule text and the ignore entry.
PRIVATE_PATH_ALLOWED = {"AGENTS.md", ".gitignore"}


def tracked_files() -> list[str]:
    if shutil.which("git") is None or not (ROOT / ".git").exists():
        pytest.skip("git is not available, so the tracked files cannot be listed")
    res = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True)
    if res.returncode != 0:
        pytest.skip("git ls-files failed")
    return [p for p in res.stdout.decode("utf-8", "replace").split("\0") if p]


def tracked_text() -> dict[str, str]:
    out: dict[str, str] = {}
    for rel in tracked_files():
        path = ROOT / rel
        if rel == THIS or not path.is_file():
            continue
        data = path.read_bytes()
        if b"\0" in data[:8192]:
            continue  # binary
        try:
            out[rel] = data.decode("utf-8")
        except UnicodeDecodeError:
            continue
    return out


def test_no_documentation_folders():
    assert not (ROOT / OLD_DOCS).exists(), f"{OLD_DOCS}/ must not exist; private notes go in {PRIVATE_DOCS}/"
    assert not (ROOT / "docs").exists(), "docs/ must not exist"


@pytest.mark.parametrize("doc", ["README.md", "AGENTS.md"])
def test_readme_and_agents_do_not_link_into_doc_folders(doc):
    text = (ROOT / doc).read_text(encoding="utf-8")
    links = re.findall(r"\]\(([^)\s]+)\)", text)
    bad = [t for t in links if OLD_DOCS in t or PRIVATE_DOCS in t]
    assert not bad, f"{doc} links to {bad}"
    assert not re.search(re.escape(OLD_DOCS) + r"/[\w.-]", text), f"{doc} still points into {OLD_DOCS}/"


def test_tracked_files_carry_no_tracker_ids():
    hits = {rel: len(TRACKER.findall(text)) for rel, text in tracked_text().items() if TRACKER.search(text)}
    assert not hits, f"tracker IDs or tooling mentioned in: {hits}"


def test_tracked_files_do_not_point_into_private_notes():
    hits = sorted(rel for rel, text in tracked_text().items()
                  if rel not in PRIVATE_PATH_ALLOWED and PRIVATE_PATH.search(text))
    assert not hits, f"paths into {PRIVATE_DOCS}/ in: {hits}"


# Identifiers from the project's former name. The metadata key `sgs_meta` in
# output files is kept on purpose, so only these exact forms are checked.
OLD_NAME = re.compile(r"SGS_ADVANCED|SGS-UI|sgs-ui-file-picker", re.I)


def test_tracked_files_do_not_use_the_old_project_identifiers():
    hits = sorted(rel for rel, text in tracked_text().items() if OLD_NAME.search(text))
    assert not hits, f"old project identifiers in: {hits}"


def test_no_create_next_app_scaffolding_is_shipped():
    """create-next-app's sample icons are not BlockFlow's and nothing uses them."""
    scaffolding = {"file.svg", "globe.svg", "next.svg", "vercel.svg", "window.svg"}
    assert not {p.name for p in (ROOT / "frontend" / "public").iterdir()} & scaffolding
