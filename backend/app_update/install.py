"""What kind of install this is, and whether it can update itself.

Self-update needs a git checkout whose ``origin`` (as git resolves it,
``insteadOf`` rewrites included) is the configured release repository on
GitHub over https or ssh. The origin URL is never returned: it can carry a
token.
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path
from typing import Any, Callable

from backend.app_update.commands import Runner, run_command

_HTTPS_RE = re.compile(r"^https://(?:[^@/\s]+@)?github\.com/([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", re.I)
_SCP_RE = re.compile(r"^[A-Za-z0-9_.-]+@github\.com:([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", re.I)
_SSH_RE = re.compile(r"^ssh://[A-Za-z0-9_.-]+@github\.com(?::22)?/([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", re.I)
GIT_TIMEOUT_S = 15.0


def checkout_id(root: Path) -> str:
    """A stable identity for this checkout folder that does not reveal its path.

    ``scripts/install_steps.py`` computes the same value, so setup and the app's
    first start can tell whether the app answering on the ports runs from their
    own folder (installing then would delete its frontend packages) or is
    another copy."""
    return hashlib.sha256(str(Path(root).resolve()).encode("utf-8")).hexdigest()[:16]


def origin_matches(url: str, repo: str) -> bool:
    """True when ``url`` is ``repo`` on github.com over https or ssh."""
    if not url or not repo or "/" not in repo:
        return False
    for pattern in (_HTTPS_RE, _SCP_RE, _SSH_RE):
        m = pattern.match(url.strip())
        if m:
            return f"{m.group(1)}/{m.group(2)}".lower() == repo.lower()
    return False


def _git(runner: Runner, root: Path, *args: str, git: str = "git"):
    return runner([git, *args], root, GIT_TIMEOUT_S)


def dirty_files(runner: Runner, root: Path, git: str = "git") -> list[str] | None:
    """Tracked files with changes (staged or not). Untracked and ignored files
    do not count. None when git cannot tell."""
    res = _git(runner, root, "status", "--porcelain=v1", "--untracked-files=no", git=git)
    if not res.ok:
        return None
    return [line[3:].strip() for line in res.output.splitlines() if len(line) > 3]


def detect(root: Path, *, runner: Runner = run_command, which: Callable[[str], str | None],
           repo: str, version: str) -> dict[str, Any]:
    root = Path(root)
    info: dict[str, Any] = {"version": version, "commit": None, "install": "unknown", "branch": None,
                            "dirty": False, "update_supported": False, "repo": repo}

    def unsupported(reason: str) -> dict[str, Any]:
        return {**info, "reason": reason}

    if not (root / ".git").exists():
        if os.environ.get("BLOCKFLOW_PACKAGED") == "1" or "node_modules" in root.parts:
            info["install"] = "package"
            return unsupported("This is a packaged copy without a git folder, so it cannot update itself. "
                               "Download the new release and replace this folder, or clone the repository.")
        return unsupported("This copy is not a git checkout (no .git folder), so it cannot update itself. "
                           "Download the new release and replace this folder, or clone the repository.")
    git = which("git")
    if not git:
        return unsupported("git is not installed or not on PATH, so BlockFlow cannot update itself.")
    top = _git(runner, root, "rev-parse", "--show-toplevel", git=git)
    if not top.ok:
        return unsupported("git does not recognise this folder as a checkout.")
    try:
        same = Path(top.output.strip()).resolve() == root.resolve()
    except OSError:
        same = False
    if not same:
        return unsupported("The app folder is inside another git repository, not its own checkout.")
    info["install"] = "git"
    head = _git(runner, root, "rev-parse", "HEAD", git=git)
    info["commit"] = head.output.strip()[:12] if head.ok else None
    branch = _git(runner, root, "symbolic-ref", "--quiet", "--short", "HEAD", git=git)
    info["branch"] = branch.output.strip() if branch.ok and branch.output.strip() else None
    dirty = dirty_files(runner, root, git=git)
    info["dirty"] = bool(dirty)
    if not repo:
        return unsupported("No release repository is configured (BLOCKFLOW_UPDATE_REPO / update_repo).")
    origin = _git(runner, root, "remote", "get-url", "origin", git=git)
    if not origin.ok or not origin.output.strip():
        return unsupported(f"This checkout has no 'origin' remote. Self-update needs origin to be "
                           f"https://github.com/{repo}.")
    if not origin_matches(origin.output.strip(), repo):
        return unsupported(f"This checkout's 'origin' is not {repo} on GitHub (https or ssh), so the app "
                           "will not update it. Update it yourself with git.")
    info["update_supported"] = True
    return info
