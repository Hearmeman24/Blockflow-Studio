"""Self-update engine with a fake command runner (backend/app_update/engine.py).

The real git mechanics are covered end to end in test_app_update_git_e2e.py.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.app_update import commands, engine, install
from backend.app_update.commands import Result

REPO = "Hearmeman24/Blockflow-Studio"
OLD = "a" * 40
NEW = "b" * 40


class FakeGit:
    """Answers commands from a table; records every call. ``fail`` maps a
    command prefix to a failing Result, returned once. HEAD moves on merge /
    reset --keep."""

    def __init__(self, *, origin=f"https://github.com/{REPO}.git", dirty="", ancestor=True, changed=(),
                 tag_commit=NEW, remote_commit=NEW, fail=None, toplevel=None):
        self.head = OLD
        self.origin = origin
        self.dirty = dirty
        self.ancestor = ancestor
        self.changed = list(changed)
        self.tag_commit = tag_commit
        self.remote_commit = remote_commit
        self.fail = dict(fail or {})
        self.toplevel = toplevel
        self.calls: list[list[str]] = []

    @staticmethod
    def line(args):
        return " ".join([Path(args[0]).name, *args[1:]])

    def __call__(self, args, cwd, timeout, env=None):
        assert isinstance(args, list) and all(isinstance(a, str) for a in args)
        self.calls.append(list(args))
        for key in list(self.fail):
            if self.line(args).startswith(key):
                return self.fail.pop(key)  # each failure happens once
        tool, rest = Path(args[0]).name, args[1:]
        if tool == "git":
            return self.git(rest, cwd)
        return Result(0, f"{tool} ok")

    def git(self, rest, cwd):
        if rest[:1] == ["rev-parse"]:
            if "--show-toplevel" in rest:
                return Result(0, str(self.toplevel or cwd))
            if rest[-1] == "HEAD":
                return Result(0, self.head)
            if rest[-1].startswith("refs/tags/"):
                return Result(0, self.tag_commit) if self.tag_commit else Result(1, "")
        if rest[:2] == ["symbolic-ref", "--quiet"]:
            return Result(0, "main")
        if rest[:3] == ["remote", "get-url", "origin"]:
            return Result(0, self.origin) if self.origin else Result(2, "error: No such remote 'origin'")
        if rest[:1] == ["status"]:
            return Result(0, self.dirty)
        if rest[:1] == ["fetch"]:
            return Result(0, "")
        if rest[:1] == ["ls-remote"]:
            tag = next(r for r in rest if r.startswith("refs/tags/") and not r.endswith("^{}"))
            return Result(0, f"{'c' * 40}\t{tag}\n{self.remote_commit}\t{tag}^{{}}\n") if self.remote_commit else Result(0, "")
        if rest[:2] == ["merge-base", "--is-ancestor"]:
            return Result(0 if self.ancestor else 1, "")
        if rest[:1] == ["diff"]:
            return Result(0, "\n".join(self.changed))
        if rest[:2] == ["merge", "--ff-only"]:
            self.head = rest[-1]
            return Result(0, "Fast-forward")
        if rest[:2] == ["reset", "--keep"]:
            self.head = rest[-1]
            return Result(0, "")
        return Result(0, "")


class FakeSupervisor:
    def __init__(self, available=True, pause_ok=True):
        self.available = available
        self.pause_ok = pause_ok
        self.requests: list[str] = []

    def pause_frontend(self, timeout=20.0):
        self.requests.append("pause")
        return self.pause_ok

    def resume_frontend(self):
        self.requests.append("resume")

    def restart(self):
        self.requests.append("restart")


def make(tmp_path, runner, *, supervisor=None, active=0, launch_mode="dev", version="0.1.15", latest="v0.2.0"):
    root = tmp_path / "app"
    (root / ".git").mkdir(parents=True, exist_ok=True)
    (root / "frontend" / "node_modules").mkdir(parents=True, exist_ok=True)
    return engine.UpdateEngine(
        root=root, state_dir=tmp_path / "state", runner=runner, which=lambda name: f"/usr/bin/{name}",
        repo=lambda: REPO, supervisor=supervisor or FakeSupervisor(), active_jobs=lambda: active,
        launch_mode=launch_mode, current_version=version, latest_tag=lambda: latest, threaded=False,
    )


def git_calls(fake):
    return [c[1:] for c in fake.calls if Path(c[0]).name == "git"]


def tool_calls(fake, tool):
    return [c[1:] for c in fake.calls if Path(c[0]).name == tool]


# ------------------------------------------------------------------ install info


def test_install_info_for_a_matching_git_checkout(tmp_path):
    (tmp_path / ".git").mkdir()
    fake = FakeGit()
    info = install.detect(tmp_path, runner=fake, which=lambda n: f"/usr/bin/{n}", repo=REPO, version="0.1.15")
    assert info["install"] == "git"
    assert info["update_supported"] is True
    assert info["branch"] == "main"
    assert info["commit"] == OLD[:12]
    assert info["dirty"] is False


@pytest.mark.parametrize("origin,ok", [
    (f"https://github.com/{REPO}.git", True), (f"https://github.com/{REPO}", True),
    (f"https://github.com/{REPO.lower()}/", True), (f"git@github.com:{REPO}.git", True),
    (f"ssh://git@github.com/{REPO}.git", True), (f"https://x-access-token:SECRET@github.com/{REPO}.git", True),
    (f"http://github.com/{REPO}.git", False), (f"git://github.com/{REPO}.git", False),
    (f"https://github.com/{REPO}-evil.git", False), (f"https://gitlab.com/{REPO}.git", False),
    ("/some/local/path", False), (f"https://github.com.evil.example/{REPO}.git", False),
    (f"git@github.com/{REPO}.git", False), (f"file:///github.com/{REPO}", False),
])
def test_origin_must_be_the_configured_repository_over_https_or_ssh(origin, ok):
    assert install.origin_matches(origin, REPO) is ok


def test_wrong_remote_is_not_supported_and_never_echoes_credentials(tmp_path):
    (tmp_path / ".git").mkdir()
    fake = FakeGit(origin="https://user:hunter2@github.com/someone/else.git")
    info = install.detect(tmp_path, runner=fake, which=lambda n: f"/usr/bin/{n}", repo=REPO, version="0.1.15")
    assert info["install"] == "git"
    assert info["update_supported"] is False
    assert REPO in info["reason"]
    assert "hunter2" not in json.dumps(info)


def test_no_git_folder_is_a_package_or_unknown_install(tmp_path, monkeypatch):
    monkeypatch.setenv("BLOCKFLOW_PACKAGED", "1")
    info = install.detect(tmp_path, runner=FakeGit(), which=lambda n: f"/usr/bin/{n}", repo=REPO, version="0.1.15")
    assert info["install"] == "package"
    assert info["update_supported"] is False
    # BlockFlow Studio is not distributed through npm: point to a release or a clone instead.
    assert "npm" not in info["reason"] and "clone the repository" in info["reason"]
    monkeypatch.delenv("BLOCKFLOW_PACKAGED")
    info = install.detect(tmp_path, runner=FakeGit(), which=lambda n: f"/usr/bin/{n}", repo=REPO, version="0.1.15")
    assert info["install"] == "unknown"


def test_checkout_inside_another_repository_is_not_supported(tmp_path):
    (tmp_path / ".git").mkdir()
    fake = FakeGit(toplevel="/somewhere/else")
    info = install.detect(tmp_path, runner=fake, which=lambda n: f"/usr/bin/{n}", repo=REPO, version="0.1.15")
    assert info["update_supported"] is False


# ------------------------------------------------------------------ preconditions


def test_dirty_tree_is_refused_with_the_files_named(tmp_path):
    fake = FakeGit(dirty=" M backend/main.py\nM  app.py\n")
    eng = make(tmp_path, fake)
    blockers = eng.preflight("v0.2.0", allow_active_jobs=False)
    dirty = [b for b in blockers if b["code"] == "dirty"]
    assert dirty and "backend/main.py" in dirty[0]["message"] and "app.py" in dirty[0]["message"]
    with pytest.raises(engine.Blocked):
        eng.start("v0.2.0")
    assert not any(c[:1] in (["fetch"], ["merge"]) for c in git_calls(fake))


def test_untracked_files_do_not_count_as_dirty(tmp_path):
    fake = FakeGit()
    eng = make(tmp_path, fake)
    assert eng.preflight("v0.2.0", allow_active_jobs=False) == []
    status = [c for c in git_calls(fake) if c[:1] == ["status"]][0]
    assert "--untracked-files=no" in status


def test_wrong_remote_blocks(tmp_path):
    eng = make(tmp_path, FakeGit(origin="https://github.com/someone/fork.git"))
    assert [b["code"] for b in eng.preflight("v0.2.0", allow_active_jobs=False)] == ["not_supported"]


@pytest.mark.parametrize("missing", ["git", "uv", "npm"])
def test_missing_tool_blocks(tmp_path, missing):
    eng = make(tmp_path, FakeGit())
    eng.which = lambda name: None if name == missing else f"/usr/bin/{name}"
    blockers = eng.preflight("v0.2.0", allow_active_jobs=False)
    assert any(b["code"] == "missing_tools" and missing in b["message"] for b in blockers)


def test_active_jobs_block_unless_confirmed(tmp_path):
    eng = make(tmp_path, FakeGit(), active=2)
    blockers = eng.preflight("v0.2.0", allow_active_jobs=False)
    assert [b["code"] for b in blockers] == ["active_jobs"]
    assert "2" in blockers[0]["message"]
    assert eng.preflight("v0.2.0", allow_active_jobs=True) == []


@pytest.mark.parametrize("tag", ["v0.1.0", "v0.3.0", "--upload-pack=evil", "main", "v0.2.0;rm -rf /", ""])
def test_only_the_latest_known_release_tag_is_accepted(tmp_path, tag):
    eng = make(tmp_path, FakeGit())
    assert [b["code"] for b in eng.preflight(tag, allow_active_jobs=False)] == ["bad_tag"]


def test_a_running_update_refuses_a_second_one(tmp_path):
    eng = make(tmp_path, FakeGit())
    eng._progress["state"] = "running"
    with pytest.raises(engine.Busy):
        eng.start("v0.2.0")


# ------------------------------------------------------------------ the happy path


def test_full_sequence_supervised_dev_mode(tmp_path):
    fake = FakeGit(changed=["backend/main.py", "frontend/package-lock.json"])
    sup = FakeSupervisor()
    eng = make(tmp_path, fake, supervisor=sup)
    eng.start("v0.2.0")
    p = eng.progress()
    assert p["state"] == "restarting"
    assert p["from_commit"] == OLD and p["to_commit"] == NEW
    g = git_calls(fake)
    fetch = [c for c in g if c[:1] == ["fetch"]][0]
    assert fetch == ["fetch", "--tags", "--no-recurse-submodules", "origin"]
    assert ["merge-base", "--is-ancestor", OLD, NEW] in g
    assert ["merge", "--ff-only", NEW] in g
    assert not any(c[:1] == ["reset"] for c in g)
    assert not any(c[:1] == ["checkout"] or c[:1] == ["clean"] for c in g)
    assert tool_calls(fake, "uv") == [["sync", "--frozen"]]
    npm = tool_calls(fake, "npm")
    assert ["--prefix", "frontend", "ci"] in npm
    assert ["--prefix", "frontend", "run", "gen:custom-blocks"] in npm
    assert not any("build" in c for c in npm)
    assert sup.requests == ["pause", "restart"]
    status = {s["id"]: s["status"] for s in p["steps"]}
    assert status["build"] == "skipped" and status["frontend_deps"] == "done" and status["restart"] == "running"
    # Order: fetch, verify, pause, merge, deps, codegen, restart.
    order = [i for i, c in enumerate(fake.calls) if c[1:2] in (["fetch"], ["merge"]) or Path(c[0]).name == "uv"]
    assert order == sorted(order)


def test_npm_ci_is_skipped_when_the_lockfile_did_not_change(tmp_path):
    fake = FakeGit(changed=["backend/main.py"])
    eng = make(tmp_path, fake)
    eng.start("v0.2.0")
    assert ["--prefix", "frontend", "ci"] not in tool_calls(fake, "npm")
    assert {s["id"]: s["status"] for s in eng.progress()["steps"]}["frontend_deps"] == "skipped"


def test_packaged_mode_rebuilds_the_frontend(tmp_path):
    fake = FakeGit(changed=["frontend/src/x.tsx"])
    eng = make(tmp_path, fake, launch_mode="packaged")
    eng.start("v0.2.0")
    assert ["--prefix", "frontend", "run", "build"] in tool_calls(fake, "npm")
    assert eng.progress()["restart"]["command"] == "uv run app.py --packaged"


def test_unsupervised_finishes_and_asks_for_a_manual_restart(tmp_path):
    fake = FakeGit()
    sup = FakeSupervisor(available=False)
    eng = make(tmp_path, fake, supervisor=sup, launch_mode="unknown")
    eng.start("v0.2.0")
    p = eng.progress()
    assert p["state"] == "done"
    assert p["restart"] == {"automatic": False, "required": True, "command": "uv run app.py"}
    assert sup.requests == []


def test_launcher_change_means_a_manual_restart_without_pausing(tmp_path):
    fake = FakeGit(changed=["app.py"])
    sup = FakeSupervisor()
    eng = make(tmp_path, fake, supervisor=sup)
    eng.start("v0.2.0")
    p = eng.progress()
    assert p["state"] == "done"
    assert p["restart"]["required"] is True and p["restart"]["automatic"] is False
    assert sup.requests == []


# ------------------------------------------------------------------ failures


def test_non_fast_forward_stops_before_changing_anything(tmp_path):
    fake = FakeGit(ancestor=False)
    sup = FakeSupervisor()
    eng = make(tmp_path, fake, supervisor=sup)
    eng.start("v0.2.0")
    p = eng.progress()
    assert p["state"] == "failed"
    assert "fast-forward" in p["error"]
    assert not any(c[:1] == ["merge"] for c in git_calls(fake))
    assert sup.requests == []


def test_tag_that_differs_from_the_remote_is_refused(tmp_path):
    fake = FakeGit(remote_commit="d" * 40)
    eng = make(tmp_path, fake)
    eng.start("v0.2.0")
    p = eng.progress()
    assert p["state"] == "failed"
    assert "does not match" in p["error"]
    assert not any(c[:1] == ["merge"] for c in git_calls(fake))


def test_fetch_failure_changes_nothing(tmp_path):
    fake = FakeGit(fail={"git fetch": Result(128, "fatal: unable to access 'https://tok:SECRET123@github.com/x'")})
    eng = make(tmp_path, fake)
    eng.start("v0.2.0")
    p = eng.progress()
    assert p["state"] == "failed"
    assert "SECRET123" not in json.dumps(p)
    assert "SECRET123" not in (tmp_path / "state" / "update.log").read_text()


@pytest.mark.parametrize("failing", ["git merge", "uv sync", "npm --prefix frontend ci",
                                     "npm --prefix frontend run gen:custom-blocks"])
def test_a_failure_after_fetch_rolls_back(tmp_path, failing):
    fake = FakeGit(changed=["frontend/package-lock.json"])
    key = {"git merge": "git merge --ff-only"}.get(failing, failing)
    fake.fail[key] = Result(1, "boom")
    sup = FakeSupervisor()
    eng = make(tmp_path, fake, supervisor=sup)
    eng.start("v0.2.0")
    p = eng.progress()
    assert fake.head == OLD
    if failing == "git merge":
        assert not any(c[:1] == ["reset"] for c in git_calls(fake))
    else:
        assert ["reset", "--keep", OLD] in git_calls(fake)
    assert p["state"] == "rolled_back"
    assert "boom" in "\n".join(p["log_tail"]) or "boom" in p["error"]
    assert sup.requests == ["pause", "resume"]
    assert any("git" in m for m in p["manual"])
    assert {s["id"]: s["status"] for s in p["steps"]}["rollback"] == "done"


def test_packaged_build_failure_rolls_back_and_rebuilds(tmp_path):
    fake = FakeGit(fail={"npm --prefix frontend run build": Result(1, "build broke")})
    eng = make(tmp_path, fake, launch_mode="packaged")
    eng.start("v0.2.0")
    assert eng.progress()["state"] == "rolled_back"
    assert ["reset", "--keep", OLD] in git_calls(fake)


def test_a_failed_rollback_says_exactly_what_to_do(tmp_path):
    fake = FakeGit(fail={"uv sync": Result(1, "boom"), "git reset": Result(1, "error: Entry 'x' not uptodate")})
    sup = FakeSupervisor()
    eng = make(tmp_path, fake, supervisor=sup)
    eng.start("v0.2.0")
    p = eng.progress()
    assert p["state"] == "failed"
    assert "half" in p["error"].lower() or "could not be undone" in p["error"].lower()
    assert f"git reset --keep {OLD}" in p["manual"]
    assert sup.requests[-1] == "resume"


def test_pause_timeout_fails_without_merging(tmp_path):
    fake = FakeGit()
    sup = FakeSupervisor(pause_ok=False)
    eng = make(tmp_path, fake, supervisor=sup)
    eng.start("v0.2.0")
    assert eng.progress()["state"] == "failed"
    assert not any(c[:1] == ["merge"] for c in git_calls(fake))
    assert sup.requests == ["pause", "resume"]


def test_already_on_the_release_is_done_without_restart(tmp_path):
    fake = FakeGit(tag_commit=OLD, remote_commit=OLD)
    sup = FakeSupervisor()
    eng = make(tmp_path, fake, supervisor=sup)
    eng.start("v0.2.0")
    assert eng.progress()["state"] == "done"
    assert sup.requests == []


# ------------------------------------------------------------------ restart and recovery


def test_after_restart_the_new_process_confirms_the_version(tmp_path):
    fake = FakeGit()
    eng = make(tmp_path, fake)
    eng.start("v0.2.0")
    assert eng.progress()["state"] == "restarting"
    after = make(tmp_path, fake, version="0.2.0")
    after.recover()
    p = after.progress()
    assert p["state"] == "done"
    assert {s["id"]: s["status"] for s in p["steps"]}["restart"] == "done"


def test_restart_that_comes_back_on_the_old_version_is_reported(tmp_path):
    eng = make(tmp_path, FakeGit())
    eng.start("v0.2.0")
    after = make(tmp_path, FakeGit(), version="0.1.15")
    after.recover()
    assert after.progress()["state"] == "failed"


def test_an_update_interrupted_by_a_crash_is_reported(tmp_path):
    eng = make(tmp_path, FakeGit())
    state = eng._progress
    state.update(state="running", pid=-1, from_commit=OLD, step="python_deps")
    eng._save()
    after = make(tmp_path, FakeGit())
    after.recover()
    p = after.progress()
    assert p["state"] == "failed"
    assert "interrupted" in p["error"]
    assert f"git reset --keep {OLD}" in p["manual"]


def test_acknowledge_clears_finished_state(tmp_path):
    eng = make(tmp_path, FakeGit())
    eng.start("v0.2.0")
    after = make(tmp_path, FakeGit(), version="0.2.0")
    after.recover()
    after.acknowledge()
    assert after.progress()["state"] == "idle"


# ------------------------------------------------------------------ the log


def test_log_redacts_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv("KIE_API_KEY", "kie-super-secret-value")
    text = commands.redact("https://user:pw@github.com/x ghp_abcdefghijklmnopqrstuvwxyz0123456789 kie-super-secret-value"
                           " github_pat_11ABCDEFG0123456789_abcdefghijklmnop")
    assert "pw@" not in text and "ghp_abc" not in text and "kie-super-secret" not in text and "github_pat_11" not in text


def test_progress_and_log_have_no_secrets_from_command_output(tmp_path, monkeypatch):
    monkeypatch.setenv("PIAPI_API_KEY", "piapi-secret-123456")
    fake = FakeGit(fail={"uv sync": Result(1, "env dump piapi-secret-123456")})
    eng = make(tmp_path, fake)
    eng.start("v0.2.0")
    assert "piapi-secret-123456" not in json.dumps(eng.progress())
    assert "piapi-secret-123456" not in (tmp_path / "state" / "update.log").read_text()


def test_every_command_is_an_argument_list_with_a_timeout(tmp_path, monkeypatch):
    seen = []

    def fake_run(args, **kwargs):
        seen.append((args, kwargs))

        class P:
            returncode = 0
            stdout = "ok"
        return P()

    monkeypatch.setattr(commands.subprocess, "run", fake_run)
    out = commands.run_command(["git", "status"], tmp_path, 5)
    assert out == Result(0, "ok")
    args, kwargs = seen[0]
    assert args == ["git", "status"]
    assert kwargs.get("shell", False) is False
    assert kwargs["timeout"] == 5
    assert kwargs["env"]["GIT_TERMINAL_PROMPT"] == "0"


def test_command_timeout_and_missing_binary_are_results(tmp_path):
    assert commands.run_command(["definitely-not-a-binary-xyz"], tmp_path, 5).code == 127
