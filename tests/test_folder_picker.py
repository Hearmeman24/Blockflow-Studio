"""Native folder dialog (backend/folder_picker.py).

Every platform branch runs here with an injected platform, `which` and a fake
runner, so the Windows and Linux commands are exercised on any OS. The real
dialog is never opened by these tests.
"""
from __future__ import annotations

import base64
import subprocess
import threading

import pytest

from backend import folder_picker as fp

MAC_ENV = {"HOME": "/Users/a"}
WIN_ENV = {"USERPROFILE": r"C:\Users\a"}
LINUX_ENV = {"DISPLAY": ":0"}


def which_for(*present: str):
    return lambda name: f"/usr/bin/{name}" if name in present else None


class FakeRunner:
    """Records the call and returns a canned CompletedProcess (or raises)."""

    def __init__(self, returncode=0, stdout="", stderr="", exc: BaseException | None = None):
        self.returncode, self.stdout, self.stderr, self.exc = returncode, stdout, stderr, exc
        self.calls: list[tuple[list[str], dict]] = []

    def __call__(self, argv, **kwargs):
        self.calls.append((list(argv), kwargs))
        if self.exc is not None:
            raise self.exc
        return subprocess.CompletedProcess(argv, self.returncode, self.stdout, self.stderr)


def run(platform, runner, *, which=None, env=None, initial=None, timeout=fp.PICKER_TIMEOUT_S):
    defaults = {
        "darwin": (which_for("osascript"), MAC_ENV),
        "win32": (which_for("powershell.exe"), WIN_ENV),
        "linux": (which_for("zenity"), LINUX_ENV),
    }[platform]
    return fp.choose_folder(
        initial=initial, platform=platform, which=which or defaults[0],
        env=env if env is not None else defaults[1], runner=runner, timeout=timeout,
    )


def _decoded_ps_script(argv: list[str]) -> str:
    encoded = argv[argv.index("-EncodedCommand") + 1]
    return base64.b64decode(encoded).decode("utf-16-le")


# === importing never runs anything =========================================

def test_import_has_no_side_effects(monkeypatch):
    import importlib

    calls = []
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: calls.append(a))
    importlib.reload(fp)
    assert calls == []


# === macOS =================================================================

def test_macos_command_is_an_argument_list_with_the_prompt_as_argv():
    runner = FakeRunner(stdout="/Users/a/Out/\n")
    run("darwin", runner)
    argv, kwargs = runner.calls[0]
    assert argv[0] == "/usr/bin/osascript"
    script = "\n".join(argv[i + 1] for i, a in enumerate(argv) if a == "-e")
    assert "choose folder with prompt" in script
    assert "POSIX path of" in script
    assert "on run argv" in script
    # The prompt travels as an argument, not inside the script text.
    assert argv[-1] == fp.PROMPT
    assert fp.PROMPT not in script
    assert kwargs["timeout"] == fp.PICKER_TIMEOUT_S
    assert kwargs["capture_output"] is True
    assert kwargs["encoding"] == "utf-8"
    assert kwargs["stdin"] is subprocess.DEVNULL
    assert "shell" not in kwargs or kwargs["shell"] is False


def test_macos_initial_folder_is_passed_as_argument(tmp_path):
    runner = FakeRunner(stdout="/Users/a/Out/\n")
    run("darwin", runner, initial=str(tmp_path))
    argv, _ = runner.calls[0]
    assert argv[-2:] == [fp.PROMPT, str(tmp_path)]
    script = "\n".join(argv[i + 1] for i, a in enumerate(argv) if a == "-e")
    assert "default location" in script
    assert str(tmp_path) not in script


def test_macos_initial_folder_that_is_not_a_directory_is_dropped(tmp_path):
    runner = FakeRunner(stdout="/x/\n")
    run("darwin", runner, initial=str(tmp_path / "missing"))
    assert runner.calls[0][0][-1] == fp.PROMPT


@pytest.mark.parametrize(
    "stdout,path",
    [
        ("/Users/a/BlockFlow Out/\n", "/Users/a/BlockFlow Out"),
        ("/Users/a/Out/\r\n", "/Users/a/Out"),
        ("/Volumes/Ext SSD/Ünïcødé 输出/\n", "/Volumes/Ext SSD/Ünïcødé 输出"),
        ("/\n", "/"),
    ],
)
def test_macos_parses_chosen_path(stdout, path):
    assert run("darwin", FakeRunner(stdout=stdout)) == {"status": "chosen", "path": path}


