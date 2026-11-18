"""Prompt Writer model capabilities: which models are listed (text output only)
and which extra input kinds (image, video, audio) each one accepts, for
OpenRouter, Ollama (``POST /api/show``) and LM Studio (``GET /api/v1/models``).
Fake transports only."""
from __future__ import annotations

import threading
import time

import pytest
from prompt_writer_fakes import LMSTUDIO_MODELS, OLLAMA_TAGS, FakeTransport, ok, raw

from backend.prompt_writer import service
from backend.prompt_writer.providers import ModelInfo, OpenRouterProvider
from backend.prompt_writer.transport import TransportError

OR_KEY = "sk-or-v1-SECRET-0123456789abcdef"
OR_MODELS_URL = "https://openrouter.ai/api/v1/models"
OLLAMA_TAGS_URL = "http://localhost:11434/api/tags"
OLLAMA_SHOW_URL = "http://localhost:11434/api/show"
LMSTUDIO_MODELS_URL = "http://localhost:1234/v1/models"
LMSTUDIO_NATIVE_URL = "http://localhost:1234/api/v1/models"


@pytest.fixture(autouse=True)
def _fresh_cache():
    service.reset_model_cache()
    yield
    service.reset_model_cache()


def make_deps(*, key=None, hosted=None, local=None):
    return service.Deps(
        hosted=hosted or FakeTransport(),
        local=local or FakeTransport(),
        get_credential=lambda name: key if name == "openrouter_api_key" else None,
        get_pref=lambda _name: None,
    )


def by_id(statuses):
    return {s["id"]: s for s in statuses}


def row(model_id, *, ins=None, outs=None, modality=None, name=None):
    arch = {}
    if ins is not None:
        arch["input_modalities"] = ins
    if outs is not None:
        arch["output_modalities"] = outs
    if modality is not None:
        arch["modality"] = modality
    return {"id": model_id, "name": name or model_id, "architecture": arch}


# === OpenRouter: text output only ===========================================

def parse(rows):
    return OpenRouterProvider(OR_KEY).parse_models({"data": rows})


@pytest.mark.parametrize("arch_row, listed", [
    (row("a", ins=["text"], outs=["text"]), True),
    (row("b", ins=["text", "image"], outs=["text"]), True),
    (row("c", ins=["text", "image"], outs=["text", "image"]), False),   # image output plus text
    (row("d", ins=["text"], outs=["image"]), False),
    (row("e", ins=["text"], outs=["text", "audio"]), False),
    (row("f", ins=["text"], outs=["text", "video"]), False),
    (row("g", ins=["image"], outs=["text"]), False),                    # no text input
    (row("h", ins=["text"], outs=["embeddings"]), False),
    (row("i", ins=["TEXT", "Image"], outs=["Text"]), True),             # case-insensitive
    (row("j", ins=["text"], outs=[]), False),
    (row("k", modality="text->text"), True),
    (row("l", modality="text+image->text"), True),
    (row("m", modality="text->text+image"), False),                     # legacy string, image output
    (row("n", modality="text+image->image"), False),
    (row("o", modality="image->text"), False),
    (row("p", modality="text"), False),                                 # no arrow
    (row("q"), False),                                                  # no modality data
])
def test_openrouter_lists_only_models_whose_only_output_is_text(arch_row, listed):
    assert bool(parse([arch_row])) is listed


@pytest.mark.parametrize("bad", [
    "not-a-dict", None, 5, [], {"id": "x"}, {"id": "x", "architecture": "text->text"},
    {"id": "", "architecture": {"modality": "text->text"}},
    {"id": "   ", "architecture": {"modality": "text->text"}},
    {"id": "x", "architecture": {"input_modalities": "text", "output_modalities": "text"}},
    {"id": "x", "architecture": {"input_modalities": [None, 3], "output_modalities": ["text"]}},
])
def test_openrouter_skips_empty_and_malformed_rows(bad):
    assert parse([bad]) == []


@pytest.mark.parametrize("arch_row, accepts", [
    (row("a", ins=["text"], outs=["text"]), ()),
    (row("b", ins=["text", "image"], outs=["text"]), ("image",)),
    (row("c", ins=["text", "image", "file", "audio", "video"], outs=["text"]), ("image", "video", "audio")),
    (row("d", ins=["video", "text"], outs=["text"]), ("video",)),
    (row("e", modality="text+image->text"), ("image",)),
    (row("f", modality="text+image+audio+video->text"), ("image", "video", "audio")),
    (row("g", modality="text+file->text"), ()),
])
def test_openrouter_models_carry_the_extra_input_kinds_they_accept(arch_row, accepts):
    (model,) = parse([arch_row])
    assert model.accepts == accepts
    assert model.to_dict() == {"id": model.id, "name": model.name, "accepts": list(accepts)}


