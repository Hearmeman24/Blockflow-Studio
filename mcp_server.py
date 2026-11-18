"""BlockFlow MCP server: generate images and videos with the user's Kie and
PiAPI keys through the BlockFlow app running on this computer.

A thin client over the local backend (`uv run app.py`, :47301); the backend
holds the provider keys. Tools live in `blockflow_mcp/`, one module per tool
group. Registration: AGENTS.md, "Set up BlockFlow Studio for a user".

Run:  uv run --with fastmcp mcp_server.py        (stdio, for an MCP client config)
Env:  BLOCKFLOW_URL (default http://127.0.0.1:47301)
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from blockflow_mcp.server import main  # noqa: E402

if __name__ == "__main__":
    main()