def test_macos_cancel_is_cancelled():
    runner = FakeRunner(returncode=1, stderr="0:93: execution error: User canceled. (-128)\n")
    assert run("darwin", runner) == {"status": "cancelled"}


def test_macos_other_failure_is_unavailable():
    runner = FakeRunner(returncode=1, stderr="execution error: No user interaction allowed. (-1713)\n")
    result = run("darwin", runner)
    assert result["status"] == "unavailable"
    assert "type the folder path" in result["message"].lower()


def test_macos_without_osascript_is_unavailable():
    runner = FakeRunner()
    result = run("darwin", runner, which=which_for())
    assert result["status"] == "unavailable"
    assert runner.calls == []


# === Windows ===============================================================

def test_windows_command_is_sta_powershell_with_encoded_script():
    runner = FakeRunner(stdout="OK:C:\\Users\\a\\Out\r\n")
    run("win32", runner)
    argv, kwargs = runner.calls[0]
    assert argv[0] == "/usr/bin/powershell.exe"
    for flag in ("-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand"):
        assert flag in argv
    assert argv[argv.index("-WindowStyle") + 1] == "Hidden"
    script = _decoded_ps_script(argv)
    assert "System.Windows.Forms.FolderBrowserDialog" in script
    assert "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8" in script
    assert "$env:BLOCKFLOW_PICKER_INITIAL" in script
    assert kwargs["creationflags"] == fp.CREATE_NO_WINDOW
    assert kwargs["encoding"] == "utf-8"
    assert kwargs["timeout"] == fp.PICKER_TIMEOUT_S


def test_windows_falls_back_to_pwsh():
    runner = FakeRunner(stdout="OK:D:\\Out")
    run("win32", runner, which=which_for("pwsh"))
    assert runner.calls[0][0][0] == "/usr/bin/pwsh"


def test_windows_initial_folder_goes_through_the_environment(tmp_path):
    runner = FakeRunner(stdout="OK:D:\\Out")
    run("win32", runner, initial=str(tmp_path))
    argv, kwargs = runner.calls[0]
    assert kwargs["env"]["BLOCKFLOW_PICKER_INITIAL"] == str(tmp_path)
    assert str(tmp_path) not in " ".join(argv)
    assert kwargs["env"]["USERPROFILE"] == r"C:\Users\a"


@pytest.mark.parametrize(
    "stdout,path",
    [
        ("OK:C:\\Users\\a\\BlockFlow Out\r\n", "C:\\Users\\a\\BlockFlow Out"),
        ("\ufeffOK:D:\\Médias\\输出\r\n", "D:\\Médias\\输出"),
        ("OK:\\\\nas\\share\\BlockFlow\n", "\\\\nas\\share\\BlockFlow"),
    ],
)
def test_windows_parses_chosen_path(stdout, path):
    assert run("win32", FakeRunner(stdout=stdout)) == {"status": "chosen", "path": path}


def test_windows_cancel():
    assert run("win32", FakeRunner(stdout="CANCEL\r\n")) == {"status": "cancelled"}


@pytest.mark.parametrize("returncode,stdout", [(1, ""), (0, ""), (0, "garbage"), (0, "OK:")])
def test_windows_failure_is_unavailable(returncode, stdout):
    assert run("win32", FakeRunner(returncode=returncode, stdout=stdout))["status"] == "unavailable"


def test_windows_without_powershell_is_unavailable():
    assert run("win32", FakeRunner(), which=which_for())["status"] == "unavailable"


# === Linux =================================================================

def test_linux_zenity_command():
    runner = FakeRunner(stdout="/home/a/Out\n")
    assert run("linux", runner) == {"status": "chosen", "path": "/home/a/Out"}
    argv, _ = runner.calls[0]
    assert argv[:3] == ["/usr/bin/zenity", "--file-selection", "--directory"]
    assert f"--title={fp.PROMPT}" in argv


def test_linux_zenity_initial_folder(tmp_path):
    runner = FakeRunner(stdout="/home/a/Out\n")
    run("linux", runner, initial=str(tmp_path))
    assert f"--filename={tmp_path}/" in runner.calls[0][0]


