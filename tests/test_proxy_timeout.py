"""The frontend's /api proxy (frontend/next.config.ts) must wait longer than
any synchronous backend request, so the backend always answers first with its
own readable error. Next.js drops a proxied request after
``experimental.proxyTimeout`` ms (30 s when unset), which turned slow local
Prompt Writer runs into a bare HTTP 500."""
from __future__ import annotations

import re
from pathlib import Path

from backend.prompt_writer import service

ROOT = Path(__file__).resolve().parent.parent
NEXT_CONFIG = ROOT / "frontend" / "next.config.ts"
# Margin so the backend's own timeout error (and its JSON) arrives first.
MARGIN_S = 60


def _proxy_timeout_s() -> int:
    text = NEXT_CONFIG.read_text(encoding="utf-8")
    match = re.search(r"^const PROXY_TIMEOUT_S = ([\d_]+)\b", text, re.MULTILINE)
    assert match, "frontend/next.config.ts must define `const PROXY_TIMEOUT_S = <seconds>`"
    assert re.search(r"proxyTimeout:\s*PROXY_TIMEOUT_S \* 1000\b", text), \
        "experimental.proxyTimeout must be PROXY_TIMEOUT_S * 1000 (Next.js takes milliseconds)"
    return int(match.group(1).replace("_", ""))


def _longest_step_timeout(path: Path) -> int:
    """The largest ``timeout=<n>`` of one blocking step in a sidecar."""
    found = [int(n) for n in re.findall(r"timeout=(\d+)", path.read_text(encoding="utf-8"))]
    assert found
    return max(found)


def test_proxy_waits_longer_than_every_prompt_writer_request():
    longest = max(service.OPENROUTER_GENERATE_TIMEOUT_S, service.LOCAL_GENERATE_TIMEOUT_S,
                  service.CHECK_KEY_TIMEOUT_S, service.OPENROUTER_DEADLINE_S)
    assert _proxy_timeout_s() >= longest + MARGIN_S


def test_proxy_waits_longer_than_one_step_of_the_synchronous_video_sidecars():
    for slug in ("video_fx", "video_stitcher"):
        step = _longest_step_timeout(ROOT / "custom_blocks" / slug / "backend.block.py")
        assert _proxy_timeout_s() >= step + MARGIN_S, slug
