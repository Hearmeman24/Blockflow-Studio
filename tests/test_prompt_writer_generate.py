"""Prompt Writer generation: the exact request each provider receives, the
text that comes back, and every normalised error kind. Fake transports only."""
from __future__ import annotations

import logging

import pytest
from prompt_writer_fakes import FakeTransport, ok, raw

from backend.prompt_writer import service
from backend.prompt_writer.transport import TransportError

OR_KEY = "sk-or-v1-SECRET-0123456789abcdef"
OR_CHAT = "https://openrouter.ai/api/v1/chat/completions"
OLLAMA_CHAT = "http://localhost:11434/api/chat"
LMSTUDIO_CHAT = "http://localhost:1234/v1/chat/completions"


def make_deps(*, key=OR_KEY, prefs=None, hosted=None, local=None):
    return service.Deps(
        hosted=hosted or FakeTransport(),
        local=local or FakeTransport(),
        get_credential=lambda name: key if name == "openrouter_api_key" else None,
        get_pref=lambda name: (prefs or {}).get(name),
    )


def payload(**over):
    body = {
        "provider": "openrouter",
        "model": "x-ai/grok-4.1-fast",
        "input": "a fox in the snow",
        "system_prompt": "Write a cinematic prompt.",
        "temperature": 0.6,
        "max_tokens": 800,
    }
    body.update(over)
    return body


def openai_reply(text):
    return ok({"choices": [{"message": {"role": "assistant", "content": text}}]})


# === request shape per provider =============================================

def test_openrouter_request_and_reply():
    hosted = FakeTransport({("POST", OR_CHAT): openai_reply("  A red fox pads through fresh snow.  ")})
    result = service.generate(payload(), make_deps(hosted=hosted))
    assert result == {"ok": True, "text": "A red fox pads through fresh snow.", "provider": "openrouter",
                      "model": "x-ai/grok-4.1-fast"}
    (call,) = hosted.calls
    assert (call.method, call.url) == ("POST", OR_CHAT)
    assert call.headers["Authorization"] == f"Bearer {OR_KEY}"
    assert call.headers["Content-Type"] == "application/json"
    assert call.headers["X-Title"] == "BlockFlow"
    assert call.json() == {
        "model": "x-ai/grok-4.1-fast",
        "messages": [
            {"role": "system", "content": "Write a cinematic prompt."},
            {"role": "user", "content": "a fox in the snow"},
        ],
        "temperature": 0.6,
        "max_tokens": 800,
        "stream": False,
    }
    assert call.timeout == pytest.approx(service.OPENROUTER_GENERATE_TIMEOUT_S)
    assert service.OPENROUTER_GENERATE_TIMEOUT_S == 110.0


@pytest.mark.parametrize("provider, url", [("ollama", OLLAMA_CHAT), ("lmstudio", LMSTUDIO_CHAT)])
def test_local_providers_get_the_longer_generate_limit(provider, url):
    reply = ok({"message": {"content": "x"}}) if provider == "ollama" else openai_reply("x")
    local = FakeTransport({("POST", url): reply})
    service.generate(payload(provider=provider, model="m"), make_deps(local=local))
    assert local.calls[0].timeout == pytest.approx(service.LOCAL_GENERATE_TIMEOUT_S)
    assert service.LOCAL_GENERATE_TIMEOUT_S == 600.0
    assert service.LOCAL_GENERATE_TIMEOUT_S > service.OPENROUTER_GENERATE_TIMEOUT_S


@pytest.mark.parametrize("provider, url, label, seconds", [
    ("ollama", OLLAMA_CHAT, "Ollama", "600"),
    ("lmstudio", LMSTUDIO_CHAT, "LM Studio", "600"),
    ("openrouter", OR_CHAT, "OpenRouter", "110"),
])
def test_a_timeout_says_how_long_we_waited_and_what_to_do(provider, url, label, seconds):
    transport = FakeTransport({("POST", url): TransportError("timeout", "timed out")})
    deps = make_deps(hosted=transport) if provider == "openrouter" else make_deps(local=transport)
    result = service.generate(payload(provider=provider, model="m"), deps)
    assert result["kind"] == "timeout"
    assert result["message"].startswith(f"{label} did not finish writing within {seconds} s.")
    assert "faster model" in result["message"]


