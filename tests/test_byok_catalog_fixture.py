"""The frontend catalog fixtures must match the capability ledger exactly.

``frontend/src/lib/byok/__fixtures__/catalog.*.json`` are what the frontend
tests (and the typed catalog model) are built against. Regenerating each
payload here and comparing it byte for byte means a ledger change that is not
mirrored in the fixtures fails CI instead of silently drifting.

To refresh the fixtures after a deliberate ledger change:

    uv run python tests/test_byok_catalog_fixture.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.byok import ledger  # noqa: E402

FIXTURE_DIR = ROOT / "frontend" / "src" / "lib" / "byok" / "__fixtures__"

# fixture name -> configured providers
FIXTURES: dict[str, frozenset[str]] = {
    "catalog.kie_piapi.json": frozenset({"kie", "piapi"}),
    "catalog.kie.json": frozenset({"kie"}),
    "catalog.piapi.json": frozenset({"piapi"}),
    "catalog.none.json": frozenset(),
}


def render(configured: frozenset[str]) -> str:
    return json.dumps(ledger.catalog_payload(set(configured)), ensure_ascii=False, separators=(",", ":")) + "\n"


@pytest.mark.parametrize("name", sorted(FIXTURES))
def test_fixture_matches_ledger(name: str) -> None:
    path = FIXTURE_DIR / name
    assert path.is_file(), f"{path} is missing; run `uv run python tests/test_byok_catalog_fixture.py`"
    committed = path.read_text(encoding="utf-8")
    expected = render(FIXTURES[name])
    assert committed == expected, (
        f"{name} is out of date with backend/byok/ledger.py; "
        "run `uv run python tests/test_byok_catalog_fixture.py` and commit the result"
    )


def test_fixtures_cover_every_key_combination() -> None:
    combos = {frozenset(c) for c in FIXTURES.values()}
    assert combos == {frozenset(), frozenset({"kie"}), frozenset({"piapi"}), frozenset({"kie", "piapi"})}
    for name, configured in FIXTURES.items():
        payload = json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))
        assert {p for p, v in payload["providers"].items() if v["configured"]} == set(configured)


if __name__ == "__main__":
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    for fixture_name, providers in FIXTURES.items():
        (FIXTURE_DIR / fixture_name).write_text(render(providers), encoding="utf-8")
        print(f"wrote {FIXTURE_DIR / fixture_name}")
