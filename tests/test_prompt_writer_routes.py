"""HTTP routes of the Prompt Writer sidecar (`/api/blocks/prompt_writer/...`)
and the local-server URL prefs in the settings routes."""
from __future__ import annotations

import importlib.util
import logging
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from prompt_writer_fakes import OLLAMA_TAGS, FakeTransport, ok

from backend import settings_store
from backend.prompt_writer import base_urls, service
from backend.settings_routes import router as settings_router

ROOT = Path(__file__).resolve().parent.parent
SIDECAR = ROOT / "custom_blocks" / "prompt_writer" / "backend.block.py"
OR_KEY = "sk-or-v1-SECRET-0123456789abcdef"
OR_CHAT = "https://openrouter.ai/api/v1/chat/completions"


def _load_router():
    spec = importlib.util.spec_from_file_location("custom_block_prompt_writer_backend_test", SIDECAR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.router


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_store, "DB_PATH", tmp_path / "pw.db")
    settings_store.init_db()


@pytest.fixture
def fakes(monkeypatch, db):
    hosted = FakeTransport({("POST", OR_CHAT): ok({"choices": [{"message": {"content": "A fox."}}]})})
    local = FakeTransport({("GET", "http://localhost:11434/api/tags"): ok(OLLAMA_TAGS)})
    real_default = service.default_deps

    def deps():
        d = real_default()
        return service.Deps(hosted=hosted, local=local, get_credential=d.get_credential, get_pref=d.get_pref)

    monkeypatch.setattr(service, "default_deps", deps)
    service.reset_model_cache()
    return hosted, local


@pytest.fixture
def client(fakes):
    app = FastAPI()
    app.include_router(_load_router(), prefix="/api/blocks/prompt_writer")
    app.include_router(settings_router)
    return TestClient(app)


def test_providers_route_reads_the_saved_key_and_prefs(client):
    r = client.get("/api/blocks/prompt_writer/providers")
    assert r.status_code == 200
    statuses = {p["id"]: p for p in r.json()["providers"]}
    assert statuses["openrouter"]["available"] is False
    assert statuses["ollama"]["available"] is True

    settings_store.set_credential("openrouter_api_key", OR_KEY)
    statuses = {p["id"]: p for p in client.get("/api/blocks/prompt_writer/providers").json()["providers"]}
    assert statuses["openrouter"]["available"] is True
    assert OR_KEY not in client.get("/api/blocks/prompt_writer/providers").text


