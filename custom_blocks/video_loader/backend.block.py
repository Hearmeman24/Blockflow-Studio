from __future__ import annotations

import time
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from backend import asset_uploads, config, upload_stream

router = APIRouter()


def _output_dir() -> Path:
    out_dir = config.output_dir()  # resolved now: follows a folder change at once
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


@router.post("/save-local")
async def save_local(request: Request) -> JSONResponse:
    """Save uploaded video to local /outputs directory (streamed to disk)."""
    filename = request.headers.get("X-Filename", "video.mp4")
    try:
        out_dir = await run_in_threadpool(_output_dir)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)})

    async with upload_stream.receive_upload(request, out_dir) as body:
        if not body.size:
            return JSONResponse({"ok": False, "error": "empty body"}, status_code=400)
        try:
            # Prefix with timestamp to avoid collisions
            ts = time.strftime("%Y%m%d_%H%M%S")
            safe_name = Path(filename).name  # strip any path components
            dest = out_dir / f"{ts}_{safe_name}"
            await body.commit(dest)
            video_url = f"/outputs/{dest.name}"
            return JSONResponse({"ok": True, "video_url": video_url})
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)})


@router.post("/upload")
async def upload(request: Request) -> JSONResponse:
    filename = request.headers.get("X-Filename", "video.mp4")
    content_type = request.headers.get("X-Content-Type", "video/mp4")

    try:
        out_dir = await run_in_threadpool(_output_dir)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)})

    async with upload_stream.receive_upload(request, out_dir) as body:
        if not body.size:
            return JSONResponse({"ok": False, "error": "empty body"}, status_code=400)

        def send() -> dict:
            # The tmpfiles request takes the bytes (its shape is unchanged).
            return asset_uploads.upload_asset(
                body.read_bytes(),
                filename=filename,
                content_type=content_type,
                media_kind="video",
            )

        try:
            uploaded = await run_in_threadpool(send)
            return JSONResponse(
                {
                    "ok": True,
                    "video_url": uploaded["url"],
                    "provider": uploaded["provider"],
                    "expires_at": uploaded["expires_at"],
                }
            )
        except asset_uploads.RemoteAssetUploadDisabled as e:
            return JSONResponse({"ok": False, "error": str(e), "provider": "local_only"})
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)})
