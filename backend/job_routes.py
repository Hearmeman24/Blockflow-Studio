"""HTTP routes for the provider-neutral job store, mounted at /api/jobs.

  GET  /api/jobs?source=&status=&limit=   -> {"ok": true, "jobs": [snapshot, ...]} newest first
  GET  /api/jobs/events                   -> SSE stream of {"type": "job", "job": snapshot}
  GET  /api/jobs/{job_id}                 -> {"ok": true, "job": snapshot} | 404
  POST /api/jobs/{job_id}/cancel          -> {"ok": true, "job": snapshot} | 404

SSE framing matches the legacy block events stream: a `retry: 3000` line
first, then one unnamed `data: <json>` message per change (so a browser
EventSource fires `onmessage`), and a `: ping` comment as heartbeat.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from backend import job_store

router = APIRouter(prefix="/api/jobs", tags=["jobs"])

HEARTBEAT_SECONDS = 15.0
RETRY_MS = 3000

_NOT_FOUND = {"ok": False, "error": "Job not found"}


def _filter(value: str, allowed: tuple[str, ...], name: str, *, upper: bool) -> str | None:
    value = value.strip()
    if not value:
        return None
    if upper:
        value = value.upper()
    if value not in allowed:
        raise HTTPException(status_code=422, detail=f"invalid {name} {value!r}; expected one of {', '.join(allowed)}")
    return value


@router.get("")
def list_jobs(
    source: str = "",
    status: str = "",
    limit: int = Query(job_store.DEFAULT_LIST_LIMIT, ge=1, le=job_store.MAX_LIST_LIMIT),
) -> JSONResponse:
    jobs = job_store.get_store().list_jobs(
        source=_filter(source, job_store.JOB_SOURCES, "source", upper=False),
        status=_filter(status, job_store.JOB_STATUSES, "status", upper=True),
        limit=limit,
    )
    return JSONResponse({"ok": True, "jobs": jobs})


# Declared before /{job_id} so "events" is never read as a job id.
@router.get("/events")
async def events(request: Request) -> StreamingResponse:
    store = job_store.get_store()
    queue = store.subscribe()

    async def stream():
        try:
            yield f"retry: {RETRY_MS}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        finally:
            store.unsubscribe(queue)

    # "no-transform" makes the Next.js rewrite proxy's compression skip this
    # response; gzipped, it was buffered and no event reached the browser.
    return StreamingResponse(stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    })


@router.get("/{job_id}")
def get_job(job_id: str) -> JSONResponse:
    job = job_store.get_store().get_job(job_id)
    if job is None:
        return JSONResponse(_NOT_FOUND, status_code=404)
    return JSONResponse({"ok": True, "job": job})


@router.post("/{job_id}/cancel")
def cancel_job(job_id: str) -> JSONResponse:
    try:
        job = job_store.get_store().request_cancel(job_id)
    except job_store.JobNotFoundError:
        return JSONResponse(_NOT_FOUND, status_code=404)
    return JSONResponse({"ok": True, "job": job})
