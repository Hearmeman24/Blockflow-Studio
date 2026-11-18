from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from backend import config, db, media_meta, output_folder, prompt_library

router = APIRouter()


@router.get("/api/feature-flags")
def feature_flags() -> JSONResponse:
    return JSONResponse({"advanced": config.ADVANCED_MODE})


FLOW_SUFFIX = ".flow.json"
JSON_SUFFIX = ".json"
# Upper bound for one saved flow or workspace file, measured as the stored JSON.
MAX_FLOW_BYTES = 16 * 1024 * 1024


def _normalize_flow_name(raw_name: str) -> str:
    name = str(raw_name or "").strip()
    if not name:
        raise ValueError("flow name is required")

    # Accept pasted filename/path, but persist by basename only.
    name = name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if name.endswith(FLOW_SUFFIX):
        name = name[: -len(FLOW_SUFFIX)]
    elif name.endswith(JSON_SUFFIX):
        name = name[: -len(JSON_SUFFIX)]
    name = name.strip()

    if not name:
        raise ValueError("flow name is required")
    if name in {".", ".."} or "/" in name or "\\" in name:
        raise ValueError("invalid flow name")
    return name


def _flow_path_for_name(flow_name: str) -> tuple[str, Path]:
    normalized = _normalize_flow_name(flow_name)
    preferred = config.FLOWS_DIR / f"{normalized}{FLOW_SUFFIX}"
    legacy = config.FLOWS_DIR / f"{normalized}{JSON_SUFFIX}"

    if preferred.exists():
        return normalized, preferred
    if legacy.exists():
        return normalized, legacy
    return normalized, preferred


@router.get("/api/flows")
def api_flows_list() -> JSONResponse:
    best_by_name: dict[str, tuple[Path, int, float]] = {}
    for path in config.FLOWS_DIR.iterdir():
        if not path.is_file():
            continue
        if not (path.name.endswith(FLOW_SUFFIX) or path.name.endswith(JSON_SUFFIX)):
            continue
        try:
            name = _normalize_flow_name(path.name)
        except ValueError:
            continue

        rank = 1 if path.name.endswith(FLOW_SUFFIX) else 0
        mtime = path.stat().st_mtime
        existing = best_by_name.get(name)
        if not existing or rank > existing[1] or (rank == existing[1] and mtime > existing[2]):
            best_by_name[name] = (path, rank, mtime)

    flows: list[dict[str, Any]] = []
    for name in sorted(best_by_name.keys(), key=str.lower):
        path = best_by_name[name][0]
        stat = path.stat()
        flows.append(
            {
                "name": name,
                "filename": path.name,
                "updated_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                "size_bytes": stat.st_size,
            }
        )

    return JSONResponse({"ok": True, "flows": flows})


@router.get("/api/flows/{flow_name}")
def api_flows_get(flow_name: str) -> JSONResponse:
    try:
        normalized, path = _flow_path_for_name(flow_name)
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    if not path.exists():
        return JSONResponse({"ok": False, "error": "flow not found"}, status_code=404)

    try:
        flow = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"failed reading flow: {e}"}, status_code=500)

    return JSONResponse({"ok": True, "name": normalized, "filename": path.name, "flow": flow})


@router.post("/api/flows")
def api_flows_save(payload: dict[str, Any]) -> JSONResponse:
    try:
        normalized, path = _flow_path_for_name(str(payload.get("name") or ""))
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    flow = payload.get("flow")
    if not isinstance(flow, dict):
        return JSONResponse({"ok": False, "error": "flow must be a JSON object"}, status_code=400)

    serialized = json.dumps(flow, indent=2, ensure_ascii=True) + "\n"
    if len(serialized) > MAX_FLOW_BYTES:
        return JSONResponse(
            {"ok": False, "error": f"flow is too large (limit {MAX_FLOW_BYTES // (1024 * 1024)} MB)"},
            status_code=413,
        )

    overwritten = path.exists()
    try:
        config.FLOWS_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(serialized, encoding="utf-8")
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"failed saving flow: {e}"}, status_code=500)

    return JSONResponse(
        {
            "ok": True,
            "name": normalized,
            "filename": path.name,
            "overwritten": overwritten,
        }
    )


