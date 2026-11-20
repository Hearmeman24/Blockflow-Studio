import hashlib
import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from backend import cancellable, config, output_folder, upload_stream

router = APIRouter()


def _fx_dir() -> Path:
    """`<output folder>/fx`, resolved at use time (follows a folder change)."""
    path = config.output_dir() / "fx"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _lut_cache_dir() -> Path:
    path = _fx_dir() / "_luts"
    path.mkdir(parents=True, exist_ok=True)
    return path

# RIFE (rife-ncnn-vulkan) for optical-flow smoothing.
# Install with scripts/install_rife.sh; override paths via env if needed.
RIFE_BIN_DEFAULT = Path.home() / "bin" / "rife-ncnn-vulkan"
RIFE_MODEL_DEFAULT = Path.home() / ".cache" / "rife" / "rife-v4.6"
# Serialize RIFE calls — running multiple instances against one GPU just thrashes.
_RIFE_LOCK = threading.Semaphore(1)
# Child time limits, in seconds. Every child runs through backend.cancellable,
# so it also stops when the client goes away (Cancel in the pipeline).
PROBE_TIMEOUT_S = 30
FFMPEG_TIMEOUT_S = 1800
RIFE_TIMEOUT_S = 7200
DOWNLOAD_TIMEOUT_S = 300


def _sanitize_lut(src: Path) -> Path:
    """Strip directives ffmpeg's lut3d filter rejects (e.g. Resolve's LUT_3D_INPUT_RANGE).
    Cache by content hash so we re-process only when the source changes."""
    raw = src.read_bytes()
    digest = hashlib.sha1(raw + b"|v1").hexdigest()[:16]
    cached = _lut_cache_dir() / f"{digest}.cube"
    if cached.exists():
        return cached
    cleaned_lines = []
    for line in raw.decode("utf-8", errors="replace").splitlines():
        stripped = line.strip()
        # Drop directives ffmpeg doesn't understand. LUT_3D_INPUT_RANGE 0..1 is the default
        # for lut3d anyway, so removing the line is safe.
        if stripped.upper().startswith("LUT_3D_INPUT_RANGE"):
            continue
        if stripped.upper().startswith("LUT_1D_INPUT_RANGE"):
            continue
        cleaned_lines.append(line)
    cached.write_text("\n".join(cleaned_lines) + "\n", encoding="utf-8")
    return cached


class FxRequest(BaseModel):
    videos: List[str] = Field(..., min_length=1)
    speed_enabled: bool = False
    speed: float = Field(1.0, gt=0.0, le=8.0)
    smooth: bool = False
    smooth_fps: int = Field(60, ge=24, le=120)
    smooth_match_source: bool = True
    loop_enabled: bool = False
    loop_count: int = Field(2, ge=1, le=8)
    boomerang: bool = False
    lut_enabled: bool = False
    lut_path: Optional[str] = None


def _resolve_to_local(src: str, cancel: threading.Event | None = None) -> Path:
    src = (src or "").strip()
    if not src:
        raise ValueError("Empty video URL")
    if src.startswith(("http://", "https://")):
        sha = hashlib.sha1(src.encode()).hexdigest()[:8]
        ext = Path(src.split("?", 1)[0]).suffix or ".mp4"
        dst = _fx_dir() / f"_src_{sha}{ext}"
        if not dst.exists():
            cancellable.download_to(src, dst, timeout=DOWNLOAD_TIMEOUT_S, cancel=cancel)
        return dst
    if src.startswith("/outputs/") or not Path(src).is_absolute():
        try:
            return output_folder.locate(src)
        except output_folder.UnsafeOutputPath as exc:
            raise ValueError(str(exc)) from None
    return Path(src)


def _build_filter(req: FxRequest, lut_path: Path | None) -> str:
    """Order: lut → speed → boomerang → loop. Final output label is [vout]."""
    parts: list[str] = []
    label = "0:v"

    if req.lut_enabled and lut_path is not None:
        lut_str = lut_path.resolve().as_posix().replace(":", r"\:")
        parts.append(f"[{label}]lut3d=file='{lut_str}'[vlut]")
        label = "vlut"

    if req.speed_enabled and abs(req.speed - 1.0) > 1e-3:
        parts.append(f"[{label}]setpts=PTS/{req.speed:.4f}[vsp]")
        label = "vsp"

    if req.loop_enabled and req.boomerang:
        parts.append(
            f"[{label}]split=2[vf][vr];"
            f"[vr]reverse[vrev];"
            f"[vf][vrev]concat=n=2:v=1:a=0[vb]"
        )
        label = "vb"

    if req.loop_enabled and req.loop_count > 1:
        n = max(0, req.loop_count - 1)
        parts.append(f"[{label}]loop=loop={n}:size=32767:start=0[vl]")
        label = "vl"

    # Always end with a rename to [vout]
    parts.append(f"[{label}]null[vout]")
    return ";".join(parts)


