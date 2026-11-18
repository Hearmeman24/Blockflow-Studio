"""The repository's identity and agent-facing docs stay consistent.

- One GitHub slug: package.json `repository`, the updater's DEFAULT_REPO and
  every link in the README, AGENTS.md and the issue templates.
- The MCP server is documented under the name it registers with.
- Relative links in the agent-facing docs point at files that exist.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
# Other repositories the docs may link to on purpose.
OTHER_REPOS = {"Hearmeman24/blockflow-prices", "Hearmeman24/BlockFlow"}
SLUG_DOCS = ["README.md", "AGENTS.md", ".github/ISSUE_TEMPLATE/bug_report.yml",
             ".github/ISSUE_TEMPLATE/feature_request.yml", ".github/ISSUE_TEMPLATE/config.yml"]
LINK_DOCS = ["README.md", "AGENTS.md", "frontend/README.md"]


def package_slug() -> str:
    url = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["repository"]["url"]
    match = re.search(r"github\.com/([^/]+/[^/.]+)", url)
    assert match, url
    return match.group(1)


def test_updater_uses_the_package_slug():
    settings = ROOT / "backend" / "app_update" / "settings.py"
    if not settings.exists():
        pytest.skip("the in-app updater is not in this tree")
    match = re.search(r'^DEFAULT_REPO\s*=\s*"([^"]+)"', settings.read_text(encoding="utf-8"), re.M)
    assert match and match.group(1) == package_slug()


@pytest.mark.parametrize("doc", SLUG_DOCS)
def test_github_links_use_one_slug(doc):
    text = (ROOT / doc).read_text(encoding="utf-8")
    slugs = {m.rstrip(".") for m in re.findall(r"github\.com/(Hearmeman24/[A-Za-z0-9_.-]+)", text)}
    slugs = {s[:-4] if s.endswith(".git") else s for s in slugs}
    assert slugs - OTHER_REPOS <= {package_slug()}, doc


def test_mcp_server_is_documented_under_its_registered_name():
    for doc in ("README.md", "AGENTS.md"):
        text = (ROOT / doc).read_text(encoding="utf-8")
        assert "claude mcp add blockflow-studio -- " in text, doc
        assert "claude mcp add blockflow -- " not in text, doc
        assert '"blockflow":' not in text, doc


def test_agents_md_puts_setup_first_and_has_the_three_tiers():
    text = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    headings = re.findall(r"^## (.+)$", text, re.M)
    assert headings[:3] == ["Quick facts", "Set up BlockFlow Studio for a user", "Commands"]
    for tier in ("**Always**", "**Ask first**", "**Never**"):
        assert tier in text
    assert "max_cost_usd" in text and "explicit yes" in text


@pytest.mark.parametrize("doc", LINK_DOCS)
def test_relative_links_resolve(doc):
    path = ROOT / doc
    text = re.sub(r"```.*?```", "", path.read_text(encoding="utf-8"), flags=re.S)
    missing = []
    for target in re.findall(r"\]\(([^)\s]+)\)", text):
        if re.match(r"^[a-z]+:", target) or target.startswith("#"):
            continue
        file_part = target.split("#", 1)[0]
        if file_part and not (path.parent / file_part).exists():
            missing.append(target)
    assert not missing, f"{doc}: {missing}"