@router.delete("/api/flows/{flow_name:path}")
def api_flows_delete(flow_name: str) -> JSONResponse:
    try:
        normalized, path = _flow_path_for_name(flow_name)
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
    if not path.exists():
        return JSONResponse({"ok": False, "error": "flow not found"}, status_code=404)
    path.unlink()
    return JSONResponse({"ok": True})


@router.patch("/api/flows/{flow_name:path}")
def api_flows_rename(flow_name: str, payload: dict[str, Any] = {}) -> JSONResponse:
    try:
        _, old_path = _flow_path_for_name(flow_name)
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
    if not old_path.exists():
        return JSONResponse({"ok": False, "error": "flow not found"}, status_code=404)
    new_name = str(payload.get("name", "")).strip()
    if not new_name:
        return JSONResponse({"ok": False, "error": "new name required"}, status_code=400)
    try:
        new_normalized, new_path = _flow_path_for_name(new_name)
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
    old_path.rename(new_path)
    return JSONResponse({"ok": True, "name": new_normalized})


RUN_MEDIA_KINDS = ("video", "image", "other")
RUN_SOURCES = ("pipeline", "mcp")


def _multi_filter(value: str | None, allowed: tuple[str, ...]) -> frozenset[str] | None:
    """`a` or `a,b` → that set; None (no filter) when nothing valid is named or every allowed value is.

    Values outside `allowed` are dropped, as before: old links may carry kinds
    that were removed (lora, dataset) and still have to open.
    """
    items = frozenset(v.strip() for v in (value or "").split(",")) & frozenset(allowed)
    if not items or items == frozenset(allowed):
        return None
    return items


@router.get("/api/runs")
def api_runs_list(
    limit: int = Query(50),
    offset: int = Query(0),
    favorited: bool = Query(False),
    media_kind: str | None = Query(None),
    q: str | None = Query(None),
    hide_partial: bool = Query(False),
    source: str | None = Query(None),
    character: str | None = Query(None),
) -> JSONResponse:
    chars = [c.strip() for c in (character or "").split(",") if c.strip()]
    mk = _multi_filter(media_kind, RUN_MEDIA_KINDS)
    pq = q.strip() if q and q.strip() else None
    src = _multi_filter(source, RUN_SOURCES)
    total = db.count_runs(favorited_only=favorited, media_kind=mk, prompt_query=pq, hide_partial=hide_partial, source=src, character=chars)
    runs = db.list_runs(limit=limit, offset=offset, favorited_only=favorited, media_kind=mk, prompt_query=pq, hide_partial=hide_partial, source=src, character=chars)
    return JSONResponse({"ok": True, "runs": runs, "total": total, "limit": limit, "offset": offset})


@router.get("/api/runs/{run_id}")
def api_run_one(run_id: str) -> JSONResponse:
    run = db.get_run(run_id)
    if not run:
        return JSONResponse({"ok": False, "error": "run not found"}, status_code=404)
    return JSONResponse({"ok": True, "run": run})


@router.post("/api/runs")
def api_runs_create(payload: dict[str, Any]) -> JSONResponse:
    required = ("id", "name", "status", "flow_snapshot", "block_results", "created_at")
    missing = [k for k in required if k not in payload]
    if missing:
        return JSONResponse({"ok": False, "error": f"missing fields: {', '.join(missing)}"}, status_code=400)
    db.save_run(payload)
    return JSONResponse({"ok": True})


@router.patch("/api/runs/{run_id}/favorite")
def api_run_toggle_favorite(run_id: str) -> JSONResponse:
    result = db.toggle_run_favorited(run_id)
    if result is None:
        return JSONResponse({"ok": False, "error": "run not found"}, status_code=404)
    return JSONResponse({"ok": True, "favorited": result})


@router.delete("/api/runs/{run_id}")
def api_run_delete(run_id: str) -> JSONResponse:
    deleted = db.delete_run(run_id)
    if not deleted:
        return JSONResponse({"ok": False, "error": "run not found"}, status_code=404)
    return JSONResponse({"ok": True})


