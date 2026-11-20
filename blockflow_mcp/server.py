"""The FastMCP layer: a thin wrapper that registers each tool group.

Adding a tool group (``tools_characters`` is the example to copy): write ``tools_<group>.py`` with
functions decorated by ``client.tool(...)`` and a ``TOOLS`` list, then add the
module to ``TOOL_GROUPS``. Tools reach the backend through
``client.get_client()`` and take references through
``references.normalize_references``.
"""

import atexit
import io
import os
import sys
import threading
from types import ModuleType
from typing import Any, TextIO

from blockflow_mcp import (
    tools_account,
    tools_catalog,
    tools_characters,
    tools_generation,
    tools_jobs,
    tools_runs,
)

SERVER_NAME = "blockflow-studio"

INSTRUCTIONS = """\
BlockFlow Studio generates images and videos through the user's own Kie and
PiAPI accounts, via the BlockFlow Studio app running on this computer.

Workflow: list_models -> get_model (prompt rules, references, durations,
resolutions, settings) -> estimate_cost -> generate (wait=true, or
wait_for_jobs later). Results are saved in the app's output folder and appear
as runs on the Artifacts page.

generate SPENDS THE USER'S PROVIDER CREDITS. Estimate first, pass
max_cost_usd, and only run what the user asked for. cancel_job may not stop
the provider from billing. Never call generate again after a result that
carries a job_id, even an error: the job exists, so follow it with
job_status or wait_for_jobs. After a submit error that says the job may have
been created, check list_jobs (source "mcp") before trying again.

Only these modes exist: text_to_image, image_to_image, text_to_video,
image_to_video, omni_reference_to_video. References are image, video or audio
files given as an absolute path, an /outputs/... app path, a public http(s)
URL, or a saved character's file. Sound is one kind, audio (a voice is an
audio clip): it is sent to the model as audio and the prompt says what to do
with it.

Characters are named people or subjects kept on the app's Characters page, each
with image, video and audio files. list_characters and get_character read them
(read-only; they cannot create or edit characters). In generate references use
{kind: "image", character: "<name or id>"} for the default face,
{kind: "audio", character: ...} for the default audio, and
{kind: "video" | "audio" | "image", character: ..., media:
"<file label or media id>"} for a specific file."""

TOOL_GROUPS: list[ModuleType] = [tools_catalog, tools_generation, tools_jobs, tools_account, tools_runs,
                                 tools_characters]


def tool_functions() -> list[Any]:
    return [fn for group in TOOL_GROUPS for fn in group.TOOLS]


def build_server() -> Any:
    from fastmcp import FastMCP

    mcp = FastMCP(SERVER_NAME, instructions=INSTRUCTIONS)
    for fn in tool_functions():
        mcp.tool(fn, annotations=getattr(fn, "mcp_annotations", None))
    return mcp


def relay_stdin(source_fd: int, stop: threading.Event) -> TextIO:
    """A text stream that carries everything read from ``source_fd`` and sets
    ``stop`` when ``source_fd`` reaches its end (the client closed stdin).

    The stdio transport reads ``sys.stdin``; giving it this relay is how the
    server learns that its client is gone even while a tool (a long
    ``wait_for_jobs``) is still running, which the transport alone only
    notices after that tool returns."""
    read_fd, write_fd = os.pipe()

    def pump() -> None:
        try:
            while True:
                block = os.read(source_fd, 64 * 1024)
                if not block:
                    break
                view = memoryview(block)
                while view:
                    view = view[os.write(write_fd, view):]
        except OSError:
            pass
        finally:
            stop.set()
            os.close(write_fd)

    threading.Thread(target=pump, name="stdin-relay", daemon=True).start()
    return io.TextIOWrapper(io.BufferedReader(io.FileIO(read_fd, "rb")), encoding="utf-8")


def main() -> None:
    from blockflow_mcp import tools_jobs

    atexit.register(tools_jobs.STOP.set)
    sys.stdin = relay_stdin(sys.stdin.fileno(), tools_jobs.STOP)
    build_server().run()