def test_generate_route_uses_the_server_side_key(client, fakes):
    hosted, _ = fakes
    settings_store.set_credential("openrouter_api_key", OR_KEY)
    r = client.post("/api/blocks/prompt_writer/generate",
                    json={"provider": "openrouter", "model": "m", "input": "fox"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "text": "A fox.", "provider": "openrouter", "model": "m"}
    assert hosted.calls[0].headers["Authorization"] == f"Bearer {OR_KEY}"
    assert OR_KEY not in r.text


@pytest.mark.parametrize("body, status, kind", [
    ({"provider": "openrouter", "model": "m", "input": "  "}, 422, "validation"),
    ({"provider": "openrouter", "model": "m", "input": "fox"}, 503, "unavailable"),
])
def test_generate_route_error_status_codes(client, body, status, kind):
    r = client.post("/api/blocks/prompt_writer/generate", json=body)
    assert r.status_code == status
    assert r.json()["ok"] is False
    assert r.json()["kind"] == kind


def test_generate_route_refuses_media_a_local_provider_cannot_take_with_422(client, fakes):
    _, local = fakes
    body = {"provider": "ollama", "model": "llama3.2:latest", "input": "fox",
            "media": [{"kind": "video", "role": "reference", "local": "/outputs/clip.mp4"}]}
    r = client.post("/api/blocks/prompt_writer/generate", json=body)
    assert r.status_code == 422
    assert r.json()["kind"] == "validation"
    assert "images only" in r.json()["message"]
    assert not any(c.method == "POST" for c in local.calls)


def test_generate_route_refuses_a_path_outside_the_output_folder_without_echo(client):
    body = {"provider": "openrouter", "model": "m", "input": "fox",
            "media": [{"kind": "image", "local": "/outputs/../../SECRET-PATH.png"}]}
    settings_store.set_credential("openrouter_api_key", OR_KEY)
    r = client.post("/api/blocks/prompt_writer/generate", json=body)
    assert r.status_code == 422
    assert "SECRET-PATH" not in r.text


def test_generate_route_rejects_malformed_json_without_echo(client):
    r = client.post("/api/blocks/prompt_writer/generate", content=b"{not json sk-or-v1-LEAK",
                    headers={"Content-Type": "application/json"})
    assert r.status_code == 422
    assert r.json()["kind"] == "validation"
    assert "LEAK" not in r.text


def test_generate_route_never_logs_the_key_or_the_input(client, fakes, caplog):
    settings_store.set_credential("openrouter_api_key", OR_KEY)
    with caplog.at_level(logging.DEBUG):
        client.post("/api/blocks/prompt_writer/generate",
                    json={"provider": "openrouter", "model": "m", "input": "PRIVATE-IDEA"})
    assert OR_KEY not in caplog.text
    assert "PRIVATE-IDEA" not in caplog.text


def test_check_key_route(client, fakes):
    hosted, _ = fakes
    hosted.routes[("GET", "https://openrouter.ai/api/v1/key")] = ok({"data": {"label": "x"}})
    settings_store.set_credential("openrouter_api_key", OR_KEY)
    r = client.post("/api/blocks/prompt_writer/check-key")
    assert r.json() == {"ok": True, "valid": True, "message": "OpenRouter accepted the key."}
    assert OR_KEY not in r.text


# === base URL prefs =========================================================

@pytest.mark.parametrize("value, expected", [
    ("http://localhost:11434", "http://localhost:11434"),
    ("http://localhost:11434/", "http://localhost:11434"),
    ("  https://ollama.lan:8443/base/  ", "https://ollama.lan:8443/base"),
    ("http://127.0.0.1:1234", "http://127.0.0.1:1234"),
    ("http://[::1]:1234", "http://[::1]:1234"),
    ("HTTP://LOCALHOST:1234", "http://localhost:1234"),
])
def test_valid_base_urls_are_normalised(value, expected):
    assert base_urls.validate_base_url(value) == expected


@pytest.mark.parametrize("value, fragment", [
    ("localhost:11434", "http:// or https://"),
    ("ftp://localhost", "http:// or https://"),
    ("javascript:alert(1)", "http:// or https://"),
    ("file:///etc/passwd", "http:// or https://"),
    ("http://", "host"),
    ("http://user:secret@localhost:1234", "user name or password"),
    ("http://user@localhost:1234", "user name or password"),
    ("http://localhost:1234/?x=1", "query"),
    ("http://localhost:1234/#frag", "fragment"),
    ("http://local host:1234", "spaces"),
    ("http://localhost:99999", "port"),
    ("http://localhost:1234/" + "a" * 2100, "too long"),
    ("http://lоcalhost:1234", "ASCII"),
])
def test_invalid_base_urls_are_rejected_with_a_clear_message(value, fragment):
    with pytest.raises(base_urls.InvalidBaseUrl) as exc:
        base_urls.validate_base_url(value)
    assert fragment in str(exc.value)
    assert "secret" not in str(exc.value)


@pytest.mark.parametrize("pref", ["ollama_base_url", "lmstudio_base_url"])
def test_pref_route_saves_a_normalised_url(client, pref):
    r = client.put(f"/api/settings/app-prefs/{pref}", json={"value": "http://192.168.1.4:1234/"})
    assert r.status_code == 200
    assert settings_store.get_app_pref(pref) == "http://192.168.1.4:1234"


@pytest.mark.parametrize("pref", ["ollama_base_url", "lmstudio_base_url"])
def test_pref_route_rejects_an_invalid_url_and_keeps_the_old_value(client, pref):
    settings_store.set_app_pref(pref, "http://localhost:9999")
    r = client.put(f"/api/settings/app-prefs/{pref}", json={"value": "http://admin:hunter2@evil:1/?q"})
    assert r.status_code == 400
    assert "hunter2" not in r.text
    assert settings_store.get_app_pref(pref) == "http://localhost:9999"


def test_pref_route_empty_value_resets_to_default(client, fakes):
    _, local = fakes
    settings_store.set_app_pref("ollama_base_url", "http://10.1.1.1:11434")
    r = client.put("/api/settings/app-prefs/ollama_base_url", json={"value": ""})
    assert r.status_code == 200
    statuses = {p["id"]: p for p in client.get("/api/blocks/prompt_writer/providers").json()["providers"]}
    assert statuses["ollama"]["base_url"] == "http://localhost:11434"


def test_defaults_are_exposed():
    assert base_urls.DEFAULT_BASE_URLS == {"ollama": "http://localhost:11434", "lmstudio": "http://localhost:1234"}
    assert base_urls.PREF_NAMES == {"ollama": "ollama_base_url", "lmstudio": "lmstudio_base_url"}
