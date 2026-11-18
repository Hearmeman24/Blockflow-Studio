"""Prompt Writer provider status: what `GET /api/blocks/prompt_writer/providers`
reports for OpenRouter, Ollama and LM Studio. Fake transports only."""
from __future__ import annotations

import threading
import time

import pytest
from prompt_writer_fakes import (
    LMSTUDIO_MODELS,
    OLLAMA_TAGS,
    OPENROUTER_MODELS,
    FakeTransport,
    ok,
    raw,
)

from backend.prompt_writer import service
from backend.prompt_writer.transport import TransportError

OR_KEY = "sk-or-v1-SECRET-0123456789abcdef"
OLLAMA_TAGS_URL = "http://localhost:11434/api/tags"
LMSTUDIO_MODELS_URL = "http://localhost:1234/v1/models"
OR_MODELS_URL = "https://openrouter.ai/api/v1/models"


@pytest.fixture(autouse=True)
def _fresh_cache():
    service.reset_model_cache()
    yield
    service.reset_model_cache()


def make_deps(*, key=None, prefs=None, hosted=None, local=None):
    return service.Deps(
        hosted=hosted or FakeTransport(),
        local=local or FakeTransport(),
        get_credential=lambda name: key if name == "openrouter_api_key" else None,
        get_pref=lambda name: (prefs or {}).get(name),
    )


def by_id(statuses):
    return {s["id"]: s for s in statuses}


# === shape ==================================================================

def test_every_provider_is_reported_in_a_fixed_order_with_its_kind():
    statuses = service.provider_statuses(make_deps())
    assert [(s["id"], s["label"], s["kind"]) for s in statuses] == [
        ("openrouter", "OpenRouter", "hosted"),
        ("ollama", "Ollama", "local"),
        ("lmstudio", "LM Studio", "local"),
    ]
    for s in statuses:
        assert set(s) >= {"id", "label", "kind", "available", "reason", "models", "models_error", "base_url"}


# === OpenRouter =============================================================

def test_openrouter_without_a_key_is_unavailable_and_makes_no_request():
    hosted = FakeTransport({("GET", OR_MODELS_URL): ok(OPENROUTER_MODELS)})
    status = by_id(service.provider_statuses(make_deps(hosted=hosted)))["openrouter"]
    assert status["available"] is False
    assert status["reason"] == "No OpenRouter API key is saved"
    assert status["models"] == []
    assert hosted.calls == []


def test_blank_saved_key_counts_as_missing():
    status = by_id(service.provider_statuses(make_deps(key="   ")))["openrouter"]
    assert status["available"] is False


def test_openrouter_with_a_key_lists_text_models_sorted_by_name():
    hosted = FakeTransport({("GET", OR_MODELS_URL): ok(OPENROUTER_MODELS)})
    status = by_id(service.provider_statuses(make_deps(key=OR_KEY, hosted=hosted)))["openrouter"]
    assert status["available"] is True
    assert status["reason"] is None
    assert status["models"] == [
        {"id": "anthropic/claude-sonnet", "name": "Anthropic: Claude Sonnet", "accepts": ["image"]},
        {"id": "x-ai/grok-4.1-fast", "name": "xAI: Grok 4.1 Fast", "accepts": ["image"]},
    ]
    assert status["models_error"] is None
    (call,) = hosted.calls
    assert call.headers["Authorization"] == f"Bearer {OR_KEY}"


def test_openrouter_model_list_is_cached_between_checks():
    hosted = FakeTransport({("GET", OR_MODELS_URL): ok(OPENROUTER_MODELS)})
    deps = make_deps(key=OR_KEY, hosted=hosted)
    service.provider_statuses(deps)
    service.provider_statuses(deps)
    assert len(hosted.calls) == 1
    service.provider_statuses(deps, refresh=True)
    assert len(hosted.calls) == 2


@pytest.mark.parametrize("handler", [
    raw("<html>bad gateway</html>", 502),
    ok({"unexpected": True}),
    TransportError("timeout", "timed out"),
    TransportError("network", "unreachable"),
])
def test_openrouter_model_list_failure_keeps_it_available_with_manual_entry(handler):
    hosted = FakeTransport({("GET", OR_MODELS_URL): handler})
    status = by_id(service.provider_statuses(make_deps(key=OR_KEY, hosted=hosted)))["openrouter"]
    assert status["available"] is True
    assert status["models"] == []
    assert "type a model ID" in status["models_error"]
    assert OR_KEY not in str(status)


