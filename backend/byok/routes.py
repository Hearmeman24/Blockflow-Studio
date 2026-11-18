"""HTTP routes for providers and generation. Job status, cancel and events are
served by ``backend/job_routes.py`` at ``/api/jobs*``.

  GET  /api/providers/catalog                -> ledger.catalog_payload(configured)
  GET  /api/providers/balances[?refresh=1]   -> {ok, balances: [...]} (see balances.py; ~30 s cache)
  POST /api/generation/estimate              -> {ok, estimate: {...}} | {ok, estimate: null, unavailable:
                                               {code, message}} (price ledger; no provider call)
  POST /api/providers/{provider}/validate-key -> {ok, valid, message, balance?, balance_unit?}
  POST /api/generation/validate              -> {ok, issues}
  POST /api/generation/submit                -> {ok: true, job} | 422/400/409 {ok: false, error, kind, issues}
                                               (job carries `phase` while active; see job_routes.py)
  POST /api/generation/check-references      -> {ok: true, results: [{index, status, detail}]}
       status: ok | missing_local | expired | unreachable | unchecked (provider
       asset://, not probed) | malformed; see references.STATUSES

Keys are only ever read from the settings store; none of these routes accept
or return one.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from backend.byok import balances, ledger, pricing, references, service
from backend.byok.errors import ProviderError, redact
from backend.byok.spec import canonical_reference

logger = logging.getLogger(__name__)

router = APIRouter(tags=["byok"])

_STATUS_FOR_KIND = {"validation": 422, "auth": 400, "conflict": 409}


def _bad_body(message: str) -> JSONResponse:
    issue = {"code": "invalid_payload", "severity": "error", "field": "", "message": message, "limit": None,
             "actual": None}
    return JSONResponse({"ok": False, "error": message, "kind": "validation", "issues": [issue]}, status_code=422)


async def _json_body(request: Request) -> tuple[Any, JSONResponse | None]:
    raw = await request.body()
    try:
        return json.loads(raw.decode("utf-8")), None
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, _bad_body("The request body must be valid JSON.")


@router.get("/api/providers/catalog")
def provider_catalog() -> JSONResponse:
    return JSONResponse(ledger.catalog_payload(service.configured_providers()))


@router.get("/api/providers/balances")
async def provider_balances(refresh: str = "") -> JSONResponse:
    bypass = refresh.strip().lower() in ("1", "true", "yes")
    result = await run_in_threadpool(balances.get_balances, bypass)
    return JSONResponse({"ok": True, "balances": result})


@router.post("/api/generation/estimate")
async def estimate_generation(request: Request) -> JSONResponse:
    payload, error = await _json_body(request)
    if error is not None:
        return error
    if not isinstance(payload, dict):
        return _bad_body("The request body must be a JSON object.")
    result = await run_in_threadpool(pricing.estimate_response, payload)
    return JSONResponse({"ok": True, **result})


@router.post("/api/providers/{provider}/validate-key")
def validate_key(provider: str) -> JSONResponse:
    if provider not in service.CREDENTIALS:
        return JSONResponse({"ok": False, "valid": None, "message": f"Unknown provider '{provider}'."},
                            status_code=404)
    key = service.get_api_key(provider)
    if not key:
        return JSONResponse({"ok": True, "valid": False, "message": service.missing_key_message(provider)})
    try:
        status = service.adapter_factory(provider).validate_key(key)
    except ProviderError as err:
        message = service.error_message(err.kind, err.message, provider, key)
        logger.info("validate-key for %s failed (%s)", provider, err.kind)
        return JSONResponse({"ok": False, "valid": None, "kind": err.kind, "message": message}, status_code=502)
    body: dict[str, Any] = {"ok": True, "valid": bool(status.valid), "message": redact(status.message, key)}
    if status.balance is not None:
        body["balance"] = status.balance
    if status.balance_unit is not None:
        body["balance_unit"] = status.balance_unit
    return JSONResponse(body)


@router.post("/api/generation/validate")
async def validate_generation(request: Request) -> JSONResponse:
    payload, error = await _json_body(request)
    if error is not None:
        return error
    issues = await run_in_threadpool(service.validate_generation, payload)
    return JSONResponse({"ok": not any(i["severity"] == "error" for i in issues), "issues": issues})


@router.post("/api/generation/submit")
async def submit_generation(request: Request) -> JSONResponse:
    payload, error = await _json_body(request)
    if error is not None:
        return error
    try:
        job = await run_in_threadpool(service.submit_generation, payload)
    except service.GenerationError as err:
        return JSONResponse({"ok": False, "error": err.message, "kind": err.kind, "issues": err.issues},
                            status_code=_STATUS_FOR_KIND.get(err.kind, 400))
    return JSONResponse({"ok": True, "job": service.with_phase(job)})


@router.post("/api/generation/check-references")
async def check_references(request: Request) -> JSONResponse:
    payload, error = await _json_body(request)
    if error is not None:
        return error
    refs = payload.get("references") if isinstance(payload, dict) else None
    if not isinstance(refs, list):
        return _bad_body("The body must be {\"references\": [...]}.")
    # Same boundary as validate/estimate/submit; the probe itself does not read the kind.
    refs = [canonical_reference(r) for r in refs]
    results = await run_in_threadpool(references.check_references, refs)
    return JSONResponse({"ok": True, "results": results})