def _rife_paths() -> tuple[Path, Path]:
    bin_path = Path(os.environ.get("RIFE_BIN") or RIFE_BIN_DEFAULT)
    model_dir = Path(os.environ.get("RIFE_MODEL_DIR") or RIFE_MODEL_DEFAULT)
    if not bin_path.exists():
        raise RuntimeError(
            f"rife-ncnn-vulkan not found at {bin_path}. "
            f"Run scripts/install_rife.sh, or set $RIFE_BIN."
        )
    if not model_dir.exists():
        raise RuntimeError(
            f"RIFE model dir not found at {model_dir}. "
            f"Run scripts/install_rife.sh, or set $RIFE_MODEL_DIR."
        )
    return bin_path, model_dir


def _probe_fps(src: Path, cancel: threading.Event | None = None) -> float:
    out = cancellable.run_child(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=r_frame_rate", "-of", "default=nw=1:nk=1",
         str(src)],
        cancel=cancel, timeout=PROBE_TIMEOUT_S,
    ).stdout.decode().strip()
    if "/" in out:
        n, d = out.split("/", 1)
        return float(n) / float(d) if float(d) else float(n)
    return float(out)


def _choose_multiplier(src_fps: float, target_fps: int, speed: float) -> int:
    # Intermediate (post-RIFE) has src_fps * M frames per source-second.
    # After setpts/speed, effective playback fps is src_fps * M * speed.
    # Want >= target_fps → M >= target_fps / (src_fps * speed).
    needed = target_fps / max(src_fps * max(speed, 1e-3), 1e-3)
    for m in (2, 4, 8):
        if m >= needed:
            return m
    return 8


def _acquire_rife(cancel: threading.Event | None) -> None:
    """Wait for the RIFE slot, giving up when the run is cancelled."""
    while not _RIFE_LOCK.acquire(timeout=cancellable.POLL_S):
        if cancel is not None and cancel.is_set():
            raise cancellable.Cancelled()


def _rife_preprocess(
    src: Path, target_fps: int, speed: float, work_dir: Path, cancel: threading.Event | None = None
) -> tuple[Path, float]:
    """Extract → RIFE interpolate → re-encode. Returns (intermediate_mp4, intermediate_fps)."""
    bin_path, model_dir = _rife_paths()
    src_fps = _probe_fps(src, cancel)
    mult = _choose_multiplier(src_fps, target_fps, speed)

    frames_in = work_dir / "in"
    frames_out = work_dir / "out"
    frames_in.mkdir(parents=True, exist_ok=True)
    frames_out.mkdir(parents=True, exist_ok=True)

    cancellable.run_child(
        ["ffmpeg", "-y", "-i", str(src),
         "-vsync", "0", "-q:v", "1",
         str(frames_in / "%08d.png")],
        cancel=cancel, timeout=FFMPEG_TIMEOUT_S,
    )
    n_in = sum(1 for _ in frames_in.glob("*.png"))
    if n_in < 2:
        raise RuntimeError(f"RIFE needs ≥2 input frames, got {n_in}")
    target_n = mult * n_in

    # RIFE prints one progress line per output frame. Capturing it would
    # buffer all of that in RAM, so the pipe is copied to a log file we tail
    # only on failure. A pipe, not the file itself: if the backend dies, RIFE's
    # next line fails and it stops instead of running on alone.
    rife_log = work_dir / "rife.log"
    _acquire_rife(cancel)
    try:
        proc = cancellable.run_child(
            [str(bin_path),
             "-i", str(frames_in),
             "-o", str(frames_out),
             "-m", str(model_dir),
             "-n", str(target_n)],
            cancel=cancel, timeout=RIFE_TIMEOUT_S, check=False, log_path=rife_log,
        )
    finally:
        _RIFE_LOCK.release()
    if proc.returncode != 0:
        tail = rife_log.read_bytes()[-1200:].decode("utf-8", errors="replace")
        raise RuntimeError(f"rife-ncnn-vulkan exited {proc.returncode}: {tail}")

    intermediate_fps = src_fps * mult
    intermediate = work_dir / "interp.mp4"
    cancellable.run_child(
        ["ffmpeg", "-y",
         "-framerate", f"{intermediate_fps:.6f}",
         "-i", str(frames_out / "%08d.png"),
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
         "-pix_fmt", "yuv420p", "-an",
         str(intermediate)],
        cancel=cancel, timeout=FFMPEG_TIMEOUT_S,
    )
    return intermediate, intermediate_fps


