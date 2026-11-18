"""HTTP routes for the settings store.

URL spaces:
  - /api/settings/credentials   — allow-listed provider API keys (status only)
  - /api/settings/app-prefs     — output dir, retention policy, onboarding, etc.
  - /api/settings/shortcuts     — keyboard shortcut enable flags
  - /api/settings/output-folder — output folder in use / default / saved choice
  - /api/settings/choose-folder — open the OS folder dialog (local backend only)

Credential routes never return or log a key value. Responses carry
`{name, configured, last4, updated_at}`. Unknown names are 404 on every verb.
Key checks against a provider live at /api/providers/{provider}/validate-key.
"""
from __future__ import annotations

import json
import os

from fastapi import APIRouter, Body, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from backend import folder_picker, output_folder, settings_store
from backend.prompt_writer import base_urls

router = APIRouter()


# === Pydantic request bodies ===============================================

class AppPrefBody(BaseModel):
    value: str


# === credentials ============================================================

_UNKNOWN = "Unknown credential name."
_BAD_BODY = 'Send the key as JSON: {"value": "<your API key>"}.'


def _require_allowed(name: str) -> None:
    if not settings_store.is_allowed_credential(name):
        raise HTTPException(status_code=404, detail=_UNKNOWN)


async def _read_value(request: Request) -> str:
    """Parse `{"value": str}` by hand so a malformed body is never echoed
    back (FastAPI's default 422 includes the submitted input)."""
    try:
        body = json.loads(await request.body())
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=422, detail=_BAD_BODY) from None
    if not isinstance(body, dict) or not isinstance(body.get("value"), str):
        raise HTTPException(status_code=422, detail=_BAD_BODY)
    return body["value"]


@router.get("/api/settings/credentials")
def list_credentials() -> JSONResponse:
    return JSONResponse({"credentials": settings_store.list_credential_statuses()})


@router.get("/api/settings/credentials/{name}")
def get_credential(name: str) -> JSONResponse:
    _require_allowed(name)
    return JSONResponse(settings_store.credential_status(name))


@router.put("/api/settings/credentials/{name}")
async def put_credential(name: str, request: Request) -> JSONResponse:
    _require_allowed(name)
    raw = await _read_value(request)
    try:
        value = settings_store.normalize_credential_value(raw)
    except settings_store.InvalidCredentialValue as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    settings_store.set_credential(name, value)
    return JSONResponse(settings_store.credential_status(name))


@router.delete("/api/settings/credentials/{name}", status_code=204)
def delete_credential(name: str) -> Response:
    _require_allowed(name)
    settings_store.delete_credential(name)
    return Response(status_code=204)


# === app_prefs ==============================================================

@router.get("/api/settings/app-prefs/{name}")
def get_app_pref(name: str, default: str | None = Query(default=None)) -> JSONResponse:
    return JSONResponse({"name": name, "value": settings_store.get_app_pref(name, default=default)})


# price_ledger_updates: download the public price list (backend/byok/price_sources.py).
_BOOLEAN_PREFS = {settings_store.ONBOARDING_COMPLETED_PREF, "price_ledger_updates"}
_BASE_URL_PREFS = set(base_urls.PREF_NAMES.values())


def _origins_ok(value: str) -> bool:
    from backend import origin_guard

    parts = [p for p in value.split(",") if p.strip()]
    return len(origin_guard.parse_origins(value)) == len(parts)


# Updater prefs (backend/app_update/settings.py) and the extra allowed origins
# (backend/origin_guard.py). An empty value means "default".
_UPDATE_PREF_CHECKS = {
    "update_checks": lambda v: v in ("true", "false"),
    "update_channel": lambda v: v in ("", "beta", "stable"),
    "update_repo": lambda v: v.strip() == "" or bool(_update_repo_ok(v)),
    "allowed_origins": _origins_ok,
}


def _update_repo_ok(value: str) -> str:
    from backend.app_update import settings as update_settings

    return update_settings.valid_repo(value)


