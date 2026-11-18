"""Output folder: the single source of truth, validation and status.

Generated images and videos and the files users add to loaders are written to
the output folder and served at `/outputs`. The `output_dir` app pref
overrides the default (`<user data dir>/output`).

Runtime (no restart needed):
  - `current()`      the folder new files go to, resolved at every call. A saved
                     folder that has disappeared (unplugged drive) falls back
                     to the default.
  - `search_roots()` `current()` plus earlier output folders, most recent first
                     (the `output_dir_previous` pref, capped), skipping any
                     that no longer exist. `/outputs/<path>` is looked up in
                     this order, so references into an earlier folder keep
                     working after a switch.
  - `locate()`       maps an `/outputs/...` value to a file with that lookup;
                     traversal and symlink escapes are refused per folder.
  - `switch_to()`    saves a new folder and takes effect at once; the folder
                     it replaces is remembered for reading.
  - `OutputsStaticFiles` serves `/outputs` from `search_roots()` per request.

Writers resolve the folder when they start writing: a download in flight when
the folder changes finishes in the folder it started in, and is still served
because that folder is now an earlier folder. Nothing is moved or deleted.

`validate_output_folder` checks a user-typed or dialog-chosen path:
absolute, `~` expanded, normalised; not a filesystem root, a system folder,
the app's install folder or the user data folder itself; created when
missing; a directory; writable (a temp file is created and removed). Windows
rules use `ntpath`/`PureWindowsPath`, selected with `windows=True`, so they
can be tested on any OS with a fake `fs`. Messages only ever quote the path.
"""
from __future__ import annotations

import json
import ntpath
import os
import posixpath
import sys
import tempfile
import threading
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Protocol
from urllib.parse import unquote

from starlette.staticfiles import StaticFiles

from backend import config

OUTPUT_DIR_PREF = "output_dir"
PREVIOUS_PREF = "output_dir_previous"
MAX_PREVIOUS = 8
OUTPUTS_PREFIX = "/outputs/"
MAX_PATH_LENGTH = 1024

_POSIX_SYSTEM_TREES = (
    "/System", "/bin", "/sbin", "/usr", "/etc", "/dev", "/proc", "/sys", "/boot",
    "/Library", "/Applications", "/private/etc", "/private/var/db", "/cores", "/lib", "/lib64",
)
# Folders that hold other users' or volumes' folders: choose a folder inside.
_POSIX_CONTAINERS = (
    "/Users", "/home", "/Volumes", "/var", "/private", "/private/var", "/tmp", "/private/tmp",
    "/opt", "/mnt", "/media", "/srv", "/root", "/run",
)
_WINDOWS_BAD_CHARS = set('<>:"|?*')


class InvalidOutputFolder(ValueError):
    """The path can't be used. The message is shown to the user as-is."""


class FS(Protocol):
    def makedirs(self, path: str) -> None: ...
    def is_dir(self, path: str) -> bool: ...
    def probe_write(self, path: str) -> None: ...
    def realpath(self, path: str) -> str: ...


class RealFS:
    def makedirs(self, path: str) -> None:
        os.makedirs(path, exist_ok=True)

    def is_dir(self, path: str) -> bool:
        return os.path.isdir(path)

    def probe_write(self, path: str) -> None:
        fd, name = tempfile.mkstemp(prefix=".blockflow-write-test-", dir=path)
        os.close(fd)
        os.remove(name)

    def realpath(self, path: str) -> str:
        return os.path.realpath(path)


def default_output_dir() -> Path:
    return config.USER_DATA_DIR / "output"


def _inside(path, parent) -> bool:
    return path == parent or path.is_relative_to(parent)


def _example(windows: bool) -> str:
    return r"C:\Users\you\BlockFlow" if windows else "/Users/you/BlockFlow"