def test_model_info_defaults_to_text_only():
    assert ModelInfo("m", "M").to_dict() == {"id": "m", "name": "M", "accepts": []}


def test_openrouter_status_exposes_accepts_and_caches_it():
    rows = {"data": [row("v", ins=["text", "image", "video"], outs=["text"], name="Vision")]}
    hosted = FakeTransport({("GET", OR_MODELS_URL): ok(rows)})
    deps = make_deps(key=OR_KEY, hosted=hosted)
    first = by_id(service.provider_statuses(deps))["openrouter"]
    second = by_id(service.provider_statuses(deps))["openrouter"]
    assert first["models"] == [{"id": "v", "name": "Vision", "accepts": ["image", "video"]}]
    assert second["models"] == first["models"]
    assert len(hosted.calls) == 1


# === Ollama: POST /api/show per model =======================================

def show(capabilities_by_model):
    """A handler for /api/show answering from ``{name: capabilities | handler}``."""
    def handle(call):
        name = call.json()["model"]
        answer = capabilities_by_model.get(name)
        if isinstance(answer, BaseException):
            raise answer
        if callable(answer):
            return answer(call)
        if answer is None:
            return raw('{"error":"model not found"}', 404)
        return ok(answer)
    return handle


def ollama(show_handler):
    return FakeTransport({("GET", OLLAMA_TAGS_URL): ok(OLLAMA_TAGS), ("POST", OLLAMA_SHOW_URL): show_handler})


def test_ollama_marks_vision_models_as_accepting_images():
    local = ollama(show({
        "llama3.2:latest": {"capabilities": ["completion", "tools"]},
        "qwen3:8b": {"capabilities": ["completion", "vision", "thinking"]},
    }))
    status = by_id(service.provider_statuses(make_deps(local=local)))["ollama"]
    assert status["available"] is True
    assert status["models"] == [
        {"id": "llama3.2:latest", "name": "llama3.2:latest (3.2B)", "accepts": []},
        {"id": "qwen3:8b", "name": "qwen3:8b", "accepts": ["image"]},
    ]
    shows = [c for c in local.calls if c.url == OLLAMA_SHOW_URL]
    assert sorted(c.json()["model"] for c in shows) == ["llama3.2:latest", "qwen3:8b"]
    assert all(c.method == "POST" and c.json() == {"model": c.json()["model"]} for c in shows)
    assert all(c.timeout <= service.OLLAMA_SHOW_TIMEOUT_S for c in shows)


@pytest.mark.parametrize("answer", [
    {},                                         # older server: no capabilities field
    {"capabilities": "vision"},                 # malformed
    {"capabilities": None},
    TransportError("timeout", "slow"),
    TransportError("refused", "gone"),
    None,                                       # HTTP 404
    lambda _call: raw("<html>", 200),           # not JSON
    lambda _call: (_ for _ in ()).throw(RuntimeError("bug")),
])
def test_ollama_show_problems_make_that_model_text_only_and_never_unavailable(answer):
    local = ollama(show({"llama3.2:latest": answer, "qwen3:8b": {"capabilities": ["completion", "vision"]}}))
    status = by_id(service.provider_statuses(make_deps(local=local)))["ollama"]
    assert status["available"] is True
    accepts = {m["id"]: m["accepts"] for m in status["models"]}
    assert accepts == {"llama3.2:latest": [], "qwen3:8b": ["image"]}


def test_ollama_show_never_reports_video_or_audio():
    local = ollama(show({"llama3.2:latest": {"capabilities": ["vision", "audio", "video"]},
                         "qwen3:8b": {"capabilities": []}}))
    status = by_id(service.provider_statuses(make_deps(local=local)))["ollama"]
    assert {m["id"]: m["accepts"] for m in status["models"]} == {"llama3.2:latest": ["image"], "qwen3:8b": []}


def test_ollama_capabilities_are_cached_until_a_refresh():
    local = ollama(show({"llama3.2:latest": {"capabilities": ["vision"]}, "qwen3:8b": {"capabilities": []}}))
    deps = make_deps(local=local)
    service.provider_statuses(deps)
    service.provider_statuses(deps)
    shows = lambda: [c for c in local.calls if c.url == OLLAMA_SHOW_URL]  # noqa: E731
    assert len(shows()) == 2
    service.provider_statuses(deps, refresh=True)
    assert len(shows()) == 4


def test_ollama_failed_capability_lookups_are_not_cached():
    answers = {"llama3.2:latest": TransportError("timeout", "slow"), "qwen3:8b": {"capabilities": []}}
    local = ollama(show(answers))
    deps = make_deps(local=local)
    service.provider_statuses(deps)
    answers["llama3.2:latest"] = {"capabilities": ["vision"]}
    status = by_id(service.provider_statuses(deps))["ollama"]
    assert {m["id"]: m["accepts"] for m in status["models"]}["llama3.2:latest"] == ["image"]


