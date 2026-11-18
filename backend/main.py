from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Iterable

from fastapi import APIRouter, FastAPI

from backend import (
    character_routes,
    characters,
    config,
    db,
    job_routes,
    mcp_runs,
    origin_guard,
    output_folder,
    routes,
    settings_routes,
    settings_store,
)
from backend.app_update import routes as app_update_routes
from backend.byok import pricing_routes as byok_pricing_routes
from backend.byok import routes as byok_routes
from backend.byok import service as byok_service

app = FastAPI(title="BlockFlow API")

# Only the app's own pages may call the API from a browser: CORS lists the
# app's origins and state-changing requests from other origins are refused
# (backend/origin_guard.py).
origin_guard.install(app)

app.include_router(routes.router)
app.include_router(settings_routes.router)
app.include_router(job_routes.router)
app.include_router(byok_routes.router)
app.include_router(byok_pricing_routes.router)
app.include_router(character_routes.router)
app.include_router(app_update_routes.router)

# Migrate user data out of ROOT_DIR on first launch. Must run
# BEFORE init_db() — that opens run_history.db, which the migration moves.
config.migrate_legacy_user_data(
    legacy_root=config.ROOT_DIR, user_data_dir=config.USER_DATA_DIR,
)

# Ensure the settings tables exist before any block sidecar (which may read
# Settings on import). Safe to call repeatedly — it's a no-op
# once the tables are present.
settings_store.init_db()
characters.init_db()

# The output folder (Settings → App / onboarding) is resolved at use time by
# backend.output_folder: a change applies immediately, and /outputs also
# reads earlier output folders so existing references keep working.
print(f"[config] output folder: {output_folder.current()}")


def _prune_run_history_on_startup() -> None:
    """Apply the user's retention setting to the run history table on launch.

    Reads `run_history_retention_days` from app_prefs. Accepts:
      - integer days as a string (e.g. "30", "90", "365")
      - the literal "forever" → skip pruning
    Unset → fall back to 90 days (the documented default in the UI).
    Invalid values → log and skip.
    """
    # Ensure the runs table exists before we try to delete from it. db.init_db
    # is idempotent.
    db.init_db()

    raw = settings_store.get_app_pref("run_history_retention_days", default="90")
    if raw == "forever":
        return
    try:
        days = int(raw or "90")
    except ValueError:
        print(f"[run-history] invalid retention pref '{raw}'; skipping prune")
        return
    deleted = db.prune_runs_older_than(days)
    if deleted:
        print(f"[run-history] pruned {deleted} run(s) older than {days} days")


_prune_run_history_on_startup()


def _resume_generation_jobs_on_startup() -> dict[str, list[str]] | None:
    """Settle generation jobs a previous process left active, then re-attach
    polling (never resubmitting) to the ones a provider already accepted.
    `byok_service.resume_pending()` runs the job store's restart recovery
    first, so jobs with no remote_job_id become FAILED/interrupted. Never
    raises: a broken job table must not stop the app booting."""
    try:
        summary = byok_service.resume_pending()
    except Exception as exc:
        print(f"[jobs] startup recovery/resume failed: {type(exc).__name__}: {exc}", flush=True)
        return None
    if summary["failed"] or summary["resumed"]:
        print(
            f"[jobs] {len(summary['failed'])} interrupted job(s) marked failed, "
            f"{len(summary['resumed'])} resumed",
            flush=True,
        )
    return summary


def _save_mcp_runs_on_startup():
    """Save an Artifacts run whenever an MCP job ends (backend/mcp_runs.py):
    listen first, so jobs resumed below are covered, then save runs for MCP
    jobs that ended while the app was not listening. Returns the unsubscribe
    function. Never raises."""
    unsubscribe = mcp_runs.install()
    try:
        saved = mcp_runs.sweep()
    except Exception as exc:
        print(f"[jobs] saving runs for MCP jobs failed: {type(exc).__name__}: {exc}", flush=True)
        return unsubscribe
    if saved:
        print(f"[jobs] saved {len(saved)} MCP run(s) to the run history", flush=True)
    return unsubscribe