def _validate_app_pref(name: str, value: str) -> str:
    """Per-pref validation, before persistence so the UI can show the error.
    Returns the value to store.

    - Boolean prefs (onboarding_completed) accept exactly "true" or "false".
    - output_dir is checked by backend.output_folder (created if missing,
      writable, not a system folder); empty string means 'use default'.
    - Local LLM server URLs (ollama_base_url, lmstudio_base_url) must be
      http/https without credentials, query or fragment; they are stored
      normalised. Empty string means 'use default'. Errors never echo the value.
    """
    if name in _BASE_URL_PREFS:
        if value.strip() == "":
            return ""
        try:
            return base_urls.validate_base_url(value)
        except base_urls.InvalidBaseUrl as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
    if name in ("price_ledger_url", "price_ledger_repo"):
        from backend.byok import price_sources

        check = price_sources.valid_url if name == "price_ledger_url" else price_sources.valid_repo
        if value.strip() and not check(value):
            what = "an https:// URL without credentials" if name == "price_ledger_url" else "a GitHub owner/name"
            raise HTTPException(status_code=400, detail=f"{name} must be {what}")
        return value.strip()
    if name in _UPDATE_PREF_CHECKS:
        if not _UPDATE_PREF_CHECKS[name](value):
            raise HTTPException(status_code=400, detail=f"{name} has an invalid value")
        return value.strip()
    if name in _BOOLEAN_PREFS:
        if value not in ("true", "false"):
            raise HTTPException(status_code=400, detail=f'{name} must be "true" or "false"')
        return value
    if name != output_folder.OUTPUT_DIR_PREF:
        return value
    if value.strip() == "":
        return ""  # back to the default folder
    try:
        return output_folder.validate_output_folder(value)
    except output_folder.InvalidOutputFolder as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


@router.put("/api/settings/app-prefs/{name}")
def put_app_pref(name: str, body: AppPrefBody) -> JSONResponse:
    value = _validate_app_pref(name, body.value)
    if name == output_folder.OUTPUT_DIR_PREF:
        # Takes effect now; the folder it replaces stays readable at /outputs.
        output_folder.switch_to(value or None)
    else:
        settings_store.set_app_pref(name, value)
    return JSONResponse({"name": name, "saved": True})


# === output folder ==========================================================
# The folder in use, the default and the saved choice (see backend/output_folder.py),
# plus a native folder dialog (backend/folder_picker.py). Both are sync routes so
# the blocking dialog runs in the threadpool, not on the event loop.

def _output_folder_status() -> dict:
    return output_folder.output_folder_status(settings_store, folder_picker.picker_availability())


@router.get("/api/settings/output-folder")
def get_output_folder() -> JSONResponse:
    return JSONResponse(_output_folder_status())


@router.post("/api/settings/output-folder/forget")
def forget_output_folder(body: object = Body(default=None)) -> JSONResponse:
    """Stop reading an earlier output folder. Body: {"path": "<folder from previous>"}.
    Its files are not touched; references into it then show as missing."""
    path = body.get("path") if isinstance(body, dict) else None
    if not isinstance(path, str) or not path.strip():
        raise HTTPException(status_code=422, detail='Send {"path": "<earlier output folder>"}.')
    if not output_folder.forget_previous(path):
        raise HTTPException(status_code=404, detail="That folder is not in the list of earlier output folders.")
    return JSONResponse(_output_folder_status())


@router.post("/api/settings/choose-folder")
def choose_folder(body: object = Body(default=None)) -> JSONResponse:
    """Open the OS folder dialog. Body (optional): {"initial": "<absolute folder>"}.
    Returns {"status": "chosen", "path"} | {"status": "cancelled"} |
    {"status": "unavailable" | "busy", "message"}; always HTTP 200."""
    initial = body.get("initial") if isinstance(body, dict) else None
    if not isinstance(initial, str) or not os.path.isabs(initial.strip()):
        initial = None
    else:
        initial = initial.strip()
    return JSONResponse(folder_picker.choose_folder(initial=initial))


# === shortcut prefs =========================================================
# Stores per-shortcut enable/disable flags in settings_app_prefs under the
# namespaced key "shortcut.<id>.enabled". The sentinel id "__master__" is the
# master enable/disable toggle.

_SHORTCUT_PREFIX = "shortcut."
_SHORTCUT_SUFFIX = ".enabled"


def _read_shortcut_prefs() -> dict[str, bool]:
    out: dict[str, bool] = {}
    with settings_store._get_conn() as conn:
        rows = conn.execute(
            "SELECT name, value FROM settings_app_prefs WHERE name LIKE ?",
            (f"{_SHORTCUT_PREFIX}%{_SHORTCUT_SUFFIX}",),
        ).fetchall()
    for row in rows:
        name = row["name"]
        sid = name[len(_SHORTCUT_PREFIX) : -len(_SHORTCUT_SUFFIX)]
        out[sid] = row["value"] == "true"
    return out


@router.get("/api/settings/shortcuts")
def get_shortcut_prefs() -> dict[str, bool]:
    return _read_shortcut_prefs()


@router.put("/api/settings/shortcuts")
def put_shortcut_prefs(prefs: dict[str, bool]) -> dict[str, bool]:
    for sid, enabled in prefs.items():
        settings_store.set_app_pref(
            f"{_SHORTCUT_PREFIX}{sid}{_SHORTCUT_SUFFIX}",
            "true" if enabled else "false",
        )
    return _read_shortcut_prefs()
