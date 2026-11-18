"""The frontend status-contract fixture must match the backend enums exactly.

``frontend/src/lib/status/__fixtures__/status-contract.json`` lists every
status vocabulary declared in ``backend/statuses.py``. The frontend status
module asserts its own lists against it (``status-contract.test.ts``), so a
status added or renamed in the backend fails a test until the frontend copy
follows.

To refresh the fixture after a deliberate change to ``backend/statuses.py``:

    uv run python tests/test_status_contract_fixture.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend import statuses  # noqa: E402

FIXTURE = ROOT / "frontend" / "src" / "lib" / "status" / "__fixtures__" / "status-contract.json"


def render() -> str:
    return json.dumps(statuses.contract(), ensure_ascii=False, indent=2) + "\n"


def test_fixture_matches_backend_statuses() -> None:
    assert FIXTURE.is_file(), f"{FIXTURE} is missing; run `uv run python tests/test_status_contract_fixture.py`"
    assert FIXTURE.read_text(encoding="utf-8") == render(), (
        "status-contract.json is out of date with backend/statuses.py; "
        "run `uv run python tests/test_status_contract_fixture.py` and commit the result"
    )


def test_contract_lists_every_value_of_every_enum_in_declaration_order() -> None:
    contract = statuses.contract()
    assert contract["job_status"] == ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]
    assert contract["job_status_active"] == ["QUEUED", "RUNNING"]
    assert contract["job_status_terminal"] == ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]
    assert contract["run_status"] == ["completed", "partial", "failed"]
    assert contract["block_result_status"] == ["idle", "running", "completed", "error", "skipped", "cancelled"]
    assert contract["update_state"] == ["idle", "running", "restarting", "done", "failed", "rolled_back"]
    assert contract["update_step_status"] == ["pending", "running", "done", "failed", "skipped"]
    assert contract["error_kind"][-1] == "interrupted"
    for key, values in contract.items():
        assert values and all(type(v) is str for v in values), key
        assert len(set(values)) == len(values), key


if __name__ == "__main__":
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(render(), encoding="utf-8")
    print(f"wrote {FIXTURE}")
