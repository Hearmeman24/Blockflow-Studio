from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

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
_DIR_NAME = "BlockFlow Studio"
_DIR_SLUG = "blockflow-studio"


def resolve_user_data_dir() -> Path:
    """Resolution order:
      1. $BLOCKFLOW_DATA_DIR (explicit override; respected verbatim).
      2. $BLOCKFLOW_HOME (portable product home; respected verbatim).
      3. macOS:   ~/Library/Application Support/BlockFlow Studio
      3. Linux:   $XDG_DATA_HOME/blockflow-studio if set, else ~/.local/share/blockflow-studio
      4. Windows: %LOCALAPPDATA%\\BlockFlow Studio if set, else ~/AppData/Local/BlockFlow Studio
                  (LOCALAPPDATA is machine-local — right choice for a multi-GB
                  SQLite DB; APPDATA would sync via Windows roaming profiles.)
      5. Other:   ~/.blockflow-studio (catch-all so worktrees don't fragment).

    The names differ from the original BlockFlow app's folder on purpose: that
    folder holds the original app's database, which this app must not open.
    Nothing is migrated from it.
    """
    explicit = os.environ.get("BLOCKFLOW_DATA_DIR")
    if explicit:
        return Path(explicit).expanduser()
    home = os.environ.get("BLOCKFLOW_HOME")
    if home:
        return Path(home).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / _DIR_NAME
    if sys.platform.startswith("linux"):
        xdg = os.environ.get("XDG_DATA_HOME")
        if xdg:
            return Path(xdg) / _DIR_SLUG
        return Path.home() / ".local" / "share" / _DIR_SLUG
    if sys.platform == "win32" or sys.platform.startswith("cygwin"):
        local_appdata = os.environ.get("LOCALAPPDATA")
        if local_appdata:
            return Path(local_appdata) / _DIR_NAME
        return Path.home() / "AppData" / "Local" / _DIR_NAME
    return Path.home() / f".{_DIR_SLUG}"


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
RUN_HISTORY_DB_PATH = USER_DATA_DIR / "run_history.db"


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = val


_load_env_file(ROOT_DIR / ".env")

# Exposed to the frontend through GET /api/advanced.
ADVANCED_MODE = os.getenv("BLOCKFLOW_ADVANCED", "").strip().lower() in ("1", "true", "yes")
