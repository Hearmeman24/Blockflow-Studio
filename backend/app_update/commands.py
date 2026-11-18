"""Run commands for the updater: argument lists only, never a shell string.

stdin is closed and git may not prompt (``GIT_TERMINAL_PROMPT=0``), so a
command that wants a password fails instead of hanging; every command has a
timeout. Output is returned to the engine, which redacts it before it goes
to the log or the progress view.
"""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping


@dataclass(frozen=True)
class Result:
    code: int
    output: str

    @property
    def ok(self) -> bool:
        return self.code == 0


# (args, cwd, timeout, env) -> Result
Runner = Callable[..., Result]

_SECRET_ENV_RE = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)", re.I)
_PATTERNS = [
    (re.compile(r"(\b[a-z][a-z0-9+.-]*://)[^/\s:@]+(?::[^/\s@]*)?@", re.I), r"\1***@"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}"), "***"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{16,}"), "***"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"), "***"),
    (re.compile(r"(?i)\b(authorization|bearer|token|password)(\s*[:=]\s*)\S+"), r"\1\2***"),
]


def _secret_env_values() -> list[str]:
    return sorted({v for k, v in os.environ.items() if _SECRET_ENV_RE.search(k) and len(v) >= 8},
                  key=len, reverse=True)


def redact(text: str) -> str:
    for value in _secret_env_values():
        text = text.replace(value, "***")
    for pattern, repl in _PATTERNS:
        text = pattern.sub(repl, text)
    return text


def command_env(extra: Mapping[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    env.update(extra or {})
    return env


def run_command(args: list[str], cwd: Path, timeout: float, env: Mapping[str, str] | None = None) -> Result:
    if not isinstance(args, list) or not args or not all(isinstance(a, str) for a in args):
        raise TypeError("commands are argument lists of strings")
    try:
        proc = subprocess.run(  # noqa: S603 - argument list, no shell
            args, cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=timeout, env=dict(env) if env is not None else command_env(), text=True,
            encoding="utf-8", errors="replace", shell=False,
        )
    except FileNotFoundError:
        return Result(127, f"{Path(args[0]).name}: command not found")
    except subprocess.TimeoutExpired:
        return Result(124, f"{Path(args[0]).name} did not finish within {int(timeout)} seconds")
    except OSError as exc:
        return Result(126, f"{Path(args[0]).name} could not start ({type(exc).__name__})")
    return Result(proc.returncode, proc.stdout or "")