def test_ollama_request_and_reply():
    local = FakeTransport({("POST", OLLAMA_CHAT): ok({"message": {"role": "assistant", "content": "Snowy fox."},
                                                      "done": True})})
    result = service.generate(payload(provider="ollama", model="llama3.2:latest"), make_deps(key=None, local=local))
    assert result["ok"] is True
    assert result["text"] == "Snowy fox."
    (call,) = local.calls
    assert (call.method, call.url) == ("POST", OLLAMA_CHAT)
    assert "Authorization" not in call.headers
    assert call.json() == {
        "model": "llama3.2:latest",
        "messages": [
            {"role": "system", "content": "Write a cinematic prompt."},
            {"role": "user", "content": "a fox in the snow"},
        ],
        "stream": False,
    }
    # Sampling (temperature, max tokens) is configured in Ollama itself.
    assert "options" not in call.json()


def test_lmstudio_request_and_reply():
    local = FakeTransport({("POST", LMSTUDIO_CHAT): openai_reply("Fox, snow, dusk.")})
    result = service.generate(payload(provider="lmstudio", model="google/gemma-3-12b"), make_deps(local=local))
    assert result["text"] == "Fox, snow, dusk."
    (call,) = local.calls
    assert (call.method, call.url) == ("POST", LMSTUDIO_CHAT)
    assert "Authorization" not in call.headers
    assert call.json() == {
        "model": "google/gemma-3-12b",
        "messages": [
            {"role": "system", "content": "Write a cinematic prompt."},
            {"role": "user", "content": "a fox in the snow"},
        ],
        "stream": False,
    }
    # Sampling (temperature, max tokens) is configured in LM Studio itself.
    assert not {"temperature", "max_tokens", "top_p"} & set(call.json())


@pytest.mark.parametrize("provider, url", [("ollama", OLLAMA_CHAT), ("lmstudio", LMSTUDIO_CHAT)])
def test_local_providers_never_forward_sampling_settings_even_when_sent(provider, url):
    reply = ok({"message": {"content": "x"}}) if provider == "ollama" else openai_reply("x")
    local = FakeTransport({("POST", url): reply})
    result = service.generate(payload(provider=provider, model="m", temperature=1.7, max_tokens=12345),
                              make_deps(local=local))
    assert result["ok"] is True
    body = local.calls[0].json()
    assert set(body) == {"model", "messages", "stream"}
    assert b"1.7" not in local.calls[0].body and b"12345" not in local.calls[0].body


def test_openrouter_still_forwards_sampling_settings():
    hosted = FakeTransport({("POST", OR_CHAT): openai_reply("x")})
    service.generate(payload(temperature=1.7, max_tokens=12345), make_deps(hosted=hosted))
    body = hosted.calls[0].json()
    assert (body["temperature"], body["max_tokens"]) == (1.7, 12345)


def test_local_provider_uses_the_saved_base_url():
    url = "http://10.0.0.5:8080/lm/v1/chat/completions"
    local = FakeTransport({("POST", url): openai_reply("ok")})
    deps = make_deps(local=local, prefs={"lmstudio_base_url": "http://10.0.0.5:8080/lm"})
    assert service.generate(payload(provider="lmstudio", model="m"), deps)["ok"] is True


def test_empty_system_prompt_sends_only_the_user_message():
    hosted = FakeTransport({("POST", OR_CHAT): openai_reply("x")})
    service.generate(payload(system_prompt="  "), make_deps(hosted=hosted))
    assert hosted.calls[0].json()["messages"] == [{"role": "user", "content": "a fox in the snow"}]


def test_optional_fields_default():
    hosted = FakeTransport({("POST", OR_CHAT): openai_reply("x")})
    body = payload()
    del body["temperature"], body["max_tokens"], body["system_prompt"]
    service.generate(body, make_deps(hosted=hosted))
    sent = hosted.calls[0].json()
    assert sent["temperature"] == service.DEFAULT_TEMPERATURE
    assert sent["max_tokens"] == service.DEFAULT_MAX_TOKENS


def test_unicode_input_round_trips():
    text = "Ein Fuchs im Schnee 🦊 — 雪の中の狐 «ñ»"
    hosted = FakeTransport({("POST", OR_CHAT): openai_reply(f"Out: {text}")})
    result = service.generate(payload(input=text, system_prompt="Stil: filmisch ✓"), make_deps(hosted=hosted))
    assert result["text"] == f"Out: {text}"
    sent = hosted.calls[0]
    assert sent.json()["messages"][1]["content"] == text
    assert text.encode("utf-8") in sent.body


def test_reasoning_preamble_is_removed_from_the_text():
    local = FakeTransport({("POST", OLLAMA_CHAT): ok({"message": {"content": "<think>\nplan it\n</think>\n\nFinal prompt."}})})
    result = service.generate(payload(provider="ollama", model="qwen3:8b"), make_deps(local=local))
    assert result["text"] == "Final prompt."


