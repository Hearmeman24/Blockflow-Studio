"""Guard: provider keys are never kept in browser storage.

Keys live only in the backend settings store. This scans the frontend and
block sources for localStorage/sessionStorage calls whose key is one of the
allow-listed credential names, given literally or through a string constant.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import settings_store  # noqa: E402

CREDENTIAL_NAMES = set(settings_store.ALLOWED_CREDENTIALS)

CONST_RE = re.compile(r"\bconst\s+([A-Za-z0-9_]+)\s*=\s*['\"`]([^'\"`]+)['\"`]")
STORAGE_RE = re.compile(
    r"\b(?:localStorage|sessionStorage)\s*\.\s*(?:getItem|setItem|removeItem)\(\s*([^),]+)"
)
INDEX_RE = re.compile(r"\b(?:localStorage|sessionStorage)\s*\[\s*([^\]]+)\]")


def _frontend_sources() -> list[Path]:
    roots = [ROOT / "frontend" / "src", ROOT / "custom_blocks"]
    return [
        path
        for root in roots
        for path in root.rglob("*")
        if path.suffix in {".ts", ".tsx"}
        and "node_modules" not in path.parts
    ]


def _violations(text: str) -> list[int]:
    constants = dict(CONST_RE.findall(text))
    found: list[int] = []
    for line_no, line in enumerate(text.splitlines(), start=1):
        for match in (*STORAGE_RE.finditer(line), *INDEX_RE.finditer(line)):
            key_expr = match.group(1).strip()
            quoted = key_expr[:1] in {"'", '"', "`"}
            key = key_expr.strip("'\"`") if quoted else constants.get(key_expr)
            if key in CREDENTIAL_NAMES:
                found.append(line_no)
    return found


def test_guard_tracks_the_backend_allow_list() -> None:
    assert CREDENTIAL_NAMES == {"kie_api_key", "piapi_api_key", "openrouter_api_key"}


def test_guard_detects_each_storage_form() -> None:
    samples = [
        "localStorage.setItem('kie_api_key', v)",
        'sessionStorage.getItem("piapi_api_key")',
        "localStorage.removeItem(`kie_api_key`)",
        "const KEY = 'kie_api_key'\nlocalStorage.setItem(KEY, v)",
        "localStorage['piapi_api_key'] = v",
        "sessionStorage.setItem('openrouter_api_key', v)",
    ]
    for sample in samples:
        assert _violations(sample), sample
    assert _violations("localStorage.setItem('blockflow:tab', v)") == []


def test_credentials_are_not_read_or_written_from_browser_storage() -> None:
    sources = _frontend_sources()
    assert sources, "no frontend sources found; the guard would pass vacuously"
    violations: list[str] = []
    for path in sources:
        text = path.read_text()
        for line_no in _violations(text):
            rel = path.relative_to(ROOT)
            violations.append(f"{rel}:{line_no}: {text.splitlines()[line_no - 1].strip()}")

    assert violations == []
