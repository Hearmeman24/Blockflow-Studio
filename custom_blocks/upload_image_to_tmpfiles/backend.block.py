from __future__ import annotations

import hashlib
import time
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from backend import asset_uploads, config, image_payload, upload_stream

router = APIRouter()

@router.get("/health")
def health() -> JSONResponse:
    return JSONResponse({"ok": True})


def _output_dir() -> Path:
    out_dir = config.output_dir()  # resolved now: follows a folder change at once
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def _file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(64 * 1024), b""):
            h.update(block)
    return h.hexdigest()[:16]


def _existing_copy(out_dir: Path, size: int, content_hash: str) -> Path | None:
    """A file in ``out_dir`` with these bytes (blocking: reads candidates)."""
    for existing in out_dir.iterdir():
        if upload_stream.is_temp_file(existing):
            continue  # an upload still being received, this one included
        if existing.is_file() and existing.stat().st_size == size:
            if _file_hash(existing) == content_hash:
                return existing
    return None


@router.post("/save-local")
async def save_local(request: Request) -> JSONResponse:
    """Save uploaded image to local /outputs directory. Deduplicates by content hash."""
    filename = request.headers.get("X-Filename", "image.png")
    try:
        out_dir = await run_in_threadpool(_output_dir)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)})

    async with upload_stream.receive_upload(request, out_dir) as body:
        if not body.size:
            return JSONResponse({"ok": False, "error": "empty body"}, status_code=400)
        try:
            # Check if this exact file already exists in output dir by content hash
            content_hash = body.sha256[:16]
            existing = await run_in_threadpool(_existing_copy, out_dir, body.size, content_hash)
            if existing is not None:
                image_url = f"/outputs/{existing.name}"
                return JSONResponse({"ok": True, "image_url": image_url})

            ts = time.strftime("%Y%m%d_%H%M%S")
            safe_name = Path(filename).name
            dest = out_dir / f"{ts}_{safe_name}"
            await body.commit(dest)
            image_url = f"/outputs/{dest.name}"
            return JSONResponse({"ok": True, "image_url": image_url})
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)})


@router.post("/upload")
async def upload(request: Request) -> JSONResponse:
    filename = request.headers.get("X-Filename", "image.png")
    content_type = request.headers.get("X-Content-Type", "image/png")
    try:
        out_dir = await run_in_threadpool(_output_dir)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)})

    async with upload_stream.receive_upload(request, out_dir) as body:
        if not body.size:
            return JSONResponse({"ok": False, "error": "empty body"}, status_code=400)

        def send() -> dict:
            # Image processing and the tmpfiles request take the bytes (unchanged).
            prepared = image_payload.prepare_image_for_upload(
                body.read_bytes(),
                filename=filename,
                content_type=content_type,
            )
            return asset_uploads.upload_asset(
                prepared.data,
                filename=prepared.name,
                content_type=prepared.content_type,
                media_kind="image",
            )

        try:
            uploaded = await run_in_threadpool(send)
            return JSONResponse(
                {
                    "ok": True,
                    "image_url": uploaded["url"],
                    "provider": uploaded["provider"],
                    "expires_at": uploaded["expires_at"],
                }
            )
        except asset_uploads.RemoteAssetUploadDisabled as e:
            return JSONResponse({"ok": False, "error": str(e), "provider": "local_only"})
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)})
