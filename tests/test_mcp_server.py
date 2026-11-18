"""The FastMCP wrapper (blockflow_mcp/server.py) registers exactly the expected
tools. Needs fastmcp: run with `uv run --with fastmcp pytest tests/test_mcp_*.py`.
The tool logic itself is tested without FastMCP in test_mcp_tools.py."""

from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from blockflow_mcp import server  # noqa: E402

EXPECTED = {
    "list_models", "get_model", "estimate_cost", "validate_generation", "generate",
    "job_status", "wait_for_jobs", "cancel_job", "list_jobs", "get_balances",
    "list_runs", "get_run", "search_prompts", "list_characters", "get_character",
}
REMOVED = {"create_set", "list_sets", "add_to_set", "submit_jobs", "submit_batch", "cancel_jobs",
           "inspect_workflow", "list_loras", "submit_seedream"}


def test_tool_groups_without_fastmcp():
    names = [fn.__name__ for fn in server.tool_functions()]
    assert sorted(names) == sorted(EXPECTED)
    assert len(names) == len(set(names))
    code = "import sys; import blockflow_mcp.server; assert 'fastmcp' not in sys.modules"
    subprocess.run([sys.executable, "-c", code], cwd=ROOT, check=True)


def test_server_name_does_not_collide_with_the_original_blockflow():
    # The original BlockFlow app registers an MCP server called "blockflow".
    assert server.SERVER_NAME == "blockflow-studio"
    assert "BlockFlow Studio" in server.INSTRUCTIONS


def test_instructions_and_generate_describe_character_references():
    from blockflow_mcp.tools_generation import estimate_cost, generate, validate_generation

    assert "list_characters" in server.INSTRUCTIONS and "get_character" in server.INSTRUCTIONS
    assert "character" in server.INSTRUCTIONS
    for fn in (generate, estimate_cost, validate_generation):
        assert "character" in fn.__doc__
    assert "media" in generate.__doc__ and "default audio" in generate.__doc__
    assert "voice_name" not in generate.__doc__ and "voice_name" not in server.INSTRUCTIONS


def test_reference_kinds_are_image_video_audio():
    from blockflow_mcp import character_lookup, references
    from blockflow_mcp.tools_characters import get_character, list_characters
    from blockflow_mcp.tools_generation import generate

    assert references.KINDS == character_lookup.KINDS == ("image", "video", "audio")
    assert "voice" not in references.EXTENSIONS and "voice" not in references.SAVE_ROUTES
    for text in (server.INSTRUCTIONS, generate.__doc__, list_characters.__doc__, get_character.__doc__):
        assert "default_voice" not in text and "voice_name" not in text
        assert "image|video|audio|voice" not in text.replace(" ", "")


def test_only_generate_spends_and_read_only_flags():
    by_name = {fn.__name__: fn.mcp_annotations for fn in server.tool_functions()}
    assert [n for n, a in by_name.items() if a["openWorldHint"]] == ["generate"]
    assert {n for n, a in by_name.items() if not a["readOnlyHint"]} == {"generate", "cancel_job"}
    assert by_name["list_characters"]["readOnlyHint"] and by_name["get_character"]["readOnlyHint"]


def test_generate_description_says_it_spends_credits():
    from blockflow_mcp.tools_generation import generate

    assert "SPENDS THE USER'S PROVIDER" in generate.__doc__
    assert "credits" in server.INSTRUCTIONS.lower() and "omni_reference_to_video" in server.INSTRUCTIONS


def test_fastmcp_registers_exactly_the_expected_tools():
    pytest.importorskip("fastmcp", reason="run with `uv run --with fastmcp pytest tests/test_mcp_*.py`")
    mcp = server.build_server()
    tools = asyncio.run(mcp.list_tools())
    names = {t.name for t in tools}
    assert names == EXPECTED
    assert not names & REMOVED
    generate = next(t for t in tools if t.name == "generate")
    assert "SPENDS THE USER'S PROVIDER" in (generate.description or "")
    props = generate.parameters["properties"]
    assert {"provider", "model", "mode", "prompt", "references", "wait", "timeout_s", "max_cost_usd",
            "allow_unknown_cost", "label"} <= set(props)
    assert mcp.instructions == server.INSTRUCTIONS
    assert mcp.name == "blockflow-studio"
