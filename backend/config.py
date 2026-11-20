from __future__ import annotations

import os
import shutil
from pathlib import Path

from backend.app_update import launcher_protocol
from backend.app_update.launcher_protocol import read_env_file

APP_TITLE = "BlockFlow"
ROOT_DIR = Path(__file__).resolve().parent.parent


# === User data lives outside the running checkout ============================
#
# In older builds every user-data file (prompt_library.json, run_history.db,
# flows/, output/, …) was rooted at ROOT_DIR. Each git worktree got its own
# isolated copy, and launching the app from a worktree silently swapped in
# fresh empty state. Now resolved to a stable platform location and migrated
# from the legacy ROOT_DIR layout on first launch.

# Default user-data folder names (see resolve_user_data_dir).
_DIR_NAME = launcher_protocol.DIR_NAME
_DIR_SLUG = launcher_protocol.DIR_SLUG


def resolve_user_data_dir() -> Path:
    """The user data folder (resolution order in
    ``launcher_protocol.resolve_user_data_dir``, which app.py shares to find
    the settings database without importing this module)."""
    return launcher_protocol.resolve_user_data_dir(os.environ)


def ensure_directory(path: Path) -> Path:
    """Create path, replacing a dangling symlink with a real directory.

    Users can move output storage to external volumes. If that volume is
    later unmounted, the configured output directory may be a dangling
    symlink; Path.mkdir(exist_ok=True) raises FileExistsError in that case.
    """
    try:
        path.mkdir(parents=True, exist_ok=True)
    except FileExistsError:
        if path.is_symlink() and not path.exists():
            print(f"[config] {path} is a dangling symlink; replacing with a local directory")
            path.unlink()
            path.mkdir(parents=True, exist_ok=True)
        else:
            raise
    return path


# Files that lived under ROOT_DIR in older builds and must follow the user
# across worktrees / checkouts. List comprehension keeps the migration loop
# below in lockstep with the path constants below.
_LEGACY_USER_FILES: tuple[str, ...] = (
    "prompt_library.json",
    "run_history.db",
)
_LEGACY_USER_DIRS: tuple[str, ...] = (
    "flows",
    "output",
)
_MIGRATION_BREADCRUMB = ".migrated_from_root"


def migrate_legacy_user_data(*, legacy_root: Path, user_data_dir: Path) -> None:
    """One-shot migration from the older in-checkout layout. Idempotent via a
    breadcrumb file in the target dir.

    Safety rules:
      - Never clobber a target that already exists — the legacy file is left
        on disk so the user can reconcile manually.
      - The breadcrumb is written even when no legacy data was found, so
        we don't re-scan ROOT_DIR forever on every launch.
    """
    user_data_dir.mkdir(parents=True, exist_ok=True)
    breadcrumb = user_data_dir / _MIGRATION_BREADCRUMB
    if breadcrumb.exists():
        return

    for name in _LEGACY_USER_FILES:
        legacy = legacy_root / name
        current = user_data_dir / name
        if legacy.exists() and not current.exists():
            shutil.move(str(legacy), str(current))

    for name in _LEGACY_USER_DIRS:
        legacy = legacy_root / name
        current = user_data_dir / name
        if not legacy.is_dir():
            continue
        if not current.exists():
            shutil.move(str(legacy), str(current))
            continue
        # Target exists — merge legacy contents into it, never clobber.
        # Important: a stub target (created by config.py's import-time mkdir
        # plus subdirs added by custom_blocks on import) counts as "non-empty"
        # but holds no real user data. Merging item-by-item is the right
        # semantic: each legacy entry lands at target/<name> only when there's
        # no existing entry there, so real user data is preserved either way.
        for item in legacy.iterdir():
            target_item = current / item.name
            if target_item.exists():
                continue  # conflict — leave legacy item alone
            shutil.move(str(item), str(target_item))
        # Best-effort cleanup of the now-(probably-)empty legacy dir.
        try:
            legacy.rmdir()
        except OSError:
            pass  # legacy still has conflicts in it — leave for owner

    breadcrumb.write_text(
        "One-shot user data migration marker — delete to re-run migration.\n",
        encoding="utf-8",
    )


USER_DATA_DIR = resolve_user_data_dir()
ensure_directory(USER_DATA_DIR)
# Migration is NOT run at import time on purpose: pytest collection imports
# backend.config and would otherwise trigger the side-effecting move against
# the user's real user data folder on first test run.
# main.py calls migrate_legacy_user_data(...) once at process startup.

def output_dir() -> Path:
    """The output folder in effect right now (see backend/output_folder.py).

    Resolved at every call: changing the folder in Settings or onboarding takes
    effect immediately, so never keep the result in a module-level constant.
    """
    from backend import output_folder

    return output_folder.current()


def __getattr__(name: str):
    # Compatibility for code (e.g. private blocks) written against the old
    # constant: resolved at access time, so it is never a stale copy.
    if name == "LOCAL_OUTPUT_DIR":
        return output_dir()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


FLOWS_DIR = USER_DATA_DIR / "flows"
ensure_directory(FLOWS_DIR)
PROMPT_LIBRARY_PATH = USER_DATA_DIR / "prompt_library.json"
RUN_HISTORY_DB_PATH = USER_DATA_DIR / launcher_protocol.SETTINGS_DB_NAME


def _load_env_file(path: Path) -> None:
    """Values from ``path`` for names the environment does not set. The parser
    is shared with app.py, so both agree on what the file says."""
    for key, val in read_env_file(path).items():
        if key not in os.environ:
            os.environ[key] = val


_load_env_file(ROOT_DIR / ".env")

# Exposed to the frontend through GET /api/advanced.
ADVANCED_MODE = os.getenv("BLOCKFLOW_ADVANCED", "").strip().lower() in ("1", "true", "yes")