def test_openai_content_parts_are_joined():
    reply = ok({"choices": [{"message": {"content": [{"type": "text", "text": "Part one."},
                                                     {"type": "text", "text": "Part two."}]}}]})
    hosted = FakeTransport({("POST", OR_CHAT): reply})
    assert service.generate(payload(), make_deps(hosted=hosted))["text"] == "Part one.\nPart two."


# === validation =============================================================

@pytest.mark.parametrize("over, fragment", [
    ({"input": ""}, "Write an idea"),
    ({"input": "   \n\t "}, "Write an idea"),
    ({"input": 42}, "Write an idea"),
    ({"input": "x" * (service.MAX_INPUT_CHARS + 1)}, "too long"),
    ({"model": ""}, "Choose a model"),
    ({"model": "  "}, "Choose a model"),
    ({"model": "m" * 301}, "Choose a model"),
    ({"provider": "openai"}, "Unknown provider"),
    ({"provider": None}, "Unknown provider"),
    ({"temperature": 3}, "Temperature"),
    ({"temperature": "hot"}, "Temperature"),
    ({"temperature": True}, "Temperature"),
    ({"max_tokens": 0}, "Max tokens"),
    ({"max_tokens": 1.5}, "Max tokens"),
    ({"max_tokens": service.MAX_MAX_TOKENS + 1}, "Max tokens"),
    ({"system_prompt": 5}, "System prompt"),
    ({"system_prompt": "s" * (service.MAX_SYSTEM_PROMPT_CHARS + 1)}, "System prompt"),
])
def test_invalid_requests_are_rejected_before_any_call(over, fragment):
    hosted, local = FakeTransport(), FakeTransport()
    result = service.generate(payload(**over), make_deps(hosted=hosted, local=local))
    assert result["ok"] is False
    assert result["kind"] == "validation"
    assert fragment in result["message"]
    assert hosted.calls == [] and local.calls == []


@pytest.mark.parametrize("body", [None, [], "text", 5])
def test_non_object_body_is_rejected(body):
    result = service.generate(body, make_deps())
    assert result["kind"] == "validation"


@pytest.mark.parametrize("field", ["api_key", "openrouter_api_key", "authorization", "key"])
def test_a_key_in_the_body_is_refused_and_never_echoed(field):
    hosted = FakeTransport({("POST", OR_CHAT): openai_reply("x")})
    result = service.generate(payload(**{field: "sk-or-v1-ATTACKER-KEY-123456"}), make_deps(hosted=hosted))
    assert result["ok"] is False
    assert result["kind"] == "validation"
    assert "ATTACKER" not in str(result)
    assert hosted.calls == []


# === error kinds ============================================================

def test_openrouter_without_key_is_unavailable():
    hosted = FakeTransport()
    result = service.generate(payload(), make_deps(key=None, hosted=hosted))
    assert result == {"ok": False, "kind": "unavailable",
                      "message": "No OpenRouter API key is saved. Add one in Settings → API keys."}
    assert hosted.calls == []


@pytest.mark.parametrize("provider, message", [
    ("ollama", "Ollama is not running at http://localhost:11434. Start it, then press Re-check."),
    ("lmstudio", "LM Studio is not running at http://localhost:1234. Start it, then press Re-check."),
])
def test_stopped_local_server_fails_fast_as_unavailable(provider, message):
    result = service.generate(payload(provider=provider, model="m"), make_deps())
    assert result == {"ok": False, "kind": "unavailable", "message": message}


def test_invalid_saved_base_url_is_never_used():
    local = FakeTransport()
    deps = make_deps(local=local, prefs={"ollama_base_url": "javascript:alert(1)"})
    result = service.generate(payload(provider="ollama", model="m"), deps)
    assert result["kind"] == "unavailable"
    assert "not valid" in result["message"]
    assert local.calls == []


OR_ERRORS = [
    (raw('{"error":{"code":401,"message":"No auth credentials found"}}', 401), "auth"),
    (raw('{"error":{"code":403,"message":"Key disabled"}}', 403), "auth"),
    (raw('{"error":{"code":402,"message":"Insufficient credits"}}', 402), "insufficient_credits"),
    (raw('{"error":{"code":429,"message":"Rate limit exceeded"}}', 429), "rate_limited"),
    (raw('{"error":{"code":400,"message":"x-ai/nope is not a valid model ID"}}', 400), "model_not_found"),
    (raw('{"error":{"code":404,"message":"No endpoints found for x-ai/nope."}}', 404), "model_not_found"),
    (raw('{"error":{"code":400,"message":"max_tokens must be positive"}}', 400), "validation"),
    (raw('{"error":{"code":408,"message":"Request timed out"}}', 408), "timeout"),
    (raw("<html>502 Bad Gateway</html>", 502), "provider_failure"),
    (raw('{"error":{"message":"overloaded"}}', 503), "provider_failure"),
    (raw("not json at all"), "malformed_response"),
    (ok({"choices": []}), "malformed_response"),
    (ok({"choices": [{"message": {"content": "   "}}]}), "malformed_response"),
    (ok({"error": {"code": 502, "message": "upstream provider error"}}), "provider_failure"),
    (TransportError("timeout", "timed out"), "timeout"),
    (TransportError("network", "Name or service not known"), "network"),
    (TransportError("refused", "Connection refused"), "network"),
]