def test_ollama_capability_lookups_are_parallel_bounded_and_keep_the_status_fast():
    many = {"models": [{"name": f"m{i}:latest"} for i in range(12)]}
    release = threading.Event()
    active, peak = [0], [0]
    lock = threading.Lock()

    def slow(_call):
        with lock:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
        try:
            release.wait(10)
            raise TransportError("timeout", "late")
        finally:
            with lock:
                active[0] -= 1

    local = FakeTransport({("GET", OLLAMA_TAGS_URL): ok(many), ("POST", OLLAMA_SHOW_URL): slow})
    start = time.monotonic()
    try:
        status = by_id(service.provider_statuses(make_deps(local=local)))["ollama"]
    finally:
        release.set()
    assert time.monotonic() - start < service.LOCAL_DEADLINE_S + 0.5
    assert status["available"] is True
    assert len(status["models"]) == 12
    assert all(m["accepts"] == [] for m in status["models"])
    assert peak[0] <= service.CAPABILITY_WORKERS


# === LM Studio: GET /api/v1/models ==========================================

NATIVE = {"models": [
    {"type": "llm", "key": "google/gemma-3-12b", "loaded_instances": [{"id": "google/gemma-3-12b"}],
     "capabilities": {"vision": True, "trained_for_tool_use": True}},
    {"type": "llm", "key": "qwen/qwen3-8b", "loaded_instances": [{"id": "qwen/qwen3-8b:2"}],
     "capabilities": {"vision": True}},
    {"type": "llm", "key": "deepseek/r1", "loaded_instances": [], "capabilities": {"vision": False}},
    {"type": "embedding", "key": "text-embedding-nomic-embed-text-v1.5", "loaded_instances": []},
]}


def lmstudio(native_handler, models=None):
    routes = {("GET", LMSTUDIO_MODELS_URL): ok(models or LMSTUDIO_MODELS)}
    if native_handler is not None:
        routes[("GET", LMSTUDIO_NATIVE_URL)] = native_handler
    return FakeTransport(routes)


def test_lmstudio_marks_vision_models_from_the_native_endpoint_and_keeps_chat_ids():
    models = {"data": [{"id": "google/gemma-3-12b"}, {"id": "qwen/qwen3-8b:2"}, {"id": "deepseek/r1"},
                       {"id": "text-embedding-nomic-embed-text-v1.5"}]}
    local = lmstudio(ok(NATIVE), models)
    status = by_id(service.provider_statuses(make_deps(local=local)))["lmstudio"]
    assert status["available"] is True
    assert status["models"] == [
        {"id": "google/gemma-3-12b", "name": "google/gemma-3-12b", "accepts": ["image"]},
        {"id": "qwen/qwen3-8b:2", "name": "qwen/qwen3-8b:2", "accepts": ["image"]},
        {"id": "deepseek/r1", "name": "deepseek/r1", "accepts": []},
    ]
    native = [c for c in local.calls if c.url == LMSTUDIO_NATIVE_URL]
    assert len(native) == 1 and native[0].method == "GET"
    assert native[0].timeout <= service.PROBE_TIMEOUT_S


def test_lmstudio_native_embedding_type_hides_a_model_without_embed_in_its_id():
    models = {"data": [{"id": "google/gemma-3-12b"}, {"id": "bge-small"}]}
    native = {"models": [{"type": "llm", "key": "google/gemma-3-12b", "capabilities": {"vision": False}},
                         {"type": "embedding", "key": "bge-small"}]}
    status = by_id(service.provider_statuses(make_deps(local=lmstudio(ok(native), models))))["lmstudio"]
    assert [m["id"] for m in status["models"]] == ["google/gemma-3-12b"]


@pytest.mark.parametrize("handler", [
    None,                                         # 404 / older LM Studio: route missing -> refused
    raw('{"error":"Unexpected endpoint"}', 404),
    raw("not json"),
    ok({"models": "nope"}),
    ok({"data": []}),
    ok({"models": [None, 3, {"type": "llm"}, {"key": "google/gemma-3-12b", "capabilities": "vision"}]}),
    TransportError("timeout", "slow"),
])
def test_lmstudio_native_endpoint_problems_fall_back_to_text_only(handler):
    local = lmstudio(handler)
    status = by_id(service.provider_statuses(make_deps(local=local)))["lmstudio"]
    assert status["available"] is True
    assert status["models"] == [{"id": "google/gemma-3-12b", "name": "google/gemma-3-12b", "accepts": []}]
