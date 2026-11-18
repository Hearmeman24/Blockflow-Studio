"""Shared test safety net.

The app downloads the public price ledger by default
(backend/byok/price_sources.py). No test may reach the network for it: the
real transport is replaced by one that fails, and background refreshes are
off. Tests that exercise the refresh install their own fake transport.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture(autouse=True)
def _no_price_ledger_network(monkeypatch):
    from backend.byok import price_sources

    def refuse(*args, **kwargs):
        raise AssertionError("tests must not download the price ledger; install a fake transport")

    monkeypatch.setattr(price_sources, "transport", refuse)
    monkeypatch.setattr(price_sources, "AUTO_REFRESH", False)
    price_sources.reset_state()
    yield
    price_sources.reset_state()


@pytest.fixture(autouse=True)
def _isolated_output_folder(request, tmp_path_factory, monkeypatch):
    """Every test writes generated files to its own temp output folder, never
    the user's. Tests that exercise switching replace or reload this state."""
    from backend import config, output_folder

    # The default output folder lives under USER_DATA_DIR: point that at a temp
    # folder too, so a fallback to the default never reads the user's files.
    # test_user_data_dir checks USER_DATA_DIR against the import-time paths and
    # never touches the output folder, so it keeps the real value.
    if request.module.__name__.rsplit(".", 1)[-1] != "test_user_data_dir":
        monkeypatch.setattr(config, "USER_DATA_DIR", tmp_path_factory.mktemp("userdata"))
        # The prompt library is a module-level path: follow the temp folder too,
        # so no test can read or write the user's saved prompts.
        monkeypatch.setattr(config, "PROMPT_LIBRARY_PATH", config.USER_DATA_DIR / "prompt_library.json")
    monkeypatch.setattr(output_folder, "_state", output_folder.pinned_state(tmp_path_factory.mktemp("outputs")))
    yield