@pytest.mark.parametrize("response, kind", OR_ERRORS)
def test_openrouter_error_kinds(response, kind, caplog):
    hosted = FakeTransport({("POST", OR_CHAT): response})
    with caplog.at_level(logging.DEBUG):
        result = service.generate(payload(), make_deps(hosted=hosted))
    assert result["ok"] is False
    assert result["kind"] == kind
    assert result["message"]
    assert set(result) == {"ok", "kind", "message"}
    assert OR_KEY not in result["message"]
    assert OR_KEY not in caplog.text


def test_key_echoed_by_the_provider_is_redacted():
    echo = raw(f'{{"error":{{"message":"Upstream failed for key {OR_KEY}"}}}}', 500)
    hosted = FakeTransport({("POST", OR_CHAT): echo})
    result = service.generate(payload(), make_deps(hosted=hosted))
    assert result["kind"] == "provider_failure"
    assert OR_KEY not in result["message"]
    assert "[redacted]" in result["message"]


@pytest.mark.parametrize("response, kind", [
    (raw('{"error":"model \\"nope\\" not found, try pulling it first"}', 404), "model_not_found"),
    (raw('{"error":"something broke"}', 500), "provider_failure"),
    (ok({"message": {}}), "malformed_response"),
    (TransportError("timeout", "timed out"), "timeout"),
])
def test_ollama_error_kinds(response, kind):
    local = FakeTransport({("POST", OLLAMA_CHAT): response})
    result = service.generate(payload(provider="ollama", model="nope"), make_deps(local=local))
    assert result["kind"] == kind


@pytest.mark.parametrize("response, kind", [
    (raw('{"error":{"message":"Model \\"nope\\" not found"}}', 404), "model_not_found"),
    (raw('{"error":"No models loaded. Please load a model."}', 400), "model_not_found"),
    (raw('{"error":{"message":"Bad input"}}', 400), "validation"),
    (raw("", 500), "provider_failure"),
])
def test_lmstudio_error_kinds(response, kind):
    local = FakeTransport({("POST", LMSTUDIO_CHAT): response})
    result = service.generate(payload(provider="lmstudio", model="nope"), make_deps(local=local))
    assert result["kind"] == kind


def test_unexpected_crash_is_normalised():
    def boom(_call):
        raise RuntimeError(f"bug with {OR_KEY}")

    hosted = FakeTransport({("POST", OR_CHAT): boom})
    result = service.generate(payload(), make_deps(hosted=hosted))
    assert result["kind"] == "provider_failure"
    assert OR_KEY not in result["message"]


# === OpenRouter key check ===================================================

OR_KEY_URL = "https://openrouter.ai/api/v1/key"


def test_check_key_valid():
    hosted = FakeTransport({("GET", OR_KEY_URL): ok({"data": {"label": "sk-or-v1-abc...", "usage": 1.5,
                                                              "limit": None}})})
    result = service.check_openrouter_key(make_deps(hosted=hosted))
    assert result == {"ok": True, "valid": True, "message": "OpenRouter accepted the key."}
    assert hosted.calls[0].headers["Authorization"] == f"Bearer {OR_KEY}"


@pytest.mark.parametrize("status", [401, 403])
def test_check_key_rejected(status):
    hosted = FakeTransport({("GET", OR_KEY_URL): raw('{"error":{"message":"bad"}}', status)})
    result = service.check_openrouter_key(make_deps(hosted=hosted))
    assert result["ok"] is True
    assert result["valid"] is False


@pytest.mark.parametrize("handler", [raw("", 500), TransportError("timeout", "t"), ok([1, 2])])
def test_check_key_could_not_run(handler):
    hosted = FakeTransport({("GET", OR_KEY_URL): handler})
    result = service.check_openrouter_key(make_deps(hosted=hosted))
    assert result["ok"] is False
    assert result["valid"] is None


def test_check_key_without_a_key():
    hosted = FakeTransport()
    result = service.check_openrouter_key(make_deps(key=None, hosted=hosted))
    assert result == {"ok": False, "valid": None, "message": "No OpenRouter API key is saved."}
    assert hosted.calls == []
