"""Save a run in the Artifacts history for every generation job the MCP server
submitted (``source: "mcp"``).

The Artifacts page lists runs, which the frontend pipeline runner saves for
its own runs. MCP jobs never pass through the frontend, so the backend saves
their run here when the job ends:

- COMPLETED -> a ``completed`` run holding the outputs.
- FAILED / TIMED_OUT -> a ``failed`` run (the pipeline records failed runs too).
- CANCELLED -> no run (a cancelled pipeline run records no failure either).

Each run has the id ``run-mcp-<job_id>`` (the prefix the Artifacts MCP filter
matches), the same ``block_results`` shape the pipeline produces, and a
``flow_snapshot`` that Restore opens as a working pipeline: the loader that
holds the references, the matching generation block with provider, model,
prompt and settings, and the matching viewer.

Exactly once per job, also across restarts: a row in ``mcp_job_runs`` is
written in the same transaction as the run. A run the user later deletes is
not brought back. ``sweep()`` at startup saves runs for MCP jobs that ended
while no hook was listening.

Public API: ``build_flow_snapshot(job)``, ``build_run(job)``,
``save_run_for_job(job)``, ``on_job_event(event)``, ``install(store)``,
``sweep(store)``, ``init_db()``.
"""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import unquote, urlsplit

from backend import db, job_store
from backend.byok.spec import canonical_kind
from backend.statuses import BlockResultStatus, JobStatus, RunStatus

logger = logging.getLogger(__name__)

SOURCE = "mcp"
RUN_PREFIX = db._MCP_RUN_PREFIX
# Job statuses that get a run (CANCELLED gets none). blockflow_mcp/tools_jobs.py
# keeps a copy (RUN_RECORDED); tests/test_mcp_status_contract.py keeps them equal.
RUN_RECORDED_STATUSES: tuple[JobStatus, ...] = (JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.TIMED_OUT)
MARKER_TABLE = "mcp_job_runs"
# frontend/src/lib/pipeline/flow-migrations.ts CURRENT_FLOW_SCHEMA_VERSION; the
# Vitest snapshot test fails if the two drift apart.
FLOW_SCHEMA_VERSION = 6
SWEEP_LIMIT = job_store.MAX_LIST_LIMIT

IMAGE_LOADER = ("uploadImageToTmpfiles", "Image Loader")
OMNI_LOADER = ("omniReferenceLoader", "Omni Reference Loader")
VIEWERS = {"image": ("imageViewer", "Image Viewer"), "video": ("videoViewer", "Video Viewer")}
# mode -> (block type, label, output kind, loader or None)
GENERATION_BLOCKS: dict[str, tuple[str, str, str, tuple[str, str] | None]] = {
    "text_to_image": ("textToImage", "Text to Image", "image", None),
    "image_to_image": ("imageToImage", "Image to Image", "image", IMAGE_LOADER),
    "text_to_video": ("textToVideo", "Text to Video", "video", None),
    "image_to_video": ("imageToVideo", "Image to Video", "video", IMAGE_LOADER),
    "omni_reference_to_video": ("omniReferenceToVideo", "Omni Reference to Video", "video", OMNI_LOADER),
}
OMNI_KEYS = {"video": "video_items", "image": "image_items", "audio": "audio_items"}
REF_KINDS = {"image": "image-ref", "video": "video-ref", "audio": "audio-ref"}
_FRAME_ORDER = {"first_frame": 0, "last_frame": 1}
_ITEM_NUMBERS = ("size_bytes", "width", "height", "duration_s")

_lock = threading.Lock()


# ------------------------------------------------------------------ helpers


def _is_http(value: Any) -> bool:
    return isinstance(value, str) and value.strip().lower().startswith(("http://", "https://"))


