"""End to end: the real update engine against real git repositories, no network.

A bare "origin", a clone holding a minimal app tree, and a new release tag
pushed to origin. Only the dependency steps (uv, npm) and the restart are
faked. The origin is a local path, so the "is this the configured GitHub
repository" check is relaxed for the test (it has its own unit tests).
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from backend.app_update import commands, engine, install
from backend.app_update.commands import Result

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")

REPO = "Hearmeman24/Blockflow-Studio"


def sh(cwd: Path, *args: str) -> str:
    out = subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)
    return out.stdout.strip()


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


@pytest.fixture
def world(tmp_path, monkeypatch):
    # Isolate from the user's git config (signing, hooks, default branch...).
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for k, v in {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
                 "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"}.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setattr(install, "origin_matches", lambda url, repo: url.endswith("origin.git"))

    origin = tmp_path / "origin.git"
    sh(tmp_path, "init", "--bare", "-b", "main", str(origin))
    src = tmp_path / "src"
    sh(tmp_path, "clone", str(origin), str(src))
    write(src / "package.json", json.dumps({"name": "app", "version": "0.1.0"}))
    write(src / "backend" / "app.py", "VERSION = 1\n")
    write(src / "frontend" / "package-lock.json", '{"lock": 1}\n')
    write(src / ".gitignore", "private_blocks/\ndata/\n")
    sh(src, "add", "-A")
    sh(src, "commit", "-m", "v0.1.0")
    sh(src, "tag", "v0.1.0")
    sh(src, "push", "origin", "main", "--tags")

    app = tmp_path / "app"
    sh(tmp_path, "clone", str(origin), str(app))
    (app / "frontend" / "node_modules").mkdir(parents=True)
    write(app / "private_blocks" / "mine" / "backend.block.py", "router = None  # my private block\n")
    write(app / "data" / "run_history.db", "user data")
    write(app / "notes.txt", "untracked notes")

    # The new release: a code change and a lockfile change.
    write(src / "package.json", json.dumps({"name": "app", "version": "0.2.0"}))
    write(src / "backend" / "app.py", "VERSION = 2\n")
    write(src / "frontend" / "package-lock.json", '{"lock": 2}\n')
    sh(src, "commit", "-am", "v0.2.0")
    sh(src, "tag", "-a", "v0.2.0", "-m", "release 0.2.0")
    sh(src, "push", "origin", "main", "--tags")
    return {"tmp": tmp_path, "src": src, "app": app, "origin": origin}


class Runner:
    """Real git; uv and npm are recorded and answer from ``fail``."""

    def __init__(self, fail: dict[str, Result] | None = None):
        self.fail = dict(fail or {})
        self.fake_calls: list[list[str]] = []

    def __call__(self, args, cwd, timeout, env=None):
        name = Path(args[0]).name
        if name in ("uv", "npm"):
            self.fake_calls.append([name, *args[1:]])
            line = " ".join([name, *args[1:]])
            for key in list(self.fail):
                if line.startswith(key):
                    return self.fail.pop(key)
            return Result(0, f"{name} ok")
        return commands.run_command(args, cwd, timeout, env)


def make_engine(world, runner, state="state"):
    def which(name):
        return shutil.which("git") if name == "git" else f"/fake/bin/{name}"

    class NoSupervisor:
        available = False

    return engine.UpdateEngine(
        root=world["app"], state_dir=world["tmp"] / state, runner=runner, which=which, repo=lambda: REPO,
        supervisor=NoSupervisor(), active_jobs=lambda: 0, launch_mode="dev", current_version="0.1.0",
        latest_tag=lambda: "v0.2.0", threaded=False)


def survivors_intact(app: Path) -> None:
    assert (app / "private_blocks" / "mine" / "backend.block.py").read_text() == "router = None  # my private block\n"
    assert (app / "data" / "run_history.db").read_text() == "user data"
    assert (app / "notes.txt").read_text() == "untracked notes"


def test_real_update_fast_forwards_and_keeps_user_files(world):
    app = world["app"]
    old = sh(app, "rev-parse", "HEAD")
    runner = Runner()
    eng = make_engine(world, runner)
    eng.start("v0.2.0")
    p = eng.progress()
    assert p["state"] == "done", p
    assert sh(app, "rev-parse", "HEAD") == sh(world["src"], "rev-parse", "v0.2.0^{commit}")
    assert p["from_commit"] == old
    assert (app / "backend" / "app.py").read_text() == "VERSION = 2\n"
    assert json.loads((app / "package.json").read_text())["version"] == "0.2.0"
    survivors_intact(app)
    assert sh(app, "status", "--porcelain", "--untracked-files=no") == ""
    assert ["uv", "sync", "--frozen"] in runner.fake_calls
    assert ["npm", "--prefix", "frontend", "ci"] in runner.fake_calls  # the lockfile changed
    assert p["restart"]["required"] is True and p["restart"]["automatic"] is False
    assert (world["tmp"] / "state" / "update.log").exists()


def test_real_dirty_tree_is_refused_and_untouched(world):
    app = world["app"]
    old = sh(app, "rev-parse", "HEAD")
    write(app / "backend" / "app.py", "VERSION = 1  # my local edit\n")
    eng = make_engine(world, Runner())
    with pytest.raises(engine.Blocked) as info:
        eng.start("v0.2.0")
    assert [b["code"] for b in info.value.blockers] == ["dirty"]
    assert "backend/app.py" in info.value.blockers[0]["message"]
    assert sh(app, "rev-parse", "HEAD") == old
    assert (app / "backend" / "app.py").read_text() == "VERSION = 1  # my local edit\n"


def test_real_staged_change_is_refused(world):
    app = world["app"]
    write(app / "new_tracked.txt", "x")
    sh(app, "add", "new_tracked.txt")
    with pytest.raises(engine.Blocked):
        make_engine(world, Runner()).start("v0.2.0")


def test_real_failing_step_rolls_back(world):
    app = world["app"]
    old = sh(app, "rev-parse", "HEAD")
    runner = Runner(fail={"npm --prefix frontend ci": Result(1, "npm ERR! network")})
    eng = make_engine(world, runner)
    eng.start("v0.2.0")
    p = eng.progress()
    assert p["state"] == "rolled_back", p
    assert sh(app, "rev-parse", "HEAD") == old
    assert (app / "backend" / "app.py").read_text() == "VERSION = 1\n"
    assert (app / "frontend" / "package-lock.json").read_text() == '{"lock": 1}\n'
    survivors_intact(app)
    assert sh(app, "status", "--porcelain", "--untracked-files=no") == ""
    # Packages were restored for the old version.
    assert runner.fake_calls.count(["uv", "sync", "--frozen"]) == 2


def test_real_local_commits_are_not_fast_forwarded(world):
    app = world["app"]
    write(app / "mine.txt", "my commit")
    sh(app, "add", "mine.txt")
    sh(app, "commit", "-m", "local work")
    mine = sh(app, "rev-parse", "HEAD")
    eng = make_engine(world, Runner())
    eng.start("v0.2.0")
    p = eng.progress()
    assert p["state"] == "failed"
    assert "fast-forward" in p["error"]
    assert sh(app, "rev-parse", "HEAD") == mine


def test_real_moved_tag_on_origin_is_detected(world):
    # A local tag that differs from GitHub's (e.g. a re-tagged release) is refused.
    app = world["app"]
    sh(app, "fetch", "--tags", "origin")
    sh(app, "tag", "-f", "v0.2.0", "HEAD")
    eng = make_engine(world, Runner())
    eng.start("v0.2.0")
    p = eng.progress()
    assert p["state"] == "failed"
    assert "does not match" in p["error"]
