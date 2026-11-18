"""save_run must normalize created_at to canonical UTC-Z millis and clamp
future values, so a bad timestamp can't float an artifact to the top of the
text-sorted Artifacts list (observed: imported rows dated ~22min in the
future pinned above everything).
"""
from __future__ import annotations

import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import db  # noqa: E402

CANON = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "norm.db")
    db.init_db()
    return db


def _save(temp_db, run_id: str, created_at) -> str:
    temp_db.save_run({
        "id": run_id, "name": run_id, "status": "completed", "duration_ms": 0,
        "flow_snapshot": {}, "block_results": [], "created_at": created_at,
    })
    row = temp_db.get_run(run_id)
    return row["created_at"]


def test_future_created_at_is_clamped_to_now(temp_db):
    future = (datetime.now(timezone.utc) + timedelta(minutes=22)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    got = _save(temp_db, "future", future)
    assert CANON.match(got), got
    # clamped: not in the future
    assert got <= datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.999Z")


def test_naive_timestamp_normalized_to_utc_z(temp_db):
    got = _save(temp_db, "naive", "2026-06-27T11:16:03")
    assert got == "2026-06-27T11:16:03.000Z", got


def test_valid_past_iso_preserved_as_canonical(temp_db):
    got = _save(temp_db, "past", "2026-05-30T00:00:00.171Z")
    assert got == "2026-05-30T00:00:00.171Z", got


def test_garbage_falls_back_to_now(temp_db):
    got = _save(temp_db, "junk", "not a date")
    assert CANON.match(got), got


def test_future_row_is_clamped_not_an_hour_ahead(temp_db):
    got = _save(temp_db, "junk-future", (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat())
    ceiling = (datetime.now(timezone.utc) + timedelta(seconds=5)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    assert got <= ceiling, f"{got} still ahead of {ceiling}"