def _app_local(value: Any) -> str | None:
    """An ``/outputs/...`` path for a local reference value (absolute paths under
    the output folder are rewritten), or None when it is not a safe local file."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.startswith("/outputs/"):
        return text
    from backend import output_folder
    from backend.byok import references

    try:
        resolved = references.resolve_local(text)
    except (references.UnsafePathError, ValueError, OSError):
        return None
    return output_folder.to_outputs_url(resolved)


def _label(local: str | None, url: str | None, fallback: str) -> str:
    for value in (local, url):
        if value:
            name = PurePosixPath(unquote(urlsplit(value).path)).name
            if name:
                return name
    return fallback


def _items(job_id: str, refs: list[Mapping[str, Any]], kind: str) -> list[dict[str, Any]]:
    """Loader items (frontend LoaderItem) for the references of one kind."""
    out: list[dict[str, Any]] = []
    # A job stored before sound became one kind may hold "voice": it is audio.
    for i, ref in enumerate(r for r in refs if canonical_kind(r.get("kind")) == kind):
        local = _app_local(ref.get("local"))
        url = ref.get("url").strip() if _is_http(ref.get("url")) else None
        if not local and not url:
            continue
        item_id = f"mcp-{job_id[:12]}-{kind}-{i}"
        item: dict[str, Any] = {"id": item_id, "label": _label(local, url, item_id), "status": "ready"}
        if local:
            item["local"] = local
        if url:
            item["url"] = url
        for key in _ITEM_NUMBERS:
            value = ref.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                item[key] = value
        if isinstance(ref.get("format"), str) and ref["format"]:
            item["format"] = ref["format"]
        out.append(item)
    return out


def _references(job: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    refs = (job.get("request") or {}).get("references")
    return [r for r in refs if isinstance(r, Mapping)] if isinstance(refs, list) else []


def _loader_config(job: Mapping[str, Any], loader: tuple[str, str]) -> dict[str, list[dict[str, Any]]]:
    refs = _references(job)
    job_id = str(job.get("job_id") or "job")
    if loader == OMNI_LOADER:
        return {key: _items(job_id, refs, kind) for kind, key in OMNI_KEYS.items()}
    if job.get("mode") == "image_to_video":
        # Image to Video gives the first loaded image the first frame, the second the last.
        refs = sorted(refs, key=lambda r: _FRAME_ORDER.get(str(r.get("role")), 2))
    return {"items": _items(job_id, refs, "image")}


def _loader_has_items(config: Mapping[str, list[Any]]) -> bool:
    return any(config.values())


def _generation_config(job: Mapping[str, Any]) -> dict[str, Any]:
    params = (job.get("request") or {}).get("params")
    params = params if isinstance(params, Mapping) else {}
    settings = params.get("settings")
    prompt = params.get("prompt")
    return {
        "provider": job.get("provider"),
        "model": job.get("model"),
        "prompt": prompt if isinstance(prompt, str) else "",
        "use_upstream_prompt": False,
        "params": {
            "duration": params.get("duration"),
            "resolution": params.get("resolution"),
            "aspect_ratio": params.get("aspect_ratio"),
            "settings": dict(settings) if isinstance(settings, Mapping) else {},
        },
    }


def _iso(epoch: Any) -> str:
    try:
        return db.normalize_created_at(float(epoch))
    except (TypeError, ValueError):
        return db.normalize_created_at(None)


# ------------------------------------------------------------------ snapshot


def build_flow_snapshot(job: Mapping[str, Any]) -> dict[str, Any]:
    """A saved flow (frontend SavedFlow, current schema) that rebuilds the job
    as a pipeline: [loader] -> generation block -> viewer."""
    gen_type, _gen_label, output_kind, loader = GENERATION_BLOCKS[str(job.get("mode"))]
    blocks: list[dict[str, Any]] = []
    if loader is not None:
        config = _loader_config(job, loader)
        if _loader_has_items(config):
            blocks.append({"type": loader[0], "config": config})
    blocks.append({"type": gen_type, "config": _generation_config(job)})
    blocks.append({"type": VIEWERS[output_kind][0]})
    return {
        "name": "MCP Run",
        "version": 1,
        "schema_version": FLOW_SCHEMA_VERSION,
        "created_at": _iso(job.get("created_at")),
        "blocks": blocks,
    }


# ------------------------------------------------------------------ run


def _output_refs(job: Mapping[str, Any], kind: str) -> list[dict[str, Any]]:
    """Mirror of frontend run-generation.ts jobOutputValue."""
    meta: dict[str, Any] = {"job_id": job.get("job_id"), "provider": job.get("provider"),
                            "model": job.get("model"), "cost": job.get("cost")}
    if job.get("price_check"):
        meta["price_check"] = job["price_check"]
    refs: list[dict[str, Any]] = []
    for out in job.get("outputs") or []:
        if not isinstance(out, Mapping) or out.get("kind") != kind:
            continue
        local = out.get("local_url") or out.get("url")
        if not isinstance(local, str) or not local:
            continue
        ref: dict[str, Any] = {"kind": REF_KINDS[kind], "local": local}
        if _is_http(out.get("url")):
            ref["url"] = out["url"]
        ref["meta"] = dict(meta)
        refs.append(ref)
    return refs


def _loader_outputs(config: Mapping[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """Mirror of frontend loader-items.ts itemsToOutput, one port per kind."""
    lists = ({kind: config.get(key, []) for kind, key in OMNI_KEYS.items()}
             if "items" not in config else {"image": config["items"]})
    outputs: dict[str, Any] = {}
    for kind, items in lists.items():
        refs = []
        for item in items:
            ref: dict[str, Any] = {"kind": REF_KINDS[kind], "local": item.get("local") or item.get("url")}
            if item.get("url"):
                ref["url"] = item["url"]
            ref["label"] = item["label"]
            for key in _ITEM_NUMBERS:
                if key in item:
                    ref[key] = item[key]
            refs.append(ref)
        if refs:
            outputs[kind] = {"kind": kind, "value": refs[0] if len(refs) == 1 else refs}
    return outputs


def _model_name(model: Any) -> str:
    from backend.byok import ledger

    try:
        return ledger.get_model(str(model)).name
    except KeyError:
        return str(model)


def _run_name(job: Mapping[str, Any]) -> str:
    label = (job.get("request") or {}).get("label")
    if isinstance(label, str) and label.strip():
        return label.strip()
    try:
        when = datetime.fromtimestamp(float(job.get("created_at")), tz=timezone.utc).astimezone()
    except (TypeError, ValueError, OverflowError, OSError):
        when = datetime.now().astimezone()
    return f"MCP — {_model_name(job.get('model'))} — {when.strftime('%b %d %I:%M %p')}"


def build_run(job: Any) -> dict[str, Any] | None:
    """The run for a finished MCP job (POST /api/runs shape), or None when the
    job gets no run: not MCP, not finished, cancelled, or an unknown mode."""
    if not isinstance(job, Mapping) or job.get("source") != SOURCE or not job.get("job_id"):
        return None
    status = job.get("status")
    if status not in RUN_RECORDED_STATUSES or job.get("mode") not in GENERATION_BLOCKS:
        return None
    snapshot = build_flow_snapshot(job)
    gen_type, gen_label, output_kind, loader = GENERATION_BLOCKS[job["mode"]]
    refs = _output_refs(job, output_kind) if status == JobStatus.COMPLETED else []
    ok = bool(refs)

    results: list[dict[str, Any]] = []
    if snapshot["blocks"][0]["type"] != gen_type and loader is not None:
        results.append({"block_index": 0, "block_type": loader[0], "block_label": loader[1],
                        "status": BlockResultStatus.COMPLETED, "outputs": _loader_outputs(snapshot["blocks"][0]["config"])})
    value = (refs[0] if len(refs) == 1 else refs) if ok else None
    gen: dict[str, Any] = {"block_index": len(results), "block_type": gen_type, "block_label": gen_label,
                           "status": BlockResultStatus.COMPLETED if ok else BlockResultStatus.ERROR,
                           "outputs": {output_kind: {"kind": output_kind, "value": value}} if ok else {}}
    if not ok:
        error = job.get("error") if isinstance(job.get("error"), Mapping) else {}
        gen["error"] = str(error.get("message") or job.get("message") or "The job finished without an output.")
    results.append(gen)
    viewer_type, viewer_label = VIEWERS[output_kind]
    results.append({"block_index": len(results), "block_type": viewer_type, "block_label": viewer_label,
                    "status": BlockResultStatus.COMPLETED if ok else BlockResultStatus.SKIPPED, "outputs": dict(gen["outputs"])})

    duration_ms = None
    try:
        duration_ms = max(0, round((float(job["completed_at"]) - float(job["created_at"])) * 1000))
    except (KeyError, TypeError, ValueError):
        pass
    return {
        "id": f"{RUN_PREFIX}{job['job_id']}",
        "name": _run_name(job),
        "status": RunStatus.COMPLETED if ok else RunStatus.FAILED,
        "duration_ms": duration_ms,
        "flow_snapshot": snapshot,
        "block_results": results,
        "created_at": _iso(job.get("created_at")),
    }


# ------------------------------------------------------------------ storage


def init_db() -> None:
    conn = db._get_conn()
    try:
        conn.execute(f"CREATE TABLE IF NOT EXISTS {MARKER_TABLE} (job_id TEXT PRIMARY KEY, run_id TEXT NOT NULL,"
                     " saved_at TEXT NOT NULL)")
        conn.commit()
    finally:
        conn.close()


def save_run_for_job(job: Any) -> bool:
    """Save the job's run once. True when a run was written now."""
    run = build_run(job)
    if run is None:
        return False
    init_db()
    with _lock:
        conn = db._get_conn()
        try:
            conn.execute("BEGIN IMMEDIATE")
            cursor = conn.execute(f"INSERT OR IGNORE INTO {MARKER_TABLE} (job_id, run_id, saved_at) VALUES (?, ?, ?)",
                                  (job["job_id"], run["id"], db.normalize_created_at(None)))
            if cursor.rowcount == 0:
                conn.rollback()
                return False
            conn.execute(
                "INSERT OR IGNORE INTO runs (id, name, status, duration_ms, flow_snapshot, block_results, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (run["id"], run["name"], run["status"], run["duration_ms"],
                 json.dumps(run["flow_snapshot"], ensure_ascii=True),
                 json.dumps(run["block_results"], ensure_ascii=True), run["created_at"]),
            )
            conn.commit()
            return True
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def on_job_event(event: Any) -> None:
    """Job store callback. Never raises."""
    try:
        job = event.get("job") if isinstance(event, Mapping) else None
        if isinstance(job, Mapping) and job.get("source") == SOURCE and job.get("status") in job_store.TERMINAL_STATUSES:
            save_run_for_job(job)
    except Exception as exc:  # noqa: BLE001 - a failed save must not break the job worker
        logger.warning("could not save the run for an MCP job: %s: %s", type(exc).__name__, exc)


def install(store: job_store.JobStore | None = None) -> Callable[[], None]:
    """Listen for MCP job changes on ``store``. Returns the unsubscribe function."""
    return (store or job_store.get_store()).subscribe_callback(on_job_event)


def sweep(store: job_store.JobStore | None = None) -> list[str]:
    """Save runs for finished MCP jobs that have none yet. Returns their job ids."""
    store = store or job_store.get_store()
    saved: list[str] = []
    for job in store.list_jobs(source=SOURCE, limit=SWEEP_LIMIT):
        try:
            if save_run_for_job(job):
                saved.append(job["job_id"])
        except Exception as exc:  # noqa: BLE001
            logger.warning("could not save the run for MCP job %s: %s", job.get("job_id"), exc)
    return saved
