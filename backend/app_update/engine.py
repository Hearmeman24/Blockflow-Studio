"""The guarded self-update for git installs.

Sequence (each step is reported as it runs):

  preflight     git checkout of the configured repository, no tracked file
                modified or staged, git/uv/npm present, no active generation
                job (unless the user confirms), the tag is the newest release
  fetch         git fetch --tags --no-recurse-submodules origin
  verify        the tag resolves locally and matches GitHub (ls-remote), and
                it is a fast-forward of HEAD; the current commit is recorded
  pause         ask app.py to stop the web server (only when it can restart it)
  merge         git merge --ff-only <tag commit>
  python_deps   uv sync --frozen
  frontend_deps npm --prefix frontend ci (only when the lockfile changed)
  codegen       npm --prefix frontend run gen:custom-blocks
  build         npm --prefix frontend run build (packaged mode only)
  restart       ask app.py to restart both processes, or tell the user how

Never ``reset --hard``, ``checkout`` or ``clean``: untracked and ignored
files (``private_blocks/``, ``.env``, the data folder) are never touched.

If a step after the fetch fails, the checkout goes back to the recorded
commit with ``git reset --keep`` (it refuses rather than overwrite local
changes, and the tree was clean when the update started), packages are
re-synced, the web server is resumed, and the progress says exactly what
happened and which commands finish or undo the update by hand.

Progress is saved in ``<user data>/updates/progress.json`` (so the restarted
process, or the next start after a crash, can report the outcome) and the
command output, redacted, in ``<user data>/updates/update.log``.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Any, Callable

from backend.app_update import install, settings
from backend.app_update import version as semver
from backend.app_update.commands import Result, Runner, redact, run_command
from backend.app_update.supervisor import Supervisor, restart_command
from backend.statuses import ACTIVE_UPDATE_STATES, FINISHED_UPDATE_STATES, StepStatus, UpdateState

STEPS: tuple[tuple[str, str], ...] = (
    ("preflight", "Check that the update can run safely"),
    ("fetch", "Download the release from GitHub"),
    ("verify", "Check the release and that it fast-forwards"),
    ("pause", "Pause the web interface"),
    ("merge", "Apply the new version"),
    ("python_deps", "Update Python packages"),
    ("frontend_deps", "Update web packages"),
    ("codegen", "Register blocks"),
    ("build", "Build the web interface"),
    ("restart", "Restart BlockFlow"),
)
ROLLBACK_STEPS = (("rollback", "Undo the update"), ("rollback_deps", "Restore packages"))
ACTIVE_STATES = ACTIVE_UPDATE_STATES
FINISHED_STATES = FINISHED_UPDATE_STATES
LOCKFILES = ("frontend/package-lock.json", "frontend/package.json")
LAUNCHER = "app.py"
TOOLS = ("git", "uv", "npm")
TIMEOUTS = {"fetch": 300.0, "git": 30.0, "uv": 900.0, "npm_ci": 1200.0, "codegen": 300.0, "build": 1800.0}
LOG_TAIL = 80
OUTPUT_LINES_PER_COMMAND = 40


class Blocked(Exception):
    def __init__(self, blockers: list[dict[str, str]]) -> None:
        super().__init__("; ".join(b["message"] for b in blockers))
        self.blockers = blockers


class Busy(Exception):
    pass


class _StepFailed(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def count_active_jobs() -> int:
    from backend import job_store

    store = job_store.get_store()
    return sum(len(store.list_jobs(status=s, limit=500)) for s in job_store.ACTIVE_STATUSES)


def _idle() -> dict[str, Any]:
    return {"state": UpdateState.IDLE, "step": None, "steps": [], "error": None, "message": None, "tag": None,
            "from_version": None, "to_version": None, "from_commit": None, "to_commit": None,
            "started_at": None, "finished_at": None, "manual": [], "restart": None, "owner": None,
            "log_tail": []}


class UpdateEngine:
    def __init__(self, *, root: Path, state_dir: Path, runner: Runner = run_command,
                 which: Callable[[str], str | None] = shutil.which, repo: Callable[[], str] = settings.repo,
                 supervisor: Supervisor | Any | None = None, active_jobs: Callable[[], int] = count_active_jobs,
                 launch_mode: str = "unknown", current_version: str,
                 latest_tag: Callable[[], str | None] = lambda: None, threaded: bool = True,
                 clock: Callable[[], float] = time.time) -> None:
        self.root = Path(root)
        self.state_dir = Path(state_dir)
        self.runner = runner
        self.which = which
        self.repo = repo
        self.supervisor = supervisor if supervisor is not None else Supervisor()
        self.active_jobs = active_jobs
        self.launch_mode = launch_mode
        self.current_version = current_version
        self.latest_tag = latest_tag
        self.threaded = threaded
        self.clock = clock
        self.instance_id = uuid.uuid4().hex
        self._lock = threading.RLock()
        self._log: deque[str] = deque(maxlen=LOG_TAIL)
        self._progress = self._load()
        self._log.extend(self._progress.get("log_tail") or [])

    # ------------------------------------------------------------ persistence

    @property
    def progress_path(self) -> Path:
        return self.state_dir / "progress.json"

    @property
    def log_path(self) -> Path:
        return self.state_dir / "update.log"

    def _load(self) -> dict[str, Any]:
        try:
            data = json.loads(self.progress_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return _idle()
        if not isinstance(data, dict) or data.get("state") not in ACTIVE_STATES | FINISHED_STATES | {UpdateState.IDLE}:
            return _idle()
        return {**_idle(), **data}

    def _save(self) -> None:
        with self._lock:
            self._progress["log_tail"] = list(self._log)
            data = json.dumps(self._progress)
        try:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            tmp = self.progress_path.with_suffix(".tmp")
            tmp.write_text(data, encoding="utf-8")
            os.replace(tmp, self.progress_path)
        except OSError:
            pass  # progress stays in memory; the log line below says so

    def _write_log(self, lines: list[str]) -> None:
        lines = [redact(line) for line in lines]
        with self._lock:
            self._log.extend(lines)
        try:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y-%m-%d %H:%M:%S")
            with self.log_path.open("a", encoding="utf-8") as fh:
                for line in lines:
                    fh.write(f"{stamp} {line}\n")
        except OSError:
            pass

    def progress(self) -> dict[str, Any]:
        with self._lock:
            out = json.loads(json.dumps(self._progress))
            out["log_tail"] = list(self._log)
        out.pop("owner", None)
        return out

    # ------------------------------------------------------------ steps

    def _set_step(self, step_id: str, status: str, detail: str | None = None) -> None:
        with self._lock:
            for step in self._progress["steps"]:
                if step["id"] == step_id:
                    step["status"] = status
                    if detail is not None:
                        step["detail"] = redact(detail)
            if status == StepStatus.RUNNING:
                self._progress["step"] = step_id
        self._save()

    def _run(self, args: list[str], timeout: float) -> Result:
        shown = " ".join([Path(args[0]).name, *args[1:]])
        self._write_log([f"$ {shown}"])
        res = self.runner(args, self.root, timeout)
        out_lines = [line for line in res.output.splitlines() if line.strip()]
        if len(out_lines) > OUTPUT_LINES_PER_COMMAND:
            out_lines = ["…", *out_lines[-OUTPUT_LINES_PER_COMMAND:]]
        self._write_log([*out_lines, f"(exit {res.code})"])
        return res

    def _tool(self, name: str) -> str:
        path = self.which(name)
        if not path:
            raise _StepFailed(f"{name} is not installed or not on PATH.")
        return path

    # ------------------------------------------------------------ preflight

    def _tag_ok(self, tag: str) -> bool:
        parsed = semver.parse_tag(tag) if isinstance(tag, str) and tag.startswith("v") else None
        current = semver.parse(self.current_version)
        return bool(parsed and current and parsed > current and tag == self.latest_tag())

    def preflight(self, tag: str, *, allow_active_jobs: bool) -> list[dict[str, str]]:
        if not self._tag_ok(tag):
            return [{"code": "bad_tag", "message": "That is not the newest release BlockFlow knows about. "
                                                   "Check for updates and try again."}]
        blockers: list[dict[str, str]] = []
        missing = [t for t in TOOLS if not self.which(t)]
        if missing:
            blockers.append({"code": "missing_tools",
                             "message": f"Install {', '.join(missing)} and make sure it is on PATH, then try "
                                        "again. BlockFlow needs git, uv and npm to update itself."})
        info = install.detect(self.root, runner=self.runner, which=self.which, repo=self.repo(),
                              version=self.current_version)
        if not info["update_supported"]:
            return [*blockers, {"code": "not_supported", "message": info.get("reason") or "Not supported."}]
        dirty = install.dirty_files(self.runner, self.root, git=self.which("git") or "git")
        if dirty is None:
            blockers.append({"code": "git_error", "message": "git could not report the state of this checkout."})
        elif dirty:
            names = ", ".join(dirty[:8]) + (f" and {len(dirty) - 8} more" if len(dirty) > 8 else "")
            blockers.append({"code": "dirty", "message": (
                f"These files in the app folder have changes: {names}. Commit them, or set them aside with "
                "`git stash`, then try again. New files you added (such as private_blocks/) are fine.")})
        if not allow_active_jobs:
            active = self.active_jobs()
            if active:
                blockers.append({"code": "active_jobs", "message": (
                    f"{active} generation job{'s are' if active != 1 else ' is'} still running. Updating "
                    "restarts BlockFlow; the provider keeps working and BlockFlow picks the job back up after "
                    "the restart. Wait for it to finish, or confirm to update anyway.")})
        return blockers

    # ------------------------------------------------------------ start

    def start(self, tag: str, *, allow_active_jobs: bool = False) -> dict[str, Any]:
        with self._lock:
            if self._progress["state"] in ACTIVE_STATES:
                raise Busy("An update is already running.")
            blockers = self.preflight(tag, allow_active_jobs=allow_active_jobs)
            if blockers:
                raise Blocked(blockers)
            self._log.clear()
            target = semver.parse_tag(tag)
            self._progress = {
                **_idle(), "state": UpdateState.RUNNING, "tag": tag, "from_version": self.current_version,
                "to_version": str(target), "started_at": self.clock(), "owner": self.instance_id,
                "steps": [{"id": i, "label": label, "status": StepStatus.PENDING} for i, label in STEPS],
                "restart": {"automatic": False, "required": True, "command": restart_command(self.launch_mode)},
            }
            self._write_log([f"Updating BlockFlow {self.current_version} -> {target} ({tag})"])
            self._set_step("preflight", StepStatus.DONE)
        if self.threaded:
            threading.Thread(target=self._update, args=(tag,), name="blockflow-update", daemon=True).start()
        else:
            self._update(tag)
        return self.progress()

    # ------------------------------------------------------------ the update

    def _finish(self, state: str, *, error: str | None = None, message: str | None = None,
                manual: list[str] | None = None) -> None:
        with self._lock:
            self._progress.update(state=state, error=redact(error) if error else None, message=message,
                                  manual=manual or [], finished_at=self.clock(), step=None)
            for step in self._progress["steps"]:
                if step["status"] == StepStatus.PENDING:
                    step["status"] = StepStatus.SKIPPED
        self._write_log([f"Update {state}" + (f": {error}" if error else "")])
        self._save()

    def _manual_update_commands(self, tag: str) -> list[str]:
        return ["git fetch --tags origin", f"git merge --ff-only {tag}", "uv sync --frozen",
                "npm --prefix frontend ci", "npm --prefix frontend run gen:custom-blocks",
                *(["npm --prefix frontend run build"] if self.launch_mode == "packaged" else []),
                restart_command(self.launch_mode)]

    def _update(self, tag: str) -> None:
        self._paused = False
        self._merged = False
        self._deps_touched: set[str] = set()
        try:
            self._steps(tag)
        except _StepFailed as exc:
            self._handle_failure(tag, exc.message)
        except Exception as exc:  # noqa: BLE001 - always end in a reported state
            self._handle_failure(tag, f"Unexpected error: {type(exc).__name__}: {exc}")

    def _handle_failure(self, tag: str, message: str) -> None:
        step = self._progress.get("step")
        if step:
            self._set_step(step, StepStatus.FAILED, message)
        if self._progress.get("from_commit") and (self._merged or self._deps_touched or step == "merge"):
            self._rollback(tag, message)
            return
        if self._paused:
            self.supervisor.resume_frontend()
        self._finish(UpdateState.FAILED, error=message, manual=[])

    def _steps(self, tag: str) -> None:
        git = self._tool("git")
        uv = self._tool("uv")
        npm = self._tool("npm")

        self._set_step("fetch", StepStatus.RUNNING)
        res = self._run([git, "fetch", "--tags", "--no-recurse-submodules", "origin"], TIMEOUTS["fetch"])
        if not res.ok and "would clobber existing tag" in res.output:
            raise _StepFailed("A tag in this checkout does not match the one on GitHub (git fetch refused to "
                              f"overwrite it). Remove it with `git tag -d {tag}` and try again.")
        if not res.ok:
            raise _StepFailed("Could not download the release from GitHub (git fetch failed). Check your "
                              "connection and that `git fetch origin` works in the app folder.")
        self._set_step("fetch", StepStatus.DONE)

        self._set_step("verify", StepStatus.RUNNING)
        local = self._run([git, "rev-parse", "--verify", "--quiet", f"refs/tags/{tag}^{{commit}}"], TIMEOUTS["git"])
        new = local.output.strip()
        if not local.ok or len(new) < 40:
            raise _StepFailed(f"The tag {tag} was not found after downloading.")
        # The ^{} line is the commit an annotated tag points at; ask for it explicitly.
        remote = self._run([git, "ls-remote", "--tags", "origin", f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}"],
                           TIMEOUTS["fetch"])
        remote_commit = None
        for line in remote.output.splitlines():
            sha, _, ref = line.partition("\t")
            if ref.strip() == f"refs/tags/{tag}^{{}}" or (ref.strip() == f"refs/tags/{tag}" and remote_commit is None):
                remote_commit = sha.strip()
        if not remote.ok or not remote_commit:
            raise _StepFailed(f"GitHub does not list the tag {tag}.")
        if remote_commit != new:
            raise _StepFailed(f"The local tag {tag} does not match the one on GitHub. Remove it with "
                              f"`git tag -d {tag}` and try again.")
        head_res = self._run([git, "rev-parse", "HEAD"], TIMEOUTS["git"])
        head = head_res.output.strip()
        if not head_res.ok or len(head) < 40:
            raise _StepFailed("Could not read the current commit.")
        with self._lock:
            self._progress.update(from_commit=head, to_commit=new)
        if head == new:
            self._set_step("verify", StepStatus.DONE, f"Already on {tag}.")
            with self._lock:
                self._progress["restart"] = {"automatic": False, "required": False,
                                             "command": restart_command(self.launch_mode)}
            self._finish(UpdateState.DONE, message=f"BlockFlow is already on {tag}.")
            return
        ff = self._run([git, "merge-base", "--is-ancestor", head, new], TIMEOUTS["git"])
        if ff.code == 1:
            raise _StepFailed(f"This checkout has commits that are not in {tag}, so it cannot fast-forward to it. "
                              "Update it yourself with git (for example, rebase your commits onto the tag).")
        if not ff.ok:
            raise _StepFailed("git could not compare this checkout with the release.")
        dirty = install.dirty_files(self.runner, self.root, git=git)
        if dirty:
            raise _StepFailed("Files in the app folder changed while the update was starting: "
                              f"{', '.join(dirty[:8])}. Nothing was changed.")
        diff = self._run([git, "diff", "--name-only", head, new], TIMEOUTS["git"])
        changed = {line.strip() for line in diff.output.splitlines() if line.strip()} if diff.ok else set(LOCKFILES)
        need_npm_ci = bool(changed & set(LOCKFILES)) or not (self.root / "frontend" / "node_modules").is_dir()
        launcher_changed = LAUNCHER in changed
        auto_restart = self.supervisor.available and self.launch_mode in ("dev", "packaged") and not launcher_changed
        self._set_step("verify", StepStatus.DONE, f"{head[:12]} -> {new[:12]}, {len(changed)} files change.")

        if auto_restart:
            self._set_step("pause", StepStatus.RUNNING)
            self._paused = True
            if not self.supervisor.pause_frontend():
                raise _StepFailed("The web interface did not stop in time. Nothing was changed.")
            self._set_step("pause", StepStatus.DONE)
        else:
            self._set_step("pause", StepStatus.SKIPPED)

        self._set_step("merge", StepStatus.RUNNING)
        res = self._run([git, "merge", "--ff-only", new], TIMEOUTS["git"])
        if not res.ok:
            raise _StepFailed(f"git could not fast-forward to {tag}.")
        self._merged = True
        self._set_step("merge", StepStatus.DONE)

        self._set_step("python_deps", StepStatus.RUNNING)
        self._deps_touched.add("python")
        if not self._run([uv, "sync", "--frozen"], TIMEOUTS["uv"]).ok:
            raise _StepFailed("Updating Python packages failed (uv sync).")
        self._set_step("python_deps", StepStatus.DONE)

        if need_npm_ci:
            self._set_step("frontend_deps", StepStatus.RUNNING)
            self._deps_touched.add("npm")
            if not self._run([npm, "--prefix", "frontend", "ci"], TIMEOUTS["npm_ci"]).ok:
                raise _StepFailed("Updating web packages failed (npm ci).")
            self._set_step("frontend_deps", StepStatus.DONE)
        else:
            self._set_step("frontend_deps", StepStatus.SKIPPED, "The web package lockfile did not change.")

        self._set_step("codegen", StepStatus.RUNNING)
        self._deps_touched.add("codegen")
        if not self._run([npm, "--prefix", "frontend", "run", "gen:custom-blocks"], TIMEOUTS["codegen"]).ok:
            raise _StepFailed("Registering blocks failed (gen:custom-blocks).")
        self._set_step("codegen", StepStatus.DONE)

        if self.launch_mode == "packaged":
            self._set_step("build", StepStatus.RUNNING)
            self._deps_touched.add("build")
            if not self._run([npm, "--prefix", "frontend", "run", "build"], TIMEOUTS["build"]).ok:
                raise _StepFailed("Building the web interface failed (npm run build).")
            self._set_step("build", StepStatus.DONE)
        else:
            self._set_step("build", StepStatus.SKIPPED, "The development server builds on start.")

        command = restart_command(self.launch_mode)
        if auto_restart:
            with self._lock:
                self._progress.update(state=UpdateState.RESTARTING,
                                      restart={"automatic": True, "required": True, "command": command})
            self._set_step("restart", StepStatus.RUNNING)
            self._write_log(["Restarting BlockFlow…"])
            self._save()
            self.supervisor.restart()
            return
        reason = ("The launcher (app.py) changed, so BlockFlow must be stopped and started again."
                  if launcher_changed else "BlockFlow was not started with app.py, so it cannot restart itself.")
        with self._lock:
            self._progress["restart"] = {"automatic": False, "required": True, "command": command}
        self._set_step("restart", StepStatus.SKIPPED, f"{reason} Stop it (Ctrl+C) and run `{command}`.")
        self._finish(UpdateState.DONE, message=f"Updated to {tag}. Restart BlockFlow to use it: stop it (Ctrl+C in its "
                                     f"terminal) and run `{command}` in the app folder. {reason}",
                     manual=[command])

    # ------------------------------------------------------------ rollback

    def _rollback(self, tag: str, message: str) -> None:
        old = self._progress["from_commit"]
        with self._lock:
            self._progress["steps"].extend({"id": i, "label": label, "status": StepStatus.PENDING} for i, label in ROLLBACK_STEPS)
        git, uv, npm = (self.which(t) or t for t in TOOLS)
        self._set_step("rollback", StepStatus.RUNNING)
        head = self._run([git, "rev-parse", "HEAD"], TIMEOUTS["git"]).output.strip()
        undo = [f"git reset --keep {old}", "uv sync --frozen", "npm --prefix frontend ci",
                "npm --prefix frontend run gen:custom-blocks",
                *(["npm --prefix frontend run build"] if self.launch_mode == "packaged" else []),
                restart_command(self.launch_mode)]
        if head != old:
            res = self._run([git, "reset", "--keep", old], TIMEOUTS["git"])
            if not res.ok:
                self._set_step("rollback", StepStatus.FAILED, "git reset --keep refused.")
                if self._paused:
                    self.supervisor.resume_frontend()
                self._finish(UpdateState.FAILED, manual=undo, error=(
                    f"{message} The update could not be undone automatically, so BlockFlow may be half-updated "
                    f"(code at {tag}, packages may not match). Run these commands in the app folder to go back."))
                return
        self._set_step("rollback", StepStatus.DONE, f"Back on {old[:12]}.")

        restore_failed = []
        if self._deps_touched:
            self._set_step("rollback_deps", StepStatus.RUNNING)
            if "python" in self._deps_touched and not self._run([uv, "sync", "--frozen"], TIMEOUTS["uv"]).ok:
                restore_failed.append("uv sync --frozen")
            if "npm" in self._deps_touched and not self._run([npm, "--prefix", "frontend", "ci"],
                                                               TIMEOUTS["npm_ci"]).ok:
                restore_failed.append("npm --prefix frontend ci")
            if "codegen" in self._deps_touched and not self._run(
                    [npm, "--prefix", "frontend", "run", "gen:custom-blocks"], TIMEOUTS["codegen"]).ok:
                restore_failed.append("npm --prefix frontend run gen:custom-blocks")
            if "build" in self._deps_touched and not self._run([npm, "--prefix", "frontend", "run", "build"],
                                                                 TIMEOUTS["build"]).ok:
                restore_failed.append("npm --prefix frontend run build")
            self._set_step("rollback_deps", StepStatus.FAILED if restore_failed else StepStatus.DONE)
        else:
            self._set_step("rollback_deps", StepStatus.SKIPPED, "Nothing was installed.")
        if self._paused:
            self.supervisor.resume_frontend()
        if restore_failed:
            self._finish(UpdateState.FAILED, manual=[*restore_failed, restart_command(self.launch_mode)], error=(
                f"{message} The code is back on the previous version, but restoring packages failed. Run these "
                "commands in the app folder, then restart BlockFlow."))
            return
        self._finish(UpdateState.ROLLED_BACK, manual=self._manual_update_commands(tag), error=message,
                     message=f"The update to {tag} failed and was undone; BlockFlow is still on "
                             f"{self.current_version}. You can try again later or update by hand.")

    # ------------------------------------------------------------ after a restart

    def recover(self) -> None:
        """Run once at startup: settle an update a previous process left."""
        with self._lock:
            p = self._progress
            if p["state"] not in ACTIVE_STATES or p.get("owner") == self.instance_id:
                return
            old = p.get("from_commit")
            if p["state"] == UpdateState.RESTARTING:
                if self.current_version == p.get("to_version"):
                    for step in p["steps"]:
                        if step["id"] == "restart":
                            step["status"] = StepStatus.DONE
                    p.update(state=UpdateState.DONE, finished_at=self.clock(), step=None, error=None,
                             message=f"Updated to {p.get('tag')}.")
                    self._log.append(f"Restarted on {self.current_version}.")
                else:
                    p.update(state=UpdateState.FAILED, finished_at=self.clock(), step=None,
                             error=(f"BlockFlow restarted but is running {self.current_version}, not "
                                    f"{p.get('to_version')}. Stop it and start it again with "
                                    f"`{restart_command(self.launch_mode)}`."),
                             manual=[restart_command(self.launch_mode)])
            else:
                manual = ([f"git reset --keep {old}", "uv sync --frozen", "npm --prefix frontend ci",
                           "npm --prefix frontend run gen:custom-blocks", restart_command(self.launch_mode)]
                          if old else [])
                p.update(state=UpdateState.FAILED, finished_at=self.clock(), step=None, manual=manual, error=(
                    "The update was interrupted (BlockFlow stopped while it was running). The app folder may be "
                    "half-updated. To go back to the previous version, run these commands in the app folder."))
            p["owner"] = self.instance_id
        self._save()

    def acknowledge(self) -> dict[str, Any]:
        with self._lock:
            if self._progress["state"] in FINISHED_STATES:
                self._progress = _idle()
                self._log.clear()
        self._save()
        return self.progress()
