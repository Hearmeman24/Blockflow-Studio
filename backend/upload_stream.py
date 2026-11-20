"""Receive an upload's body straight to disk.

``await request.body()`` collects every chunk and then joins them, so a 90 MB
video costs about twice its size in backend memory, which the allocator keeps
after the request. Every route that takes a file as its raw body uses
``receive_upload`` instead:

    async with upload_stream.receive_upload(request, folder) as upload:
        if not upload.size: ...                   # empty body
        await upload.commit(folder / name)        # rename into place

Chunks are written to a hidden temp file (``TEMP_PREFIX``) in ``folder``, in a
worker thread, and hashed as they pass, so the event loop never blocks on the
disk and the route holds one chunk at a time. The temp file is removed when
the block ends without ``commit``: the client went away (Starlette raises
``ClientDisconnect``), the body passed ``max_bytes`` (``UploadTooLarge``,
raised as soon as the limit is passed or when ``Content-Length`` already
declares more), or the route failed. ``folder`` should be the destination's
folder so the rename stays on one file system; ``commit`` copies across file
systems if it has to.
"""
from __future__ import annotations

import errno
import hashlib
import os
import shutil
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import BinaryIO

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request

TEMP_PREFIX = ".upload-"
TEMP_SUFFIX = ".part"


class UploadTooLarge(Exception):
    """The body is larger than the route accepts."""

    def __init__(self, limit: int) -> None:
        super().__init__(f"The upload is larger than {limit} bytes.")
        self.limit = limit


def is_temp_file(path: Path) -> bool:
    """True for an upload still being received (skip it when scanning a folder)."""
    return path.name.startswith(TEMP_PREFIX) and path.name.endswith(TEMP_SUFFIX)


class ReceivedUpload:
    """The body on disk. ``path`` is the temp file until ``commit`` moves it."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.size = 0
        self._hash = hashlib.sha256()
        self.committed: Path | None = None

    @property
    def sha256(self) -> str:
        return self._hash.hexdigest()

    def _write(self, fh: BinaryIO, chunk: bytes) -> None:
        fh.write(chunk)
        self._hash.update(chunk)

    def commit_sync(self, dest: Path) -> Path:
        """Move the file to ``dest`` (blocking; call it from a worker thread)."""
        move_into_place(self.path, dest)
        self.committed = dest
        return dest

    async def commit(self, dest: Path) -> Path:
        return await run_in_threadpool(self.commit_sync, dest)

    def read_bytes(self) -> bytes:
        """The whole body (blocking): only for a consumer that needs bytes."""
        return self.path.read_bytes()


def move_into_place(src: Path, dest: Path) -> None:
    """Rename ``src`` to ``dest``; across file systems, copy then remove ``src``.
    Never leaves a partial ``dest`` (blocking)."""
    try:
        os.replace(src, dest)
        return
    except OSError as exc:
        if exc.errno != errno.EXDEV:
            raise
    try:
        shutil.copyfile(src, dest)
    except BaseException:
        dest.unlink(missing_ok=True)
        raise
    src.unlink(missing_ok=True)


def _declared_length(request: Request) -> int | None:
    raw = request.headers.get("content-length", "")
    return int(raw) if raw.isdigit() else None


@asynccontextmanager
async def receive_upload(request: Request, folder: Path, *, max_bytes: int | None = None
                         ) -> AsyncIterator[ReceivedUpload]:
    """Stream the body of ``request`` into a temp file in ``folder`` (which
    must exist). See the module docstring."""
    if max_bytes is not None:
        declared = _declared_length(request)
        if declared is not None and declared > max_bytes:
            raise UploadTooLarge(max_bytes)
    upload = ReceivedUpload(folder / f"{TEMP_PREFIX}{uuid.uuid4().hex}{TEMP_SUFFIX}")
    fh = await run_in_threadpool(open, upload.path, "xb")
    try:
        try:
            async for chunk in request.stream():
                if not chunk:
                    continue
                upload.size += len(chunk)
                if max_bytes is not None and upload.size > max_bytes:
                    raise UploadTooLarge(max_bytes)
                await run_in_threadpool(upload._write, fh, chunk)
        finally:
            await run_in_threadpool(fh.close)
        yield upload
    finally:
        if upload.committed is None:
            await run_in_threadpool(upload.path.unlink, True)
