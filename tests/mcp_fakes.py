"""A fake BlockFlow backend for the MCP tool tests: an HTTP transport that
answers by (method, path) and records every call. No network."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any
from urllib.parse import parse_qs, urlsplit

from blockflow_mcp.client import BackendClient

BASE = "http://blockflow.test:47301"


class FakeBackend:
    def __init__(self) -> None:
        self.routes: dict[tuple[str, str], Any] = {}
        self.calls: list[dict[str, Any]] = []

    def on(self, method: str, path: str, reply: Any, status: int = 200) -> None:
        """reply: a body, a list of bodies (served in order, last repeats), or a
        callable(call) -> (status, body)."""
        self.routes[(method, path)] = (status, reply)

    def on_job(self, job_id: str, *snapshots: dict[str, Any]) -> None:
        """GET /api/jobs/<id> answers with these snapshots in order (last repeats)."""
        self.on("GET", f"/api/jobs/{job_id}", [{"ok": True, "job": s} for s in snapshots])

    def __call__(self, method: str, url: str, headers: dict[str, str], body: bytes | None,
                 timeout: float) -> tuple[int, bytes]:
        parts = urlsplit(url)
        call = {"method": method, "path": parts.path, "query": {k: v[0] for k, v in parse_qs(parts.query).items()},
                "headers": headers, "body": body, "timeout": timeout}
        try:
            call["json"] = json.loads(body) if body else None
        except (ValueError, UnicodeDecodeError):
            call["json"] = None
        self.calls.append(call)
        if (method, parts.path) not in self.routes:
            return 404, json.dumps({"ok": False, "error": "Not Found"}).encode()
        status, reply = self.routes[(method, parts.path)]
        if callable(reply):
            status, reply = reply(call)
        elif isinstance(reply, list):
            reply = reply.pop(0) if len(reply) > 1 else reply[0]
        if isinstance(reply, BaseException):
            raise reply
        return status, json.dumps(reply).encode()

    def client(self) -> BackendClient:
        return BackendClient(BASE, transport=self)

    def paths(self, method: str | None = None) -> list[str]:
        return [c["path"] for c in self.calls if method is None or c["method"] == method]

    def bodies(self, path: str) -> list[Any]:
        return [c["json"] for c in self.calls if c["path"] == path]


def job(job_id: str = "j1", status: str = "QUEUED", **extra: Any) -> dict[str, Any]:
    snapshot = {
        "job_id": job_id, "source": "mcp", "provider": "kie", "model": "seedream-5-pro", "mode": "text_to_image",
        "status": status, "remote_job_id": None, "remote_status": None, "progress": None, "message": status.title(),
        "error": None, "outputs": [], "request": {"params": {"prompt": "a lighthouse", "settings": {}},
                                                  "references": [], "client_request_id": "mcp-x", "warnings": []},
        "created_at": 1.0, "updated_at": 1.0, "completed_at": None, "cancel_requested": False, "cost": None,
        "price_check": None,
    }
    snapshot.update(extra)
    return snapshot


Reply = Callable[[dict[str, Any]], tuple[int, Any]]
