"""Long media work that stops when the request that asked for it goes away.

Video FX and Video Stitcher run ffmpeg (and RIFE) for minutes. When the user
cancels, the browser aborts the request; without this module the child kept
running on every core until it finished. The pieces:

- ``run_while_connected(request, fn, *args)``: runs ``fn(*args, cancel=event)``
  in a worker thread and sets ``event`` as soon as the client disconnects (or
  the request task itself is cancelled, as at shutdown). Returns ``fn``'s
  result; raises ``Cancelled`` when the work stopped because of the event.
- ``run_child(cmd, cancel=..., timeout=...)``: ``subprocess.run`` for those
  workers. The child is started with ``Popen`` and watched; on cancel or
  timeout it is terminated, killed after ``GRACE_S`` if it ignores that, and
  waited for. Its output always goes to a pipe, never straight to a file, so
  a child whose parent dies gets a broken pipe and stops too; ``log_path``
  copies that pipe to a file (RIFE prints a line per frame).
- ``download_to(url, dest, cancel=...)``: an http(s) source streamed to disk in
  blocks, ``dest`` appearing only when it is complete.

Callers remove their own partial outputs when one of these raises.
"""
from __future__ import annotations

import asyncio
import functools
import os
import shutil
import subprocess
import threading
import time
import urllib.request
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, TypeVar

GRACE_S = 2.0  # after SIGTERM, before SIGKILL
POLL_S = 0.1  # how often a worker looks at its child and the cancel event
DISCONNECT_POLL_S = 0.25  # how often the route asks whether the client is still there
DOWNLOAD_BLOCK = 1024 * 1024

T = TypeVar("T")


class Cancelled(Exception):
    """The work stopped because the client went away."""


def _stop(proc: subprocess.Popen) -> None:
    """Terminate ``proc``, kill it if it is still there after ``GRACE_S``, reap it."""
    if proc.poll() is not None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=GRACE_S)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    except ProcessLookupError:
        proc.wait()


def _copy_to_log(stream, log_path: Path) -> None:
    with log_path.open("wb") as log:
        for block in iter(lambda: stream.read1(64 * 1024), b""):
            log.write(block)


def run_child(cmd: Sequence[str], *, cancel: threading.Event | None, timeout: float, check: bool = True,
              log_path: Path | None = None) -> subprocess.CompletedProcess:
    """Run ``cmd`` like ``subprocess.run(cmd, capture_output=True, timeout=...,
    check=...)`` (or with stdout and stderr copied to ``log_path``), but stop
    it when ``cancel`` is set. Raises ``Cancelled``, ``subprocess.TimeoutExpired``
    or (with ``check``) ``subprocess.CalledProcessError``; the child is gone
    when any of them is raised."""
    cmd = [str(part) for part in cmd]
    deadline = time.monotonic() + timeout
    stderr = subprocess.STDOUT if log_path is not None else subprocess.PIPE
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=stderr)
    out: bytes | None = None
    err: bytes | None = None
    drain: threading.Thread | None = None
    try:
        if log_path is not None:
            drain = threading.Thread(target=_copy_to_log, args=(proc.stdout, log_path), daemon=True)
            drain.start()
        while True:
            if cancel is not None and cancel.is_set():
                raise Cancelled()
            left = deadline - time.monotonic()
            if left <= 0:
                raise subprocess.TimeoutExpired(cmd, timeout)
            try:
                if log_path is not None:
                    proc.wait(timeout=min(POLL_S, left))
                else:
                    # communicate() keeps what it read across timeouts.
                    out, err = proc.communicate(timeout=min(POLL_S, left))
                break
            except subprocess.TimeoutExpired:
                continue
    except BaseException:
        _stop(proc)
        if drain is None:
            try:
                proc.communicate(timeout=GRACE_S)  # close the pipes
            except (subprocess.TimeoutExpired, ValueError, OSError):
                pass
        raise
    finally:
        if drain is not None:
            drain.join(timeout=GRACE_S)
            if proc.stdout is not None:
                proc.stdout.close()
    if check and proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, cmd, out, err)
    return subprocess.CompletedProcess(cmd, proc.returncode, out, err)


async def run_while_connected(request: Any, fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """``fn(*args, cancel=event, **kwargs)`` in a worker thread; ``event`` is set
    when the client disconnects or this task is cancelled. The worker is always
    waited for, so its child has stopped when this returns or raises."""
    cancel = threading.Event()
    loop = asyncio.get_running_loop()
    future = loop.run_in_executor(None, functools.partial(fn, *args, cancel=cancel, **kwargs))
    try:
        while True:
            done, _ = await asyncio.wait({future}, timeout=DISCONNECT_POLL_S)
            if done:
                return future.result()
            if not cancel.is_set() and await request.is_disconnected():
                cancel.set()
    except BaseException:
        cancel.set()
        raise


def download_to(url: str, dest: Path, *, timeout: float, cancel: threading.Event | None = None) -> Path:
    """Stream ``url`` to ``dest`` through ``<dest>.part`` (blocking; run it in a
    worker). Nothing is left at either path when it fails or is cancelled."""
    part = dest.with_name(dest.name + ".part")
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=timeout) as resp, part.open("wb") as fh:
            while True:
                if cancel is not None and cancel.is_set():
                    raise Cancelled()
                block = resp.read(DOWNLOAD_BLOCK)
                if not block:
                    break
                fh.write(block)
        os.replace(part, dest)
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    return dest


def remove_partial(*paths: Path) -> None:
    """Delete files a stopped or failed step may have left half-written."""
    for path in paths:
        try:
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)
        except OSError:
            pass
