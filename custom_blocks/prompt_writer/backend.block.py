"""Prompt Writer block routes, mounted at ``/api/blocks/prompt_writer``.

- ``GET  /providers[?refresh=1]``: OpenRouter, Ollama and LM Studio with
  ``available``, ``reason`` and ``models`` (see backend/prompt_writer/service.py).
- ``POST /generate``: ``{provider, model, input, system_prompt?, temperature?,
  max_tokens?, media?}`` -> ``{ok: true, text}`` or ``{ok: false, kind, message}``.
  ``media`` is a list of upstream references (``{kind, local: "/outputs/..."}``)
  that the service resolves, checks and attaches to the user message.
  The OpenRouter key is read from the settings store, never from the body.
- ``POST /check-key``: asks OpenRouter whether the saved key is accepted.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from backend.prompt_writer import service

router = APIRouter()

_STATUS_BY_KIND = {"validation": 422, "unavailable": 503, "timeout": 504}


@router.get("/providers")
async def providers(refresh: int = Query(0)) -> JSONResponse:
    statuses = await run_in_threadpool(service.provider_statuses, service.default_deps(), refresh=bool(refresh))
    return JSONResponse({"providers": statuses})


@router.post("/generate")
async def generate(request: Request) -> JSONResponse:
    try:
        payload = json.loads(await request.body())
    except (ValueError, UnicodeDecodeError):
        # Never echo the body: it could hold anything the client sent.
        return JSONResponse({"ok": False, "kind": "validation", "message": "Send the request as JSON."},
                            status_code=422)
    result = await run_in_threadpool(service.generate, payload, service.default_deps())
    status = 200 if result["ok"] else _STATUS_BY_KIND.get(result["kind"], 502)
    return JSONResponse(result, status_code=status)


@router.post("/check-key")
async def check_key() -> JSONResponse:
    return JSONResponse(await run_in_threadpool(service.check_openrouter_key, service.default_deps()))
