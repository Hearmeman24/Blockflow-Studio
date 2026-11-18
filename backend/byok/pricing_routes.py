"""Price-ledger routes.

  GET  /api/pricing/status   -> {ok, active, ledger, bundled, remote, last_refresh}
                                 (see price_sources.status())
  POST /api/pricing/refresh  -> {ok, refresh: {ok, status, message?, at}, status: {...}}

Neither route sends anything about the user: a refresh is one GET for the
configured static ledger file, and nothing at all while no URL is set.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from backend.byok import price_sources

router = APIRouter(tags=["pricing"])


@router.get("/api/pricing/status")
async def pricing_status() -> JSONResponse:
    status = await run_in_threadpool(price_sources.status)
    return JSONResponse({"ok": True, **status})


@router.post("/api/pricing/refresh")
async def pricing_refresh() -> JSONResponse:
    result = await run_in_threadpool(price_sources.refresh, True)
    status = await run_in_threadpool(price_sources.status)
    return JSONResponse({"ok": True, "refresh": result, "status": status})
