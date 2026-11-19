"""ADVANCED_MODE is switched on by BLOCKFLOW_ADVANCED, like the other BLOCKFLOW_* variables."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _advanced_mode(tmp_path, **env_vars: str) -> str:
    env = {k: v for k, v in os.environ.items() if k != "BLOCKFLOW_ADVANCED"}
    env.update(env_vars)
    env["BLOCKFLOW_DATA_DIR"] = str(tmp_path)
    res = subprocess.run(
        [sys.executable, "-c", "import backend.config as c; print(c.ADVANCED_MODE)"],
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=60,
    )
    assert res.returncode == 0, res.stderr
    return res.stdout.strip()


def test_blockflow_advanced_turns_advanced_mode_on(tmp_path):
    assert _advanced_mode(tmp_path, BLOCKFLOW_ADVANCED="1") == "True"


def test_unset_leaves_advanced_mode_off(tmp_path):
    assert _advanced_mode(tmp_path) == "False"


def test_other_values_leave_advanced_mode_off(tmp_path):
    assert _advanced_mode(tmp_path, BLOCKFLOW_ADVANCED="0") == "False"