def _run_fx_one(src: Path, req: FxRequest, lut_path: Path | None, out_path: Path,
                cancel: threading.Event | None = None) -> None:
    use_rife = req.smooth and req.speed_enabled and abs(req.speed - 1.0) > 1e-3
    target_fps: int | None = None
    with tempfile.TemporaryDirectory(prefix="vfx_rife_") as td:
        actual_src = src
        if use_rife:
            # match-source: probe once, round to nearest int, share with RIFE preproc.
            if req.smooth_match_source:
                target_fps = max(1, round(_probe_fps(src, cancel)))
            else:
                target_fps = req.smooth_fps
            actual_src, _ = _rife_preprocess(src, target_fps, req.speed, Path(td), cancel)

        filter_graph = _build_filter(req, lut_path)
        cmd = [
            "ffmpeg", "-y",
            "-i", str(actual_src),
            "-filter_complex", filter_graph,
            "-map", "[vout]",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-an",
        ]
        if use_rife and target_fps is not None:
            cmd += ["-r", str(target_fps)]
        cmd.append(str(out_path))
        cancellable.run_child(cmd, cancel=cancel, timeout=FFMPEG_TIMEOUT_S)


def _signature(src: Path, req: FxRequest) -> str:
    raw = "|".join([
        str(src),
        f"s={req.speed_enabled}/{req.speed}/smooth={req.smooth}/{req.smooth_fps}/match={req.smooth_match_source}",
        f"l={req.loop_enabled}/{req.loop_count}/{req.boomerang}",
        f"lut={req.lut_enabled}/{req.lut_path or ''}",
    ])
    return hashlib.sha1(raw.encode()).hexdigest()[:10]


def _upload_digest(path: Path) -> str:
    """The LUT's cache name: sha1 of its bytes plus ``|upload`` (read in blocks)."""
    h = hashlib.sha1()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(64 * 1024), b""):
            h.update(block)
    h.update(b"|upload")
    return h.hexdigest()[:16]


@router.post("/upload-lut")
async def upload_lut(request: Request) -> JSONResponse:
    """Accept a .cube LUT (raw body, filename in X-Filename header),
    cache it by content hash, return the absolute path."""
    name = (request.headers.get("x-filename") or "").strip()
    if not name.lower().endswith(".cube"):
        return JSONResponse({"ok": False, "error": "Expected a .cube file"}, status_code=400)
    lut_dir = await run_in_threadpool(_lut_cache_dir)
    async with upload_stream.receive_upload(request, lut_dir) as raw:
        if not raw.size:
            return JSONResponse({"ok": False, "error": "Empty file"}, status_code=400)
        digest = await run_in_threadpool(_upload_digest, raw.path)
        dst = lut_dir / f"upload_{digest}.cube"
        if not await run_in_threadpool(dst.exists):
            await raw.commit(dst)
    return JSONResponse({"ok": True, "path": str(dst.resolve()), "name": name})


class _Refused(Exception):
    """A request the route answers with 400 and this message."""


def _run_all(req: FxRequest, *, cancel: threading.Event) -> list[str]:
    """The whole run, in a worker thread: LUT, sources, then each video in
    turn (one ffmpeg already uses every core). A video's partial output is
    removed when its step fails, times out or is cancelled."""
    lut_path: Path | None = None
    if req.lut_enabled:
        if not req.lut_path:
            raise _Refused("LUT enabled but no path provided")
        lut_path = Path(req.lut_path).expanduser()
        if not lut_path.exists():
            raise _Refused(f"LUT file not found: {lut_path}")
        lut_path = _sanitize_lut(lut_path)

    local_paths = [_resolve_to_local(v, cancel) for v in req.videos]
    missing = [str(p) for p in local_paths if not p.exists()]
    if missing:
        raise _Refused(f"Missing files: {missing}")

    ts = time.strftime("%Y%m%d_%H%M%S")
    fx_dir = _fx_dir()  # one folder for the whole request, even if the setting changes meanwhile
    outputs: list[Path] = [
        fx_dir / f"fx_{ts}_{i:02d}_{_signature(src, req)}.mp4"
        for i, src in enumerate(local_paths)
    ]
    for src, out in zip(local_paths, outputs):
        try:
            _run_fx_one(src, req, lut_path, out, cancel)
        except BaseException:
            cancellable.remove_partial(out)
            raise
    return [f"/outputs/fx/{p.name}" for p in outputs]


@router.post("/run")
async def run_fx(req: FxRequest, request: Request) -> JSONResponse:
    try:
        urls = await cancellable.run_while_connected(request, _run_all, req)
        return JSONResponse({"ok": True, "videos": urls})
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