def test_openrouter_failed_model_list_is_not_cached():
    hosted = FakeTransport({("GET", OR_MODELS_URL): raw("", 503)})
    deps = make_deps(key=OR_KEY, hosted=hosted)
    service.provider_statuses(deps)
    hosted.routes[("GET", OR_MODELS_URL)] = ok(OPENROUTER_MODELS)
    status = by_id(service.provider_statuses(deps))["openrouter"]
    assert len(status["models"]) == 2


# === Ollama =================================================================

def test_ollama_up_with_models():
    local = FakeTransport({("GET", OLLAMA_TAGS_URL): ok(OLLAMA_TAGS)})
    status = by_id(service.provider_statuses(make_deps(local=local)))["ollama"]
    assert status["available"] is True
    assert status["base_url"] == "http://localhost:11434"
    assert status["models"] == [
        {"id": "llama3.2:latest", "name": "llama3.2:latest (3.2B)", "accepts": []},
        {"id": "qwen3:8b", "name": "qwen3:8b", "accepts": []},
    ]
    probe = next(c for c in local.calls if c.url == OLLAMA_TAGS_URL)
    assert probe.method == "GET"
    assert probe.timeout == pytest.approx(service.PROBE_TIMEOUT_S)
    assert service.PROBE_TIMEOUT_S <= 1.5


def test_ollama_up_with_no_models():
    local = FakeTransport({("GET", OLLAMA_TAGS_URL): ok({"models": []})})
    status = by_id(service.provider_statuses(make_deps(local=local)))["ollama"]
    assert status["available"] is False
    assert status["reason"] == "Ollama is running but has no models installed"


def test_ollama_down():
    status = by_id(service.provider_statuses(make_deps()))["ollama"]
    assert status["available"] is False
    assert status["reason"] == "Ollama is not running at http://localhost:11434"
    assert status["models"] == []


def test_ollama_slow_reports_a_timeout():
    local = FakeTransport({("GET", OLLAMA_TAGS_URL): TransportError("timeout", "timed out")})
    status = by_id(service.provider_statuses(make_deps(local=local)))["ollama"]
    assert status["available"] is False
    assert status["reason"] == "Ollama did not respond at http://localhost:11434 within 1.5 s"


@pytest.mark.parametrize("response, reason", [
    (raw("nope", 500), "Ollama at http://localhost:11434 answered with HTTP 500"),
    (raw("<html>hello</html>"), "The server at http://localhost:11434 did not answer like Ollama"),
    (ok({"models": "x"}), "The server at http://localhost:11434 did not answer like Ollama"),
])
def test_ollama_unexpected_answers(response, reason):
    local = FakeTransport({("GET", OLLAMA_TAGS_URL): response})
    status = by_id(service.provider_statuses(make_deps(local=local)))["ollama"]
    assert status["available"] is False
    assert status["reason"] == reason


def test_ollama_uses_the_saved_base_url():
    url = "http://192.168.1.20:11434/api/tags"
    local = FakeTransport({("GET", url): ok(OLLAMA_TAGS)})
    deps = make_deps(local=local, prefs={"ollama_base_url": "http://192.168.1.20:11434/"})
    status = by_id(service.provider_statuses(deps))["ollama"]
    assert status["available"] is True
    assert status["base_url"] == "http://192.168.1.20:11434"


def test_invalid_saved_base_url_is_never_probed():
    local = FakeTransport()
    deps = make_deps(local=local, prefs={"ollama_base_url": "ftp://user:pw@host"})
    status = by_id(service.provider_statuses(deps))["ollama"]
    assert status["available"] is False
    assert status["reason"].startswith("The Ollama server URL in Settings is not valid")
    assert "pw" not in status["reason"]
    assert not any("ftp" in c.url or "host" in c.url and "localhost" not in c.url for c in local.calls)


# === LM Studio ==============================================================

def test_lmstudio_up_with_models_skips_embedding_models():
    local = FakeTransport({("GET", LMSTUDIO_MODELS_URL): ok(LMSTUDIO_MODELS)})
    status = by_id(service.provider_statuses(make_deps(local=local)))["lmstudio"]
    assert status["available"] is True
    assert status["base_url"] == "http://localhost:1234"
    assert status["models"] == [{"id": "google/gemma-3-12b", "name": "google/gemma-3-12b", "accepts": []}]


