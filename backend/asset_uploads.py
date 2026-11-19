"""Remote asset upload provider selection for loader blocks, and the one
reader of the Settings, then Storage mode (``storage_mode()``), which the
generation service (``backend.byok.service``) uses too."""

from __future__ import annotations

import json
import logging
import urllib.request
from pathlib import Path

from backend import settings_store, tmpfiles
from backend.statuses import StorageMode

logger = logging.getLogger(__name__)

# The pref name, declared once (backend.byok.service.STORAGE_MODE_PREF is this).
ASSET_STORAGE_MODE_PREF = "asset_storage_mode"
ASSET_STORAGE_MODES = {m.value for m in StorageMode}
# Unset, unknown or unreadable means files stay on this machine.
DEFAULT_ASSET_STORAGE_MODE = StorageMode.LOCAL_ONLY
TMPFILES_UPLOAD_URL = "https://tmpfiles.org/api/v1/upload"


class RemoteAssetUploadDisabled(RuntimeError):
    """Raised when the user has chosen not to create externally fetchable URLs."""


def storage_mode() -> StorageMode:
    """The saved storage mode, with one failure rule: fail closed.

    ``tmpfiles`` only when the user chose exactly that in Settings, then
    Storage. Anything else is ``local_only``: unset, unknown (older builds
    offered other modes, for example a signed-bucket one; such a value reads
    as the default instead of breaking uploads), or a settings store that
    cannot be read. Local files then only ever go to the chosen provider's
    own upload.
    """
    try:
        value = settings_store.get_app_pref(ASSET_STORAGE_MODE_PREF)
    except Exception as exc:  # noqa: BLE001 - fail closed: no third-party host
        logger.warning("could not read the storage mode (%s); using local_only", type(exc).__name__)
        return DEFAULT_ASSET_STORAGE_MODE
    return StorageMode(value) if value in ASSET_STORAGE_MODES else DEFAULT_ASSET_STORAGE_MODE


def get_asset_storage_mode() -> str:
    """``storage_mode()``, under the name the loader routes use."""
    return storage_mode()


def _safe_name(filename: str) -> str:
    name = Path(filename or "asset").name.strip() or "asset"
    return "".join(ch if ch.isalnum() or ch in {".", "-", "_"} else "-" for ch in name)


def _upload_to_tmpfiles(data: bytes, filename: str, content_type: str) -> str:
    boundary = "----TmpFilesBoundary9876543210"
    safe_name = _safe_name(filename)
    parts = [
        f"--{boundary}".encode(),
        f'Content-Disposition: form-data; name="file"; filename="{safe_name}"'.encode(),
        f"Content-Type: {content_type}".encode(),
        b"",
        data,
        f"--{boundary}--".encode(),
    ]
    multipart_body = b"\r\n".join(parts)

    req = urllib.request.Request(
        TMPFILES_UPLOAD_URL,
        data=multipart_body,
        method="POST",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(multipart_body)),
            "User-Agent": tmpfiles.USER_AGENT,
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        resp_data = json.loads(resp.read().decode("utf-8"))

    url = resp_data.get("data", {}).get("url", "")
    if not url:
        raise RuntimeError(f"tmpfiles upload failed: {resp_data}")
    if "tmpfiles.org/" in url and "/dl/" not in url:
        url = url.replace("tmpfiles.org/", "tmpfiles.org/dl/", 1)
    return tmpfiles.resolve_tokenized_url(url)


def upload_asset(
    data: bytes,
    *,
    filename: str,
    content_type: str,
    media_kind: str,
) -> dict[str, str | None]:
    mode = get_asset_storage_mode()
    if mode == StorageMode.LOCAL_ONLY:
        raise RemoteAssetUploadDisabled(
            "Remote asset upload is disabled by local-only storage mode"
        )
    return {
        "url": _upload_to_tmpfiles(data, filename, content_type),
        "provider": "tmpfiles",
        "expires_at": None,
    }