def validate_output_folder(
    raw: str,
    *,
    windows: bool | None = None,
    env: Mapping[str, str] | None = None,
    home: str | None = None,
    fs: FS | None = None,
    app_dirs: Iterable[str] | None = None,
    data_dir: str | None = None,
) -> str:
    """Return the normalised absolute folder path, created and writable."""
    windows = (sys.platform == "win32") if windows is None else windows
    env = os.environ if env is None else env
    fs = fs or RealFS()
    flavour = ntpath if windows else posixpath
    Pure = PureWindowsPath if windows else PurePosixPath
    home = home if home is not None else os.path.expanduser("~")
    app_dirs = [str(config.ROOT_DIR)] if app_dirs is None else list(app_dirs)
    data_dir = str(config.USER_DATA_DIR) if data_dir is None else data_dir

    text = (raw or "").strip()
    if not text:
        raise InvalidOutputFolder("Enter a folder path, or choose one.")
    if len(text) > MAX_PATH_LENGTH or any(ord(c) < 32 or c == "\x7f" for c in text):
        raise InvalidOutputFolder("That path contains characters that can't be used in a folder name.")

    if text == "~" or text.startswith("~/") or (windows and text.startswith("~\\")):
        text = home + text[1:]
    pure = Pure(text)
    absolute = bool(pure.drive and pure.root) if windows else text.startswith("/")
    if not absolute:
        raise InvalidOutputFolder(f"Use a full folder path, such as {_example(windows)}.")

    normalised = flavour.normpath(text)
    if not windows and normalised.startswith("//"):
        normalised = "/" + normalised.lstrip("/")
    path = Pure(normalised)
    shown = str(path)

    if windows and any(_WINDOWS_BAD_CHARS & set(part) for part in path.parts[1:]):
        raise InvalidOutputFolder("That path contains characters that can't be used in a folder name.")

    def check_reserved(candidate) -> None:
        if candidate == Pure(candidate.anchor):
            raise InvalidOutputFolder("That is the top of the drive. Choose or create a folder inside it.")
        if windows:
            drive = candidate.drive
            system = [env.get("SystemRoot") or f"{drive}\\Windows", env.get("ProgramFiles"),
                      env.get("ProgramFiles(x86)"), env.get("ProgramData"), env.get("ProgramW6432")]
            trees = [Pure(p) for p in system if p]
            containers = [Pure(f"{drive}\\Users")]
        else:
            trees = [Pure(p) for p in _POSIX_SYSTEM_TREES]
            containers = [Pure(p) for p in _POSIX_CONTAINERS]
        if any(candidate == c for c in containers):
            raise InvalidOutputFolder(f"{shown} holds other folders. Choose or create a folder inside it.")
        if any(_inside(candidate, t) for t in trees):
            raise InvalidOutputFolder(
                f"{shown} is a system folder. Choose a folder in your home folder or on another drive.")
        if any(_inside(candidate, Pure(a)) for a in app_dirs):
            raise InvalidOutputFolder(
                f"{shown} is inside BlockFlow's own install folder, which updates can replace. "
                "Choose a different folder.")
        if candidate == Pure(data_dir):
            raise InvalidOutputFolder(
                f"{shown} holds BlockFlow's settings and history. Choose a folder inside it or somewhere else.")

    check_reserved(path)

    try:
        fs.makedirs(shown)
    except (FileExistsError, NotADirectoryError):
        raise InvalidOutputFolder(f"That path points to a file, not a folder: {shown}") from None
    except PermissionError:
        raise InvalidOutputFolder(
            f"BlockFlow isn't allowed to create {shown}. Choose a folder you can write to.") from None
    except OSError as exc:
        raise InvalidOutputFolder(f"{shown} could not be created ({exc.strerror or 'system error'}).") from None
    if not fs.is_dir(shown):
        raise InvalidOutputFolder(f"That path points to a file, not a folder: {shown}")

    # A symlink (or macOS's /etc -> /private/etc) must not lead somewhere reserved.
    resolved = Pure(fs.realpath(shown))
    if resolved != path:
        check_reserved(resolved)

    try:
        fs.probe_write(shown)
    except OSError:
        raise InvalidOutputFolder(f"That folder is read-only: {shown}. Choose a folder you can write to.") from None
    return shown


# === runtime state ==========================================================


class UnsafeOutputPath(ValueError):
    """An /outputs value that escapes every output folder."""


@dataclass(frozen=True)
class _State:
    configured: Path | None  # the saved choice; None = default
    previous: tuple[Path, ...]  # earlier folders, most recent first


_state: _State | None = None  # None = not loaded from prefs yet
_lock = threading.RLock()


def _store():
    from backend import settings_store

    return settings_store


def _parse_previous(raw: str | None) -> tuple[Path, ...]:
    try:
        items = json.loads(raw) if raw else []
    except ValueError:
        return ()
    if not isinstance(items, list):
        return ()
    out: list[Path] = []
    for item in items:
        if isinstance(item, str) and item.strip() and Path(item) not in out:
            out.append(Path(item))
    return tuple(out[:MAX_PREVIOUS])


def _load() -> _State:
    global _state
    with _lock:
        if _state is None:
            store = _store()
            raw = store.get_app_pref(OUTPUT_DIR_PREF)
            configured = Path(raw).expanduser() if raw and raw.strip() else None
            _state = _State(configured, _parse_previous(store.get_app_pref(PREVIOUS_PREF)))
        return _state


def pinned_state(folder: Path | str | None, previous: Iterable[Path | str] = ()) -> _State:
    """An in-memory state (no prefs) for tests: monkeypatch `_state` with it."""
    return _State(Path(folder) if folder else None, tuple(Path(p) for p in previous))


def reload() -> None:
    """Forget the in-memory state; the next call reads the prefs again."""
    global _state
    with _lock:
        _state = None


def configured() -> Path | None:
    return _load().configured


def previous() -> list[Path]:
    return list(_load().previous)