@pytest.mark.parametrize("data", [[], [{"id": "text-embedding-nomic-embed-text-v1.5"}]])
def test_lmstudio_up_with_no_chat_model(data):
    local = FakeTransport({("GET", LMSTUDIO_MODELS_URL): ok({"data": data})})
    status = by_id(service.provider_statuses(make_deps(local=local)))["lmstudio"]
    assert status["available"] is False
    assert status["reason"] == "LM Studio is running but has no model loaded"


def test_lmstudio_down():
    status = by_id(service.provider_statuses(make_deps()))["lmstudio"]
    assert status["reason"] == "LM Studio is not running at http://localhost:1234"


def test_lmstudio_slow():
    local = FakeTransport({("GET", LMSTUDIO_MODELS_URL): TransportError("timeout", "slow")})
    status = by_id(service.provider_statuses(make_deps(local=local)))["lmstudio"]
    assert status["reason"] == "LM Studio did not respond at http://localhost:1234 within 1.5 s"


# === combinations, bounded time, never raising ==============================

@pytest.mark.parametrize("key", [None, OR_KEY])
@pytest.mark.parametrize("ollama", ["models", "empty", "down", "slow"])
@pytest.mark.parametrize("lmstudio", ["models", "empty", "down", "slow"])
def test_every_combination(key, ollama, lmstudio):
    routes = {}
    answers = {
        "models": (ok(OLLAMA_TAGS), ok(LMSTUDIO_MODELS)),
        "empty": (ok({"models": []}), ok({"data": []})),
        "slow": (TransportError("timeout", "t"), TransportError("timeout", "t")),
    }
    if ollama != "down":
        routes[("GET", OLLAMA_TAGS_URL)] = answers[ollama][0]
    if lmstudio != "down":
        routes[("GET", LMSTUDIO_MODELS_URL)] = answers[lmstudio][1]
    hosted = FakeTransport({("GET", OR_MODELS_URL): ok(OPENROUTER_MODELS)})
    statuses = by_id(service.provider_statuses(make_deps(key=key, hosted=hosted, local=FakeTransport(routes))))
    assert statuses["openrouter"]["available"] is (key is not None)
    assert statuses["ollama"]["available"] is (ollama == "models")
    assert statuses["lmstudio"]["available"] is (lmstudio == "models")
    for s in statuses.values():
        assert s["available"] is (s["reason"] is None)
        if not s["available"]:
            assert s["models"] == []


def test_probes_run_in_parallel_and_are_bounded_even_if_a_transport_hangs():
    release = threading.Event()

    def hang(_call):
        release.wait(10)
        raise TransportError("timeout", "late")

    local = FakeTransport({("GET", OLLAMA_TAGS_URL): hang, ("GET", LMSTUDIO_MODELS_URL): hang})
    start = time.monotonic()
    try:
        statuses = by_id(service.provider_statuses(make_deps(local=local)))
    finally:
        release.set()
    elapsed = time.monotonic() - start
    assert elapsed < service.PROBE_TIMEOUT_S + 1.0
    assert statuses["ollama"]["reason"] == "Ollama did not respond at http://localhost:11434 within 1.5 s"
    assert statuses["lmstudio"]["available"] is False


def test_a_crashing_probe_never_raises():
    def boom(_call):
        raise RuntimeError("unexpected bug")

    local = FakeTransport({("GET", OLLAMA_TAGS_URL): boom})
    hosted = FakeTransport({("GET", OR_MODELS_URL): boom})
    statuses = by_id(service.provider_statuses(make_deps(key=OR_KEY, local=local, hosted=hosted)))
    assert statuses["ollama"]["available"] is False
    assert statuses["ollama"]["reason"] == "Could not check Ollama at http://localhost:11434"
    assert statuses["openrouter"]["available"] is True
    assert statuses["openrouter"]["models"] == []


def test_a_crashing_settings_read_never_raises():
    def broken(_name):
        raise RuntimeError("database is locked")

    deps = service.Deps(hosted=FakeTransport(), local=FakeTransport(), get_credential=broken, get_pref=broken)
    statuses = by_id(service.provider_statuses(deps))
    assert statuses["openrouter"]["available"] is False
    assert statuses["ollama"]["available"] is False