# Skipped under pytest so importing the app never rewrites the user's real
# job table or starts polling; tests call the functions against tmp_path.
if "pytest" not in sys.modules:
    app_update_routes.on_startup()  # report how an update before a restart ended
    _save_mcp_runs_on_startup()
    _resume_generation_jobs_on_startup()


def _discover_sidecars(dirs: Iterable[tuple[Path, str]]) -> list[tuple[str, str, Path]]:
    """Walk each (root, source_label) pair; collect candidate (slug, source, backend_entry).

    Returns sidecars sorted by slug. Raises on cross-dir slug collision so the
    loader can fail before any router is mounted (all-or-nothing semantics).

    A dir that doesn't exist is treated as empty.
    A block dir without `backend.block.py` is skipped (frontend-only block).
    """
    by_slug: dict[str, tuple[str, Path]] = {}  # slug -> (source, backend_entry)
    collisions: list[tuple[str, str, str]] = []  # (slug, source_a, source_b)

    for blocks_root, source in dirs:
        if not blocks_root.exists():
            continue
        for block_dir in sorted(blocks_root.iterdir(), key=lambda p: p.name):
            if not block_dir.is_dir():
                continue
            slug = block_dir.name
            backend_entry = block_dir / "backend.block.py"
            if not backend_entry.exists():
                continue
            if slug in by_slug:
                prior_source, _ = by_slug[slug]
                collisions.append((slug, prior_source, source))
            else:
                by_slug[slug] = (source, backend_entry)

    if collisions:
        lines = [f"  - '{slug}' exists in both {a}/ and {b}/" for slug, a, b in collisions]
        raise RuntimeError(
            "[custom-blocks] slug collision across source dirs (rename to disambiguate):\n"
            + "\n".join(lines)
        )

    return sorted(
        ((slug, source, entry) for slug, (source, entry) in by_slug.items()),
        key=lambda t: t[0],
    )


def load_block_sidecars(target_app: FastAPI, dirs: Iterable[tuple[Path, str]]) -> list[str]:
    """Discover + mount backend sidecars from each (root, source_label) pair.

    Mounts each sidecar's `router` at `/api/blocks/<slug>`. Returns the
    loaded slugs (sorted). Raises RuntimeError on:
      - slug collision across source dirs (raised before any mount)
      - sidecar missing the `router` export
      - sidecar `router` not an APIRouter
      - sidecar import failure
    """
    sidecars = _discover_sidecars(dirs)
    loaded: list[str] = []

    for slug, source, backend_entry in sidecars:
        module_name = "custom_block_" + "".join(ch if ch.isalnum() else "_" for ch in slug) + "_backend"
        spec = importlib.util.spec_from_file_location(module_name, backend_entry)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"[custom-blocks] {slug}: failed to create import spec from {backend_entry}")

        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        except Exception as exc:
            raise RuntimeError(f"[custom-blocks] {slug}: failed importing {backend_entry}: {exc}") from exc

        router = getattr(module, "router", None)
        if router is None:
            raise RuntimeError(f"[custom-blocks] {slug}: backend sidecar must export `router`")
        if not isinstance(router, APIRouter):
            raise RuntimeError(f"[custom-blocks] {slug}: `router` must be APIRouter, got {type(router)}")

        prefix = f"/api/blocks/{slug}"
        target_app.include_router(router, prefix=prefix)
        loaded.append(slug)
        print(f"[custom-blocks] {slug}: loaded from {source}/ at {prefix}")

    if loaded:
        print(f"[custom-blocks] loaded backend sidecars: {', '.join(loaded)}")
    else:
        print("[custom-blocks] no backend sidecars loaded")

    return loaded


load_block_sidecars(
    app,
    [
        (config.ROOT_DIR / "custom_blocks", "custom_blocks"),
        (config.ROOT_DIR / "private_blocks", "private_blocks"),
    ],
)
app.mount("/outputs", output_folder.OutputsStaticFiles(), name="outputs")