def current() -> Path:
    """The folder new files go to right now."""
    chosen = _load().configured
    if chosen is not None and chosen.is_dir():
        return chosen
    return config.ensure_directory(default_output_dir())


def search_roots() -> list[Path]:
    """Folders `/outputs/...` is read from: current first, then earlier ones."""
    roots = [current()]
    for folder in _load().previous:
        if folder not in roots and folder.is_dir():
            roots.append(folder)
    return roots


def switch_to(folder: str | None) -> None:
    """Make `folder` (already validated) the output folder now; None/"" = default.
    The folder it replaces is remembered so its files stay readable."""
    global _state
    with _lock:
        old = current()
        new_configured = Path(folder) if folder else None
        new_effective = new_configured or default_output_dir()
        history = [old, *_load().previous]
        kept: list[Path] = []
        for item in history:
            if item != new_effective and item not in kept:
                kept.append(item)
        kept = kept[:MAX_PREVIOUS]
        store = _store()
        store.set_app_pref(OUTPUT_DIR_PREF, str(new_configured) if new_configured else "")
        store.set_app_pref(PREVIOUS_PREF, json.dumps([str(p) for p in kept]))
        _state = _State(new_configured, tuple(kept))


def forget_previous(folder: str) -> bool:
    """Stop reading an earlier folder. Its files are not touched."""
    global _state
    with _lock:
        state = _load()
        target = Path(folder)
        if target not in state.previous:
            return False
        kept = tuple(p for p in state.previous if p != target)
        _store().set_app_pref(PREVIOUS_PREF, json.dumps([str(p) for p in kept]))
        _state = _State(state.configured, kept)
        return True


def _relative(value: str) -> str:
    text = value.strip()
    if text.startswith(OUTPUTS_PREFIX):
        text = text[len(OUTPUTS_PREFIX):]
    text = unquote(text.split("?", 1)[0].split("#", 1)[0])
    if "\x00" in text or not text or text.startswith(("/", "\\")):
        raise UnsafeOutputPath("The path is not inside the BlockFlow output folder.")
    return text


def _inside_root(root: Path, rel: str) -> Path | None:
    """`root/rel` resolved, or None when it escapes `root` (.., symlinks)."""
    base = Path(os.path.realpath(root))
    candidate = Path(os.path.realpath(base / rel))
    if candidate == base or not candidate.is_relative_to(base):
        return None
    return candidate


def locate(value: str) -> Path:
    """The file for an `/outputs/...` value (or a path relative to the output
    folder): the first folder in `search_roots()` that has it, else where it
    would be in the current folder. Raises UnsafeOutputPath on escapes."""
    rel = _relative(value)
    roots = search_roots()
    fallback: Path | None = None
    for index, root in enumerate(roots):
        candidate = _inside_root(root, rel)
        if candidate is None:
            continue
        if candidate.is_file():
            return Path(os.path.normpath(root / rel))
        if index == 0:
            fallback = Path(os.path.normpath(root / rel))
    if fallback is None:
        raise UnsafeOutputPath("The path is not inside the BlockFlow output folder.")
    return fallback


def containing_root(path: Path) -> Path | None:
    """The output folder (current or earlier) that contains `path`."""
    resolved = Path(os.path.realpath(path))
    for root in search_roots():
        base = Path(os.path.realpath(root))
        if resolved != base and resolved.is_relative_to(base):
            return base
    return None


def to_outputs_url(path: Path) -> str | None:
    """`/outputs/<rel>` for a file inside any output folder, else None."""
    base = containing_root(path)
    if base is None:
        return None
    return OUTPUTS_PREFIX + Path(os.path.realpath(path)).relative_to(base).as_posix()


class OutputsStaticFiles(StaticFiles):
    """`/outputs` served from `search_roots()`, resolved per request.

    Starlette's StaticFiles does the rest: range requests, content types,
    ETag/Last-Modified, and refusing paths whose real location (after
    symlinks) is outside the folder being searched.
    """

    def __init__(self) -> None:
        super().__init__(directory=None, check_dir=False, follow_symlink=False)

    @property
    def all_directories(self) -> list[str]:  # type: ignore[override]
        try:
            return [str(p) for p in search_roots()]
        except OSError:
            return []

    @all_directories.setter
    def all_directories(self, _value) -> None:
        pass


def output_folder_status(store, picker: dict[str, Any]) -> dict[str, Any]:
    """What the UI shows: the folder in use now, the default, the saved
    choice (and whether it is missing), and the earlier folders still read."""
    chosen = configured()
    return {
        "in_use": str(current()),
        "default": str(default_output_dir()),
        "configured": str(chosen) if chosen else None,
        "configured_unavailable": bool(chosen and not chosen.is_dir()),
        "previous": [{"path": str(p), "available": p.is_dir()} for p in previous()],
        "picker": picker,
    }
