"""Tool group: provider account state (GET /api/providers/balances). Read-only."""

from typing import Any

from blockflow_mcp.client import checked, get_client, tool


@tool(read_only=True)
def get_balances(refresh: bool = False) -> dict[str, Any]:
    """The credit balance left on each provider account (Kie in credits, PiAPI
    in USD), with a USD equivalent when known. Providers without a saved key
    show `configured: false`. Balances are cached for about 30 seconds; pass
    `refresh: true` to ask the providers again."""
    status, body = get_client().get("/api/providers/balances", params={"refresh": "1" if refresh else ""})
    return {"ok": True, "balances": checked(status, body, "Reading balances").get("balances") or []}


TOOLS = [get_balances]
