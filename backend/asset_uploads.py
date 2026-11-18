"""Remote asset upload provider selection for loader blocks."""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path

from backend import settings_store, tmpfiles

ASSET_STORAGE_MODE_PREF = "asset_storage_mode"
ASSET_STORAGE_MODES = {"local_only", "tmpfiles"}
# Unset or unknown means files stay on this machine (matches backend.byok.service).
DEFAULT_ASSET_STORAGE_MODE = "local_only"
TMPFILES_UPLOAD_URL = "https://tmpfiles.org/api/v1/upload"


class RemoteAssetUploadDisabled(RuntimeError):
    """Raised when the user has chosen not to create externally fetchable URLs."""


def get_asset_storage_mode() -> str:
    """The saved storage mode, or the default for anything unrecognised.

    Older builds offered other modes (for example a signed-bucket mode). A
    saved value from one of those is not in ASSET_STORAGE_MODES, so it reads
    as the default (local_only) instead of breaking uploads.
    """
    value = settings_store.get_app_pref(ASSET_STORAGE_MODE_PREF)
    return value if value in ASSET_STORAGE_MODES else DEFAULT_ASSET_STORAGE_MODE


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
            "User-Agent": "Mozilla/5.0 (compatible; SGS-UI/1.0)",
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
    if mode == "local_only":
        raise RemoteAssetUploadDisabled(
            "Remote asset upload is disabled by local-only storage mode"
        )
    return {
        "url": _upload_to_tmpfiles(data, filename, content_type),
        "provider": "tmpfiles",
        "expires_at": None,
    }
