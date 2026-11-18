"""Tool group: the Artifacts run history (/api/runs) and prompt search. Read-only.

A run's prompts are read the same way the backend's prompt search reads them:
generation blocks' `prompt` and the Prompt Writer's `user_prompt` / `output`
in the saved flow (also inside branches), a Prompt Writer's text result, and
the legacy `metadata` outputs of runs from older builds.
"""

from typing import Any

from blockflow_mcp.client import ToolFailure, checked, get_client, tool

SOURCES = ("mcp", "pipeline")
MEDIA_KINDS = ("image", "video", "other")
_WRITER = "promptWriter"
_MAX_DEPTH = 64


def run_prompts(run: dict[str, Any]) -> list[str]:
    found: list[str] = []

    def walk(chain: Any, depth: int) -> None:
        if depth > _MAX_DEPTH or not isinstance(chain, list):
            return
        for block in chain:
            if not isinstance(block, dict):
                continue
            config = block.get("config")
            if isinstance(config, dict):
                keys = ("prompt", "user_prompt", "output") if block.get("type") == _WRITER else ("prompt",)
                found.extend(config[k] for k in keys if isinstance(config.get(k), str) and config[k])
            for branch in block.get("branches") or [] if isinstance(block.get("branches"), list) else []:
                walk(branch, depth + 1)

    for br in run.get("block_results") or []:
        if not isinstance(br, dict) or not isinstance(br.get("outputs"), dict):
            continue
        for out in br["outputs"].values():
            if not isinstance(out, dict):
                continue
            value = out.get("value")
            if out.get("kind") == "metadata":
                for m in value if isinstance(value, list) else [value]:
                    if isinstance(m, dict) and isinstance(m.get("prompt"), str):
                        found.append(m["prompt"])
            elif br.get("block_type") == _WRITER and out.get("kind") == "text" and isinstance(value, str):
                found.append(value)
    snapshot = run.get("flow_snapshot")
    if isinstance(snapshot, dict):
        walk(snapshot.get("blocks"), 0)
    return list(dict.fromkeys(found))


def run_media(run: dict[str, Any]) -> list[dict[str, Any]]:
    """Media outputs of the run's last block that has any (the viewer, usually)."""
    for br in reversed([b for b in run.get("block_results") or [] if isinstance(b, dict)]):
        media = []
        for out in (br.get("outputs") or {}).values() if isinstance(br.get("outputs"), dict) else []:
            if not isinstance(out, dict) or out.get("kind") not in ("image", "video", "audio"):
                continue
            values = out.get("value") if isinstance(out.get("value"), list) else [out.get("value")]
            for v in values:
                if isinstance(v, str) and v:
                    media.append({"kind": out["kind"], "local": v})
                elif isinstance(v, dict) and (v.get("local") or v.get("url")):
                    entry = {"kind": out["kind"], "local": v.get("local") or v.get("url")}
                    if v.get("url"):
                        entry["url"] = v["url"]
                    if isinstance(v.get("meta"), dict):
                        entry["job_id"] = v["meta"].get("job_id")
                        entry["cost"] = v["meta"].get("cost")
                    media.append(entry)
        if media:
            return media
    return []


def summarize_run(run: dict[str, Any]) -> dict[str, Any]:
    run_id = str(run.get("id", ""))
    return {
        "run_id": run_id, "name": run.get("name"), "status": run.get("status"), "created_at": run.get("created_at"),
        "source": "mcp" if run_id.startswith("run-mcp-") else "pipeline", "favorited": bool(run.get("favorited")),
        "prompts": run_prompts(run), "media": run_media(run),
    }


def _list(limit: int, offset: int, source: str, media_kind: str, query: str, favorited: bool) -> dict[str, Any]:
    if source and source not in SOURCES:
        raise ToolFailure("invalid_source", f"'source' must be one of {', '.join(SOURCES)}.")
    if media_kind and media_kind not in MEDIA_KINDS:
        raise ToolFailure("invalid_media_kind", f"'media_kind' must be one of {', '.join(MEDIA_KINDS)}.")
    params = {"limit": max(1, min(int(limit), 200)), "offset": max(0, int(offset)), "source": source,
              "media_kind": media_kind, "q": (query or "").strip(), "favorited": "true" if favorited else ""}
    status, body = get_client().get("/api/runs", params=params)
    return checked(status, body, "Listing runs")


@tool(read_only=True)
def list_runs(limit: int = 20, offset: int = 0, source: str = "", media_kind: str = "", query: str = "",
              favorited: bool = False) -> dict[str, Any]:
    """Runs in the Artifacts history, newest first: name, status, prompts and
    output media. Filter by `source` (mcp | pipeline), `media_kind` (image |
    video | other), `query` (case-insensitive text in a prompt) and
    `favorited`. `limit` 1-200, `offset` for paging; `total` is the match count."""
    body = _list(limit, offset, source, media_kind, query, favorited)
    runs = body.get("runs") or []
    return {"ok": True, "runs": [summarize_run(r) for r in runs], "total": body.get("total", len(runs))}


@tool(read_only=True)
def get_run(run_id: str) -> dict[str, Any]:
    """One Artifacts run in full: its summary plus the saved flow
    (`flow_snapshot`, what Restore opens) and per-block results."""
    if not isinstance(run_id, str) or not run_id.strip():
        raise ToolFailure("invalid_run_id", "'run_id' is required.")
    status, body = get_client().get(f"/api/runs/{run_id.strip()}")
    if status == 404:
        raise ToolFailure("not_found", f"No run with id {run_id!r}.")
    run = checked(status, body, "Reading the run")["run"]
    return {"ok": True, "run": {**summarize_run(run), "flow_snapshot": run.get("flow_snapshot"),
                                "block_results": run.get("block_results")}}


@tool(read_only=True)
def search_prompts(query: str, limit: int = 20, source: str = "") -> dict[str, Any]:
    """Find prompts used in past generations (app pipeline runs and MCP runs).
    Case-insensitive substring match on prompt text; `query` "" lists the most
    recent prompts. `limit` caps the number of runs returned (newest first),
    `source` narrows to mcp or pipeline. Returns {results: [{prompt, url,
    run_id, created_at}], count}."""
    body = _list(limit, 0, source, "", query, False)
    needle = (query or "").strip().lower()
    results = []
    for run in body.get("runs") or []:
        media = run_media(run)
        url = media[0]["local"] if media else ""
        for prompt in run_prompts(run):
            if needle and needle not in prompt.lower():
                continue
            results.append({"prompt": prompt, "url": url, "run_id": run.get("id", ""),
                            "created_at": run.get("created_at", "")})
    return {"ok": True, "results": results, "count": len(results)}


TOOLS = [list_runs, get_run, search_prompts]
