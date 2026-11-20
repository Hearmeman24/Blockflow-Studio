from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend import cancellable, config, output_folder

router = APIRouter()

# Child time limits, in seconds. Every child runs through backend.cancellable,
# so it also stops when the client goes away (Cancel in the pipeline).
PROBE_TIMEOUT_S = 30
FFMPEG_TIMEOUT_S = 1800
DOWNLOAD_TIMEOUT_S = 300


def _stitched_dir() -> Path:
    """`<output folder>/stitched`, resolved at use time (follows a folder change)."""
    path = config.output_dir() / "stitched"
    path.mkdir(parents=True, exist_ok=True)
    return path

# xfade transitions exposed in the UI. Key: UI label, Value: xfade transition name or None for hard cut.
TRANSITIONS: dict[str, str | None] = {
    "none": None,
    "fade": "fade",
    "slide": "slideleft",
    "wipe": "wipeleft",
    "circle": "circleopen",
    "pixelize": "pixelize",
}


class StitchRequest(BaseModel):
    videos: list[str] = Field(..., min_length=1, description="Ordered list of video URLs/paths")
    transition: str = Field("none", description="Transition key (none/fade/slide/wipe/circle/pixelize)")
    duration: float = Field(0.5, ge=0.0, le=2.0, description="Crossfade duration in seconds")


def _resolve_to_local(src: str, cancel: threading.Event | None = None) -> Path:
    src = (src or "").strip()
    if not src:
        raise ValueError("Empty video URL")
    if src.startswith(("http://", "https://")):
        ts = time.strftime("%Y%m%d_%H%M%S")
        sha = hashlib.sha1(src.encode()).hexdigest()[:8]
        ext = Path(src.split("?", 1)[0]).suffix or ".mp4"
        dst = _stitched_dir() / f"_src_{ts}_{sha}{ext}"
        return cancellable.download_to(src, dst, timeout=DOWNLOAD_TIMEOUT_S, cancel=cancel)
    if src.startswith("/outputs/") or not Path(src).is_absolute():
        try:
            return output_folder.locate(src)
        except output_folder.UnsafeOutputPath as exc:
            raise ValueError(str(exc)) from None
    return Path(src)


def _probe_dims(path: Path, cancel: threading.Event | None = None) -> tuple[int, int]:
    """Return (width, height) of first video stream via ffprobe."""
    out = cancellable.run_child(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "json",
            str(path),
        ],
        cancel=cancel, timeout=PROBE_TIMEOUT_S,
    ).stdout
    data = json.loads(out)
    stream = (data.get("streams") or [{}])[0]
    return int(stream.get("width") or 0), int(stream.get("height") or 0)


def _probe_duration(path: Path, cancel: threading.Event | None = None) -> float:
    out = cancellable.run_child(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=nokey=1:noprint_wrappers=1",
            str(path),
        ],
        cancel=cancel, timeout=PROBE_TIMEOUT_S,
    ).stdout
    try:
        return float(out.strip())
    except ValueError:
        return 0.0


def _concat_demuxer(paths: list[Path], out_path: Path, cancel: threading.Event | None = None) -> None:
    """Hard-cut concat. Requires same codec/dims — re-encodes to be safe."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
        for p in paths:
            f.write(f"file '{p.resolve().as_posix()}'\n")
        list_path = f.name
    try:
        # Re-encode (concat demuxer is finicky with mixed sources)
        cmd = [
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0", "-i", list_path,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-an",
            str(out_path),
        ]
        cancellable.run_child(cmd, cancel=cancel, timeout=FFMPEG_TIMEOUT_S)
    finally:
        try:
            Path(list_path).unlink()
        except OSError:
            pass


def _xfade_chain(paths: list[Path], transition: str, duration: float, out_path: Path,
                 cancel: threading.Event | None = None) -> None:
    """Build an xfade chain across N clips. Assumes uniform resolution; scales otherwise."""
    n = len(paths)
    if n == 1:
        shutil.copyfile(paths[0], out_path)
        return

    # Probe target dims (use first clip)
    w, h = _probe_dims(paths[0], cancel)
    if not w or not h:
        raise RuntimeError("Could not probe first clip dimensions")

    durations = [_probe_duration(p, cancel) for p in paths]
    if any(d <= 0 for d in durations):
        raise RuntimeError("Could not probe one or more clip durations")
    if any(d <= duration for d in durations[:-1]):
        # Clip too short for requested xfade
        raise RuntimeError(
            f"Crossfade duration {duration}s exceeds clip length; reduce duration or use 'none'"
        )

    inputs: list[str] = []
    for p in paths:
        inputs.extend(["-i", str(p)])

    # Build filter graph: scale each clip to first clip's dims, then xfade-chain.
    filter_parts: list[str] = []
    for i in range(n):
        filter_parts.append(
            f"[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v{i}]"
        )

    # Cumulative offsets: offset_k = sum(d_0..d_{k-1}) - k*duration
    offset = 0.0
    prev_label = "v0"
    for k in range(1, n):
        offset += durations[k - 1] - duration
        out_label = f"vx{k}" if k < n - 1 else "outv"
        filter_parts.append(
            f"[{prev_label}][v{k}]xfade=transition={transition}:duration={duration}:offset={offset:.3f}[{out_label}]"
        )
        prev_label = out_label

    filter_graph = ";".join(filter_parts)

    cmd = [
        "ffmpeg", "-y",
        *inputs,
        "-filter_complex", filter_graph,
        "-map", "[outv]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-an",
        str(out_path),
    ]
    cancellable.run_child(cmd, cancel=cancel, timeout=FFMPEG_TIMEOUT_S)


class _Refused(Exception):
    """A request the route answers with 400 and this message."""


def _run_all(req: StitchRequest, *, cancel: threading.Event) -> str:
    """The whole stitch, in a worker thread. The partial output is removed
    when ffmpeg fails, times out or is cancelled."""
    local_paths = [_resolve_to_local(v, cancel) for v in req.videos]
    missing = [str(p) for p in local_paths if not p.exists()]
    if missing:
        raise _Refused(f"Missing files: {missing}")

    transition_key = (req.transition or "none").lower()
    if transition_key not in TRANSITIONS:
        raise _Refused(f"Unknown transition '{transition_key}'")

    ts = time.strftime("%Y%m%d_%H%M%S")
    sig = hashlib.sha1(
        ("|".join(str(p) for p in local_paths) + f"|{transition_key}|{req.duration}").encode()
    ).hexdigest()[:8]
    out_path = _stitched_dir() / f"stitched_{ts}_{sig}.mp4"

    xfade_name = TRANSITIONS[transition_key]
    try:
        if xfade_name is None or len(local_paths) == 1:
            _concat_demuxer(local_paths, out_path, cancel)
        else:
            _xfade_chain(local_paths, xfade_name, req.duration, out_path, cancel)
    except BaseException:
        cancellable.remove_partial(out_path)
        raise
    return f"/outputs/stitched/{out_path.name}"


@router.post("/run")
async def run_stitch(req: StitchRequest, request: Request) -> JSONResponse:
    try:
        local_url = await cancellable.run_while_connected(request, _run_all, req)
        return JSONResponse({"ok": True, "video_url": local_url, "local_video_url": local_url})
    except _Refused as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
    except cancellable.Cancelled:
        # The client is gone; nobody reads this.
        return JSONResponse({"ok": False, "error": "Cancelled"}, status_code=499)
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or b"").decode(errors="replace")[-800:]
        return JSONResponse({"ok": False, "error": f"ffmpeg failed: {stderr}"}, status_code=500)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
