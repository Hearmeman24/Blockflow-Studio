"""Open the operating system's own folder dialog and return the chosen path.

A browser page cannot hand BlockFlow a real filesystem path, but the backend
runs on the user's machine, so it can open the native dialog itself:

  - macOS:   osascript `choose folder`
  - Windows: PowerShell (STA) with System.Windows.Forms.FolderBrowserDialog
  - Linux:   zenity, or kdialog on KDE / when zenity is missing

Results are plain dicts:
  {"status": "chosen", "path": str}
  {"status": "cancelled"}
  {"status": "unavailable", "message": str}   no dialog here, or it failed
  {"status": "busy", "message": str}          another dialog is already open

Commands are argument lists (never a shell string); user-supplied values
(the initial folder) travel as argv entries or environment variables, never
inside script text. Nothing runs at import time. `platform`, `which`, `env`
and `runner` are injectable so every branch is testable on any OS.
"""
from __future__ import annotations

import base64
import os
import shutil
import subprocess
import sys
import threading
from collections.abc import Callable, Mapping
from typing import Any

PROMPT = "Choose where BlockFlow saves files"
# Long enough for a person to browse; bounded so a forgotten dialog can't
# hold the lock forever.
PICKER_TIMEOUT_S = 300
CREATE_NO_WINDOW = 0x08000000  # Windows: don't flash a console window

Result = dict[str, Any]
Which = Callable[[str], str | None]

_dialog_lock = threading.Lock()

_TYPE_INSTEAD = "Type the folder path instead."

_MAC_SCRIPT = (
    "on run argv",
    "activate",
    "set promptText to item 1 of argv",
    "if (count of argv) > 1 then",
    "set chosen to choose folder with prompt promptText default location (POSIX file (item 2 of argv))",
    "else",
    "set chosen to choose folder with prompt promptText",
    "end if",
    "return POSIX path of chosen",
    "end run",
)

_WINDOWS_SCRIPT = "\n".join((
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "[System.Windows.Forms.Application]::EnableVisualStyles()",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
    f"$d.Description = '{PROMPT}'",
    "$d.ShowNewFolderButton = $true",
    "try { $d.UseDescriptionForTitle = $true } catch {}",
    "if ($env:BLOCKFLOW_PICKER_INITIAL) { $d.SelectedPath = $env:BLOCKFLOW_PICKER_INITIAL }",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$owner.ShowInTaskbar = $false",
    "$r = $d.ShowDialog($owner)",
    "$owner.Dispose()",
    "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write('OK:' + $d.SelectedPath) }",
    "else { [Console]::Out.Write('CANCEL') }",
))


def _unavailable(message: str) -> Result:
    return {"status": "unavailable", "message": message}


def _platform_kind(platform: str) -> str:
    if platform == "darwin":
        return "mac"
    if platform == "win32" or platform.startswith("cygwin"):
        return "windows"
    if platform.startswith("linux") or platform.startswith("freebsd"):
        return "linux"
    return "other"


def _linux_tool(which: Which, env: Mapping[str, str]) -> str | None:
    zenity, kdialog = which("zenity"), which("kdialog")
    on_kde = "KDE" in env.get("XDG_CURRENT_DESKTOP", "").upper()
    if on_kde and kdialog:
        return kdialog
    return zenity or kdialog


def _windows_shell(which: Which) -> str | None:
    return which("powershell.exe") or which("powershell") or which("pwsh")


def _unavailable_reason(kind: str, which: Which, env: Mapping[str, str]) -> str | None:
    """Why no dialog can be shown here, or None when one can be tried."""
    if kind == "mac":
        return None if which("osascript") else f"The macOS folder dialog isn't available. {_TYPE_INSTEAD}"
    if kind == "windows":
        return None if _windows_shell(which) else f"PowerShell wasn't found, so no folder dialog can open. {_TYPE_INSTEAD}"
    if kind == "linux":
        if not (env.get("DISPLAY") or env.get("WAYLAND_DISPLAY")):
            return f"There is no desktop display for a folder dialog. {_TYPE_INSTEAD}"
        if not _linux_tool(which, env):
            return f"Install zenity or kdialog to choose a folder with a dialog. {_TYPE_INSTEAD}"
        return None
    return f"Choosing a folder with a dialog isn't supported on this system. {_TYPE_INSTEAD}"