def test_linux_kdialog_when_zenity_missing(tmp_path):
    runner = FakeRunner(stdout="/home/a/Ausgabe ü\n")
    result = run("linux", runner, which=which_for("kdialog"), initial=str(tmp_path))
    assert result == {"status": "chosen", "path": "/home/a/Ausgabe ü"}
    argv, _ = runner.calls[0]
    assert argv == ["/usr/bin/kdialog", "--getexistingdirectory", str(tmp_path), "--title", fp.PROMPT]


def test_linux_kde_prefers_kdialog():
    runner = FakeRunner(stdout="/home/a/x\n")
    run("linux", runner, which=which_for("zenity", "kdialog"),
        env={"DISPLAY": ":0", "XDG_CURRENT_DESKTOP": "KDE"})
    assert runner.calls[0][0][0] == "/usr/bin/kdialog"


@pytest.mark.parametrize("tool", ["zenity", "kdialog"])
def test_linux_cancel(tool):
    assert run("linux", FakeRunner(returncode=1), which=which_for(tool)) == {"status": "cancelled"}


def test_linux_error_exit_is_unavailable():
    assert run("linux", FakeRunner(returncode=5))["status"] == "unavailable"


def test_linux_headless_is_unavailable():
    runner = FakeRunner()
    result = run("linux", runner, env={})
    assert result["status"] == "unavailable"
    assert "display" in result["message"].lower()
    assert runner.calls == []


def test_linux_no_tool_is_unavailable():
    result = run("linux", FakeRunner(), which=which_for())
    assert result["status"] == "unavailable"
    assert "zenity" in result["message"]


def test_unknown_platform_is_unavailable():
    result = fp.choose_folder(platform="sunos5", which=which_for(), env={}, runner=FakeRunner())
    assert result["status"] == "unavailable"


# === failures common to every platform =====================================

@pytest.mark.parametrize("platform", ["darwin", "win32", "linux"])
def test_timeout_is_unavailable(platform):
    runner = FakeRunner(exc=subprocess.TimeoutExpired(cmd="x", timeout=1))
    result = run(platform, runner, timeout=1)
    assert result["status"] == "unavailable"
    assert "closed" in result["message"].lower() or "time" in result["message"].lower()


@pytest.mark.parametrize("platform", ["darwin", "win32", "linux"])
@pytest.mark.parametrize("exc", [FileNotFoundError("gone"), PermissionError("no"), OSError("boom"),
                                 UnicodeDecodeError("utf-8", b"\xff", 0, 1, "bad")])
def test_launch_errors_are_unavailable(platform, exc):
    assert run(platform, FakeRunner(exc=exc))["status"] == "unavailable"


@pytest.mark.parametrize("platform", ["darwin", "win32", "linux"])
def test_availability_reports_without_running_anything(platform):
    defaults = {"darwin": (which_for("osascript"), MAC_ENV), "win32": (which_for("powershell.exe"), WIN_ENV),
                "linux": (which_for("zenity"), LINUX_ENV)}[platform]
    assert fp.picker_availability(platform=platform, which=defaults[0], env=defaults[1]) == {
        "available": True, "reason": None,
    }
    missing = fp.picker_availability(platform=platform, which=which_for(), env=defaults[1])
    assert missing["available"] is False and missing["reason"]


# === one dialog at a time ==================================================

def test_second_request_while_a_dialog_is_open_is_busy():
    started = threading.Event()
    release = threading.Event()

    def slow_runner(argv, **kwargs):
        started.set()
        release.wait(5)
        return subprocess.CompletedProcess(argv, 0, "/Users/a/Out/\n", "")

    results: list[dict] = []
    t = threading.Thread(target=lambda: results.append(
        fp.choose_folder(platform="darwin", which=which_for("osascript"), env=MAC_ENV, runner=slow_runner)))
    t.start()
    assert started.wait(5)

    second = FakeRunner(stdout="/never/\n")
    busy = run("darwin", second)
    assert busy["status"] == "busy"
    assert "already open" in busy["message"].lower()
    assert second.calls == []

    release.set()
    t.join(5)
    assert results == [{"status": "chosen", "path": "/Users/a/Out"}]
    # The lock is released afterwards.
    assert run("darwin", FakeRunner(stdout="/again/\n")) == {"status": "chosen", "path": "/again"}


def test_lock_is_released_after_an_exception():
    run("darwin", FakeRunner(exc=OSError("boom")))
    assert run("darwin", FakeRunner(stdout="/ok/\n"))["status"] == "chosen"
