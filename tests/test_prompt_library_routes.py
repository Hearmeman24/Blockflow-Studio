"""HTTP route tests for /api/prompt-library (saved prompts).

The library is one JSON list in the user data folder. Three types share it:
``generation`` (prompts in generation blocks), ``system`` and ``user`` (the
Prompt Writer). Every test points the file at a temp folder; the user's real
library is never read or written.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import config, prompt_library, routes  # noqa: E402


@pytest.fixture
def library(tmp_path, monkeypatch) -> Path:
    path = tmp_path / "data" / "prompt_library.json"
    path.parent.mkdir()
    monkeypatch.setattr(config, "PROMPT_LIBRARY_PATH", path)
    return path


@pytest.fixture
def client(library):
    app = FastAPI()
    app.include_router(routes.router)
    return TestClient(app)


def _save(client, name="Sunset", type_="generation", content="a sunset over the sea"):
    return client.post("/api/prompt-library", json={"name": name, "type": type_, "content": content})


def test_conftest_keeps_the_real_library_out_of_reach():
    # The shared fixture redirects the user data folder; the library follows it.
    assert config.PROMPT_LIBRARY_PATH.parent == config.USER_DATA_DIR


def test_starts_empty_when_the_file_does_not_exist(client, library):
    r = client.get("/api/prompt-library")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "prompts": []}
    assert not library.exists()


@pytest.mark.parametrize("type_", ["generation", "system", "user"])
def test_saves_each_of_the_three_types(client, library, type_):
    r = _save(client, type_=type_)
    assert r.status_code == 200, r.text
    prompt = r.json()["prompt"]
    assert prompt["type"] == type_ and prompt["name"] == "Sunset" and prompt["content"] == "a sunset over the sea"
    assert prompt["id"] and prompt["created_at"]
    stored = json.loads(library.read_text(encoding="utf-8"))
    assert stored == [prompt]
    assert client.get("/api/prompt-library").json()["prompts"] == [prompt]


def test_trims_the_name_and_keeps_the_content_as_typed(client):
    prompt = _save(client, name="  Night city  ", content="  line one\nline two  ").json()["prompt"]
    assert prompt["name"] == "Night city"
    assert prompt["content"] == "  line one\nline two  "


@pytest.mark.parametrize(
    ("body", "field"),
    [
        ({"name": "", "type": "generation", "content": "x"}, "name"),
        ({"name": "   \t", "type": "generation", "content": "x"}, "name"),
        ({"type": "generation", "content": "x"}, "name"),
        ({"name": 5, "type": "generation", "content": "x"}, "name"),
        ({"name": "a", "type": "generation", "content": ""}, "prompt"),
        ({"name": "a", "type": "generation", "content": " \n\t "}, "prompt"),
        ({"name": "a", "type": "generation"}, "prompt"),
        ({"name": "a", "type": "generation", "content": ["x"]}, "prompt"),
        ({"name": "a", "type": "negative", "content": "x"}, "type"),
        ({"name": "a", "content": "x"}, "type"),
    ],
)
def test_rejects_missing_or_empty_fields(client, library, body, field):
    r = client.post("/api/prompt-library", json=body)
    assert r.status_code == 422
    data = r.json()
    assert data["ok"] is False and data["kind"] == "validation"
    assert field in data["error"].lower()
    assert not library.exists()


def test_caps_the_name_length(client, library):
    ok = _save(client, name="n" * prompt_library.MAX_NAME_LENGTH)
    assert ok.status_code == 200
    r = _save(client, name="m" * (prompt_library.MAX_NAME_LENGTH + 1))
    assert r.status_code == 422
    assert str(prompt_library.MAX_NAME_LENGTH) in r.json()["error"]
    assert len(json.loads(library.read_text(encoding="utf-8"))) == 1


def test_caps_the_content_length_generously(client, library):
    assert prompt_library.MAX_CONTENT_LENGTH >= 20_000
    long_text = "word " * (prompt_library.MAX_CONTENT_LENGTH // 5)
    assert _save(client, content=long_text).status_code == 200
    r = _save(client, name="Too long", content="x" * (prompt_library.MAX_CONTENT_LENGTH + 1))
    assert r.status_code == 422
    assert "20,000" in r.json()["error"] or str(prompt_library.MAX_CONTENT_LENGTH) in r.json()["error"]


def test_never_echoes_the_body(client):
    secret_like = "sk-THIS-SHOULD-NOT-COME-BACK"
    for body in (
        {"name": secret_like, "type": "nope", "content": secret_like},
        {"name": "", "type": "generation", "content": secret_like},
    ):
        r = client.post("/api/prompt-library", json=body)
        assert r.status_code == 422
        assert secret_like not in r.text
    r = client.post("/api/prompt-library", content=b"{not json " + secret_like.encode(), headers={"Content-Type": "application/json"})
    assert r.status_code == 422
    assert r.json()["kind"] == "validation"
    assert secret_like not in r.text
    r = client.post("/api/prompt-library", json=[secret_like])
    assert r.status_code == 422 and secret_like not in r.text


def test_rejects_a_duplicate_name_of_the_same_type_but_not_of_another(client, library):
    assert _save(client, name="Portrait").status_code == 200
    r = _save(client, name="  portrait ", content="other text")
    assert r.status_code == 409
    assert r.json()["kind"] == "duplicate"
    assert "Portrait" in r.json()["error"]
    # Same name, other type: a different list in the UI, so it is allowed.
    assert _save(client, name="Portrait", type_="system").status_code == 200
    assert [p["type"] for p in json.loads(library.read_text(encoding="utf-8"))] == ["generation", "system"]


def test_unicode_and_emoji_round_trip(client, library):
    content = "Ein Fuchs im Schnee 🦊, 夜の東京, «кино» — naïve café\nZWJ: 👩‍🚀"
    prompt = _save(client, name="狐 🦊", content=content).json()["prompt"]
    assert prompt["content"] == content and prompt["name"] == "狐 🦊"
    assert client.get("/api/prompt-library").json()["prompts"][0]["content"] == content
    assert json.loads(library.read_text(encoding="utf-8"))[0]["content"] == content


def test_keeps_existing_entries_from_the_old_format(client, library):
    old = [
        {"id": "prompt-1-abc", "name": "Old system", "type": "system", "content": "be terse", "created_at": "2025-01-01T00:00:00+00:00"},
        {"id": "prompt-2-def", "name": "Old user", "type": "user", "content": "a fox", "created_at": "2025-01-02T00:00:00+00:00"},
    ]
    library.write_text(json.dumps(old, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    assert client.get("/api/prompt-library").json()["prompts"] == old
    new = _save(client).json()["prompt"]
    assert json.loads(library.read_text(encoding="utf-8")) == [*old, new]


def test_lists_only_well_formed_entries_but_never_drops_the_others(client, library):
    good = {"id": "p1", "name": "Good", "type": "generation", "content": "ok", "created_at": "x"}
    odd = [good, "not an entry", {"id": "p2", "type": "mystery", "name": "?", "content": "?"}]
    library.write_text(json.dumps(odd), encoding="utf-8")
    assert client.get("/api/prompt-library").json()["prompts"] == [good]
    new = _save(client).json()["prompt"]
    assert json.loads(library.read_text(encoding="utf-8")) == [*odd, new]


def test_deletes_one_entry(client, library):
    a = _save(client, name="A").json()["prompt"]
    b = _save(client, name="B").json()["prompt"]
    r = client.delete(f"/api/prompt-library/{a['id']}")
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert json.loads(library.read_text(encoding="utf-8")) == [b]


def test_deleting_a_missing_entry_is_a_readable_404(client, library):
    _save(client)
    before = library.read_text(encoding="utf-8")
    r = client.delete("/api/prompt-library/prompt-does-not-exist")
    assert r.status_code == 404
    assert r.json()["ok"] is False and r.json()["kind"] == "not_found"
    assert library.read_text(encoding="utf-8") == before


@pytest.mark.parametrize("raw", ["{not json", '{"prompts": []}', '"text"', "null", "\x00\x01"])
def test_a_corrupt_file_is_reported_and_never_overwritten(client, library, raw):
    library.write_text(raw, encoding="utf-8")
    r = client.get("/api/prompt-library")
    assert r.status_code == 500
    assert r.json()["ok"] is False and r.json()["kind"] == "corrupt"
    assert "prompt_library.json" in r.json()["error"]

    r = _save(client)
    assert r.status_code == 500 and r.json()["kind"] == "corrupt"
    r = client.delete("/api/prompt-library/anything")
    assert r.status_code == 500 and r.json()["kind"] == "corrupt"
    assert library.read_text(encoding="utf-8") == raw


def test_writes_are_atomic_a_failed_replace_leaves_the_old_file(client, library, monkeypatch):
    first = _save(client, name="Keep me").json()["prompt"]
    before = library.read_text(encoding="utf-8")

    def boom(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(prompt_library.os, "replace", boom)
    r = _save(client, name="Lost")
    assert r.status_code == 500
    assert r.json()["kind"] == "write_failed"
    assert "nothing was saved" in r.json()["error"].lower()
    assert library.read_text(encoding="utf-8") == before
    assert json.loads(before) == [first]
    # No temp file is left beside the library.
    assert sorted(p.name for p in library.parent.iterdir()) == ["prompt_library.json"]


def test_the_write_goes_through_a_temp_file_in_the_same_folder(client, library, monkeypatch):
    seen: list[tuple[Path, Path]] = []
    real_replace = os.replace

    def spy(src, dst):
        seen.append((Path(src), Path(dst)))
        real_replace(src, dst)

    monkeypatch.setattr(prompt_library.os, "replace", spy)
    _save(client)
    assert len(seen) == 1
    src, dst = seen[0]
    assert dst == library and src.parent == library.parent and src != library
