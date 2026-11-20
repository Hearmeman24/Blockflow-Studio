"""The production web interface: when its build is current, and how it is made.

``uv run app.py`` serves the Next.js standalone server
(``frontend/.next/standalone/server.js``) and builds it first when the build
is missing or stale. The build is current when a stamp written next to the
server after a successful build matches a fingerprint of everything the build
bakes in:

- the frontend sources and config: ``frontend/src``, ``frontend/public``,
  ``frontend/scripts`` (the block codegen and the postbuild steps),
  ``package.json``, ``package-lock.json``, the installed packages
  (``node_modules/.package-lock.json``), ``next.config.ts``, ``tsconfig.json``,
  ``postcss.config.mjs`` and any ``frontend/.env*`` file Next.js loads;
- every block's frontend file (``custom_blocks/<slug>/frontend.block.tsx`` and
  ``private_blocks/<slug>/frontend.block.tsx``, the codegen's own rule);
- the backend port: Next.js fixes the ``/api`` and ``/outputs`` proxy target
  and ``NEXT_PUBLIC_BACKEND_PORT`` when it builds.

File contents are hashed (a timestamp change alone does not rebuild). The
files the codegen rewrites during every build (the block copies and the
registry) are left out: their sources are in the list. The stamp also records
the build's ``BUILD_ID``, so a build made some other way (``npm run build`` by
hand) never passes for the stamped one. When in doubt the answer is "stale":
a needless rebuild costs a minute, a false "current" serves old code.

Used by app.py, scripts/install_steps.py, scripts/doctor.py and the update
engine, so: standard library only, and Python 3.8 syntax at run time (the
doctor runs on whatever ``python3`` the user has).
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import time
from enum import Enum
from pathlib import Path
from typing import Dict, Iterator, List, Mapping, Optional

STAMP_FILE = ".blockflow-build.json"
BUILDING_FILE = ".blockflow-building"   # in frontend/; outside .next, which the build deletes
STAMP_SCHEME = 1                        # bump when the fingerprint's inputs change
BUILD_CMD = ["npm", "--prefix", "frontend", "run", "build"]
BUILD_TIMEOUT_S = 1800
DEFAULT_BACKEND_PORT = 47301

FRONTEND_FILES = ("package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "postcss.config.mjs",
                  "node_modules/.package-lock.json")
FRONTEND_TREES = ("src", "public", "scripts")
BLOCK_DIRS = ("custom_blocks", "private_blocks")
BLOCK_ENTRY = "frontend.block.tsx"
# Rewritten by the codegen during every build; derived from the block files above.
REGENERATED = ("src/components/pipeline/custom_blocks/generated/",
               "src/components/pipeline/custom_blocks/generated_private/",
               "src/components/pipeline/custom_blocks/_register.ts")
SKIPPED_DIRS = frozenset({"node_modules", "__pycache__", ".next"})


class BuildState(Enum):
    """The production build, as ``build_state`` sees it."""

    MISSING = "missing"   # no standalone server: never built, or a build failed part way
    STALE = "stale"       # a server, but no stamp, or a stamp for other inputs or another build
    CURRENT = "current"   # the stamp matches the inputs and the build that is there


def backend_port(environ: Mapping[str, str]) -> int:
    """BACKEND_PORT, or the default when it is unset or not a port (app.py
    refuses a bad value before anything is built)."""
    raw = (environ.get("BACKEND_PORT") or "").strip()
    try:
        port = int(raw)
    except ValueError:
        return DEFAULT_BACKEND_PORT
    return port if 1 <= port <= 65535 else DEFAULT_BACKEND_PORT


def build_env(environ: Mapping[str, str], port: int) -> Dict[str, str]:
    """The environment ``npm run build`` runs with: the caller's, with the
    backend port fixed for the proxy (next.config.ts) and the browser bundle, and
    Next.js telemetry off."""
    return {**environ, "BACKEND_PORT": str(port), "NEXT_PUBLIC_BACKEND_PORT": str(port),
            # Next.js sends anonymous telemetry unless told not to; this local app does not.
            "NEXT_TELEMETRY_DISABLED": "1"}


def standalone_server(frontend_dir: Path) -> Optional[Path]:
    """``.next/standalone/server.js``, or the first one nested below it (a
    monorepo-style trace root), or None."""
    standalone = Path(frontend_dir) / ".next" / "standalone"
    direct = standalone / "server.js"
    if direct.exists():
        return direct
    if not standalone.is_dir():
        return None
    matches = sorted(p for p in standalone.rglob("server.js") if "node_modules" not in p.parts)
    return matches[0] if matches else None


def stamp_path(root: Path) -> Path:
    server = standalone_server(Path(root) / "frontend")
    base = server.parent if server else Path(root) / "frontend" / ".next" / "standalone"
    return base / STAMP_FILE


def _regenerated(rel: str) -> bool:
    return any(rel.startswith(r) if r.endswith("/") else rel == r for r in REGENERATED)


def _input_files(root: Path) -> List[str]:
    """Every input, as sorted paths relative to ``root`` with ``/``."""
    root = Path(root)
    fe = root / "frontend"
    found: List[str] = []
    for name in FRONTEND_FILES:
        if (fe / name).is_file():
            found.append(f"frontend/{name}")
    try:
        found.extend(f"frontend/{p.name}" for p in fe.iterdir() if p.name.startswith(".env") and p.is_file())
    except OSError:
        pass
    for tree in FRONTEND_TREES:
        base = fe / tree
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in SKIPPED_DIRS]
            rel_dir = Path(dirpath).relative_to(fe).as_posix()
            for name in filenames:
                rel = f"{rel_dir}/{name}"
                if not _regenerated(rel):
                    found.append(f"frontend/{rel}")
    for blocks in BLOCK_DIRS:
        base = root / blocks
        try:
            slugs = [p for p in base.iterdir() if p.is_dir()]
        except OSError:
            continue
        found.extend(f"{blocks}/{p.name}/{BLOCK_ENTRY}" for p in slugs if (p / BLOCK_ENTRY).is_file())
    return sorted(set(found))


def fingerprint(root: Path, port: int) -> str:
    """A hash of every build input and the backend port. About 500 files, a
    few MB: tens of milliseconds."""
    root = Path(root)
    h = hashlib.sha256()
    h.update(f"scheme={STAMP_SCHEME}\0backend_port={port}\0".encode())
    for rel in _input_files(root):
        try:
            data = (root / rel).read_bytes()
        except OSError:
            data = b"\0unreadable\0"
        h.update(rel.encode("utf-8") + b"\0" + str(len(data)).encode() + b"\0")
        h.update(data)
    return h.hexdigest()


def _build_id(server: Path) -> Optional[str]:
    try:
        return (server.parent / ".next" / "BUILD_ID").read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def write_stamp(root: Path, fp: str, port: int) -> bool:
    """Record that the build now in place was made from inputs ``fp``
    (computed before the build started, so an edit during the build reads as
    stale). False when there is no build to stamp."""
    server = standalone_server(Path(root) / "frontend")
    build_id = _build_id(server) if server else None
    if server is None or build_id is None:
        return False
    data = {"scheme": STAMP_SCHEME, "fingerprint": fp, "build_id": build_id, "backend_port": port,
            "built_at": time.time()}
    path = server.parent / STAMP_FILE
    try:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        return False
    return True


def build_state(root: Path, port: int, fp: Optional[str] = None) -> BuildState:
    server = standalone_server(Path(root) / "frontend")
    if server is None:
        return BuildState.MISSING
    try:
        stamp = json.loads((server.parent / STAMP_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return BuildState.STALE
    if not isinstance(stamp, dict) or stamp.get("scheme") != STAMP_SCHEME:
        return BuildState.STALE
    if stamp.get("build_id") != _build_id(server):
        return BuildState.STALE
    if stamp.get("fingerprint") != (fp or fingerprint(root, port)):
        return BuildState.STALE
    return BuildState.CURRENT


# ------------------------------------------------------------------ build in progress


def building_marker(root: Path) -> Path:
    return Path(root) / "frontend" / BUILDING_FILE


@contextlib.contextmanager
def building(root: Path) -> Iterator[None]:
    """Mark a build as running (the doctor reads it), removed however it ends."""
    marker = building_marker(root)
    try:
        marker.write_text(str(os.getpid()), encoding="utf-8")
    except OSError:
        pass
    try:
        yield
    finally:
        try:
            marker.unlink()
        except OSError:
            pass


def building_since(root: Path, now: Optional[float] = None) -> Optional[float]:
    """When the running build started, or None. A marker older than the
    build timeout is left over from a crash and ignored."""
    try:
        started = building_marker(root).stat().st_mtime
    except OSError:
        return None
    now = time.time() if now is None else now
    return started if now - started <= BUILD_TIMEOUT_S else None
