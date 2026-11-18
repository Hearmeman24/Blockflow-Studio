"""The FastMCP layer: a thin wrapper that registers each tool group.

Adding a tool group (``tools_characters`` is the example to copy): write ``tools_<group>.py`` with
functions decorated by ``client.tool(...)`` and a ``TOOLS`` list, then add the
module to ``TOOL_GROUPS``. Tools reach the backend through
``client.get_client()`` and take references through
``references.normalize_references``.
"""

from types import ModuleType
from typing import Any

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
the provider from billing.

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


def main() -> None:
    build_server().run()