def picker_availability(
    *, platform: str | None = None, which: Which | None = None, env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Whether a dialog can be attempted. Runs nothing."""
    kind = _platform_kind(platform or sys.platform)
    reason = _unavailable_reason(kind, which or shutil.which, os.environ if env is None else env)
    return {"available": reason is None, "reason": reason}


def _build(kind: str, which: Which, env: Mapping[str, str], initial: str | None):
    """(argv, extra subprocess kwargs, parser)."""
    if kind == "mac":
        argv = [which("osascript") or "osascript"]
        for line in _MAC_SCRIPT:
            argv += ["-e", line]
        argv.append(PROMPT)
        if initial:
            argv.append(initial)
        run_env = dict(env)
        run_env.setdefault("LANG", "en_US.UTF-8")
        return argv, {"env": run_env}, _parse_mac

    if kind == "windows":
        encoded = base64.b64encode(_WINDOWS_SCRIPT.encode("utf-16-le")).decode("ascii")
        argv = [_windows_shell(which) or "powershell.exe", "-NoProfile", "-NonInteractive", "-STA",
                "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded]
        run_env = dict(env)
        if initial:
            run_env["BLOCKFLOW_PICKER_INITIAL"] = initial
        else:
            run_env.pop("BLOCKFLOW_PICKER_INITIAL", None)
        return argv, {"env": run_env, "creationflags": CREATE_NO_WINDOW}, _parse_windows

    tool = _linux_tool(which, env) or "zenity"
    if os.path.basename(tool).startswith("kdialog"):
        argv = [tool, "--getexistingdirectory", initial or env.get("HOME", "~"), "--title", PROMPT]
    else:
        argv = [tool, "--file-selection", "--directory", f"--title={PROMPT}"]
        if initial:
            argv.append(f"--filename={initial.rstrip('/')}/")
    return argv, {"env": dict(env)}, _parse_exit_one_is_cancel


def _clean(stdout: str | None) -> str:
    return (stdout or "").lstrip("﻿").strip("\r\n")


def _parse_mac(proc: subprocess.CompletedProcess) -> Result:
    if proc.returncode != 0:
        if "-128" in (proc.stderr or "") or "User canceled" in (proc.stderr or ""):
            return {"status": "cancelled"}
        return _unavailable(f"The macOS folder dialog could not be opened. {_TYPE_INSTEAD}")
    path = _clean(proc.stdout)
    if len(path) > 1:
        path = path.rstrip("/")
    return {"status": "chosen", "path": path} if path else _unavailable(
        f"The folder dialog returned no folder. {_TYPE_INSTEAD}")


def _parse_windows(proc: subprocess.CompletedProcess) -> Result:
    out = _clean(proc.stdout).strip()
    if proc.returncode == 0 and out == "CANCEL":
        return {"status": "cancelled"}
    if proc.returncode == 0 and out.startswith("OK:") and out[3:].strip():
        return {"status": "chosen", "path": out[3:].strip()}
    return _unavailable(f"The Windows folder dialog could not be opened. {_TYPE_INSTEAD}")


def _parse_exit_one_is_cancel(proc: subprocess.CompletedProcess) -> Result:
    if proc.returncode == 1:
        return {"status": "cancelled"}
    path = _clean(proc.stdout)
    if proc.returncode == 0 and path:
        return {"status": "chosen", "path": path.rstrip("/") if len(path) > 1 else path}
    return _unavailable(f"The folder dialog could not be opened. {_TYPE_INSTEAD}")


def choose_folder(
    *,
    initial: str | None = None,
    platform: str | None = None,
    which: Which | None = None,
    env: Mapping[str, str] | None = None,
    runner: Callable[..., subprocess.CompletedProcess] | None = None,
    timeout: float = PICKER_TIMEOUT_S,
) -> Result:
    """Show the native folder dialog and wait for the user. One at a time."""
    kind = _platform_kind(platform or sys.platform)
    which = which or shutil.which
    env = os.environ if env is None else env
    reason = _unavailable_reason(kind, which, env)
    if reason:
        return _unavailable(reason)
    if initial and not os.path.isdir(initial):
        initial = None

    if not _dialog_lock.acquire(blocking=False):
        return {"status": "busy", "message": "A folder dialog is already open. Finish or close it first."}
    try:
        argv, extra, parse = _build(kind, which, env, initial)
        run = runner or subprocess.run
        try:
            proc = run(argv, capture_output=True, encoding="utf-8", errors="strict",
                       stdin=subprocess.DEVNULL, timeout=timeout, check=False, **extra)
        except subprocess.TimeoutExpired:
            return _unavailable(f"The folder dialog was closed because it stayed open too long. {_TYPE_INSTEAD}")
        except (OSError, UnicodeDecodeError, ValueError):
            return _unavailable(f"The folder dialog could not be opened. {_TYPE_INSTEAD}")
        return parse(proc)
    finally:
        _dialog_lock.release()