_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"}


@router.get("/api/images")
def api_images_list(limit: int = Query(60), offset: int = Query(0)) -> JSONResponse:
    """Recent generated images from the local outputs dir, newest-first, paginated.
    Powers the 'past generations' picker in the Upload Image block. Every generated
    image (UI runs + MCP) lands in this dir, so this is the flat 'all my generations'
    list. Videos and non-image files are excluded.

    ponytail: scandir + full sort per request — O(n log n) on the outputs dir, fine at
    personal scale (hundreds–thousands of files). Index by mtime if it ever gets huge.
    """
    # Current folder first, then earlier output folders; a name in the current
    # folder hides the same name in an earlier one (that's what /outputs serves).
    entries: list[tuple[str, float, int]] = []
    seen: set[str] = set()
    for root in output_folder.search_roots():
        try:
            with os.scandir(root) as it:
                for e in it:
                    if e.name in seen or not e.is_file() or os.path.splitext(e.name)[1].lower() not in _IMAGE_EXTS:
                        continue
                    try:
                        st = e.stat()
                    except OSError:
                        continue
                    seen.add(e.name)
                    entries.append((e.name, st.st_mtime, st.st_size))
        except (FileNotFoundError, NotADirectoryError, PermissionError):
            continue
    entries.sort(key=lambda x: x[1], reverse=True)
    total = len(entries)
    images = [
        {"url": f"/outputs/{name}", "name": name, "created_at": mtime, "size": size}
        for name, mtime, size in entries[offset : offset + limit]
    ]
    return JSONResponse({"ok": True, "images": images, "total": total, "limit": limit, "offset": offset})


@router.get("/api/file-metadata/{filename:path}")
def api_file_metadata(filename: str) -> JSONResponse:
    """Read embedded generation metadata from an output file."""
    try:
        local_file = output_folder.locate(filename)
    except output_folder.UnsafeOutputPath:
        return JSONResponse({"ok": False, "error": "File not found"}, status_code=404)
    if not local_file.is_file():
        return JSONResponse({"ok": False, "error": "File not found"}, status_code=404)
    meta = media_meta.read_metadata(local_file)
    if not meta:
        return JSONResponse({"ok": False, "has_meta": False})
    return JSONResponse({"ok": True, "has_meta": True, "meta": meta})


# ---------------------------------------------------------------------------
# Prompt library (logic in backend/prompt_library.py)
# ---------------------------------------------------------------------------

_LIBRARY_STATUS = {"validation": 422, "duplicate": 409, "not_found": 404, "corrupt": 500, "write_failed": 500}


def _library_error(exc: prompt_library.LibraryError) -> JSONResponse:
    return JSONResponse(
        {"ok": False, "kind": exc.kind, "error": exc.message},
        status_code=_LIBRARY_STATUS.get(exc.kind, 500),
    )


@router.get("/api/prompt-library")
def api_prompt_library_list() -> JSONResponse:
    try:
        return JSONResponse({"ok": True, "prompts": prompt_library.list_prompts()})
    except prompt_library.LibraryError as exc:
        return _library_error(exc)


@router.post("/api/prompt-library")
async def api_prompt_library_create(request: Request) -> JSONResponse:
    try:
        payload = json.loads(await request.body())
    except (ValueError, UnicodeDecodeError):
        # Never echo the body: it could hold anything the client sent.
        return _library_error(prompt_library.LibraryError("validation", "Send the prompt as JSON."))
    try:
        prompt = await run_in_threadpool(prompt_library.add_prompt, payload)
    except prompt_library.LibraryError as exc:
        return _library_error(exc)
    return JSONResponse({"ok": True, "prompt": prompt})


@router.delete("/api/prompt-library/{prompt_id}")
def api_prompt_library_delete(prompt_id: str) -> JSONResponse:
    try:
        prompt_library.delete_prompt(prompt_id)
    except prompt_library.LibraryError as exc:
        return _library_error(exc)
    return JSONResponse({"ok": True})

