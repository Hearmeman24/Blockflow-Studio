"""Prompt Writer media: upstream images, videos and audio sent to the model.

The block sends references to files in the BlockFlow output folder; the
backend resolves them safely, reads them and attaches them to the user
message in each provider's format. Fake transports only."""
from __future__ import annotations

import base64
import logging
from urllib.parse import quote

import pytest
from prompt_writer_fakes import FakeTransport, ok

from backend import output_folder
from backend.prompt_writer import service

OR_KEY = "sk-or-v1-SECRET-0123456789abcdef"
OR_CHAT = "https://openrouter.ai/api/v1/chat/completions"
OR_MODELS_URL = "https://openrouter.ai/api/v1/models"
OLLAMA_CHAT = "http://localhost:11434/api/chat"
LMSTUDIO_CHAT = "http://localhost:1234/v1/chat/completions"

PNG = b"\x89PNG\r\n\x1a\n" + b"png-bytes"
JPG = b"\xff\xd8\xff" + b"jpg-bytes"
MP4 = b"\x00\x00\x00\x18ftypmp42" + b"video-bytes"
MP3 = b"ID3" + b"mp3-bytes"
WAV = b"RIFF" + b"wav-bytes"


@pytest.fixture(autouse=True)
def _fresh_cache():
    service.reset_model_cache()
    yield
    service.reset_model_cache()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def put(name: str, data: bytes) -> str:
    """Write a file into the (test) output folder and return its /outputs/ path."""
    root = output_folder.current()
    path = root / "media" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return "/outputs/media/" + quote(name)


def ref(kind: str, local: str, **extra):
    return {"kind": kind, "role": "reference", "local": local, **extra}


def make_deps(*, key=OR_KEY, hosted=None, local=None):
    return service.Deps(
        hosted=hosted or FakeTransport(),
        local=local or FakeTransport(),
        get_credential=lambda name: key if name == "openrouter_api_key" else None,
        get_pref=lambda _name: None,
    )


def payload(**over):
    body = {"provider": "openrouter", "model": "google/gemini", "input": "describe this",
            "system_prompt": "Write a prompt.", "temperature": 0.5, "max_tokens": 300}
    body.update(over)
    return body


def openai_reply(text="A prompt."):
    return ok({"choices": [{"message": {"content": text}}]})


# === exact request bodies per provider ======================================

def test_openrouter_sends_text_then_image_video_and_audio_parts():
    image, video, audio = put("a.png", PNG), put("clip.mp4", MP4), put("voice.mp3", MP3)
    hosted = FakeTransport({("POST", OR_CHAT): openai_reply()})
    result = service.generate(payload(media=[ref("image", image), ref("video", video), ref("audio", audio)]),
                              make_deps(hosted=hosted))
    assert result["ok"] is True, result
    (call,) = hosted.calls
    assert call.json() == {
        "model": "google/gemini",
        "messages": [
            {"role": "system", "content": "Write a prompt."},
            {"role": "user", "content": [
                {"type": "text", "text": "describe this"},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64(PNG)}"}},
                {"type": "video_url", "video_url": {"url": f"data:video/mp4;base64,{b64(MP4)}"}},
                {"type": "input_audio", "input_audio": {"data": b64(MP3), "format": "mp3"}},
            ]},
        ],
        "temperature": 0.5,
        "max_tokens": 300,
        "stream": False,
    }


def test_openrouter_keeps_upstream_order_within_a_kind_and_several_items_of_one_kind():
    first, second = put("one.jpg", JPG), put("two.png", PNG)
    hosted = FakeTransport({("POST", OR_CHAT): openai_reply()})
    service.generate(payload(media=[ref("image", first), ref("image", second)]), make_deps(hosted=hosted))
    parts = hosted.calls[0].json()["messages"][1]["content"]
    assert [p["image_url"]["url"] for p in parts[1:]] == [
        f"data:image/jpeg;base64,{b64(JPG)}", f"data:image/png;base64,{b64(PNG)}"]


def test_ollama_sends_images_as_base64_on_the_user_message():
    first, second = put("one.jpg", JPG), put("two.png", PNG)
    local = FakeTransport({("POST", OLLAMA_CHAT): ok({"message": {"content": "Seen."}})})
    result = service.generate(payload(provider="ollama", model="llava:7b",
                                      media=[ref("image", first), ref("image", second)]),
                              make_deps(key=None, local=local))
    assert result["ok"] is True, result
    (call,) = local.calls
    assert call.json() == {
        "model": "llava:7b",
        "messages": [
            {"role": "system", "content": "Write a prompt."},
            {"role": "user", "content": "describe this", "images": [b64(JPG), b64(PNG)]},
        ],
        "stream": False,
    }


def test_lmstudio_sends_images_as_openai_image_url_parts():
    image = put("a.webp", b"RIFFxxxxWEBPdata")
    local = FakeTransport({("POST", LMSTUDIO_CHAT): openai_reply("Seen.")})
    result = service.generate(payload(provider="lmstudio", model="google/gemma-3-12b", media=[ref("image", image)]),
                              make_deps(local=local))
    assert result["ok"] is True, result
    assert local.calls[0].json()["messages"][1] == {"role": "user", "content": [
        {"type": "text", "text": "describe this"},
        {"type": "image_url", "image_url": {"url": f"data:image/webp;base64,{b64(b'RIFFxxxxWEBPdata')}"}},
    ]}


def test_no_media_or_an_empty_list_keeps_the_plain_text_message():
    hosted = FakeTransport({("POST", OR_CHAT): openai_reply()})
    service.generate(payload(media=[]), make_deps(hosted=hosted))
    assert hosted.calls[0].json()["messages"][1] == {"role": "user", "content": "describe this"}


def test_non_ascii_file_names_are_read():
    image = put("übersicht 雪 🦊.png", PNG)
    hosted = FakeTransport({("POST", OR_CHAT): openai_reply()})
    result = service.generate(payload(media=[ref("image", image)]), make_deps(hosted=hosted))
    assert result["ok"] is True, result
    assert hosted.calls[0].json()["messages"][1]["content"][1]["image_url"]["url"].endswith(b64(PNG))


def test_extra_loader_metadata_on_a_reference_is_accepted():
    image = put("a.png", PNG)
    hosted = FakeTransport({("POST", OR_CHAT): openai_reply()})
    media = [ref("image", image, label="a.png", width=10, height=10, size_bytes=len(PNG), format="png",
                 url="https://tmpfiles.org/x.png")]
    assert service.generate(payload(media=media), make_deps(hosted=hosted))["ok"] is True


# === kinds the provider or model cannot take ================================

@pytest.mark.parametrize("provider", ["ollama", "lmstudio"])
@pytest.mark.parametrize("kind, name, data", [("video", "clip.mp4", MP4), ("audio", "voice.wav", WAV)])
def test_local_providers_never_take_video_or_audio(provider, kind, name, data):
    local = FakeTransport()
    result = service.generate(payload(provider=provider, model="m", media=[ref(kind, put(name, data))]),
                              make_deps(local=local))
    assert result["ok"] is False
    assert result["kind"] == "validation"
    assert "images only" in result["message"]
    assert local.calls == []


def test_a_model_known_not_to_accept_a_kind_is_refused():
    models = {"data": [{"id": "text/only", "name": "Text only",
                        "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]}}]}
    hosted = FakeTransport({("GET", OR_MODELS_URL): ok(models), ("POST", OR_CHAT): openai_reply()})
    deps = make_deps(hosted=hosted)
    service.provider_statuses(deps)
    result = service.generate(payload(model="text/only", media=[ref("image", put("a.png", PNG))]), deps)
    assert result == {"ok": False, "kind": "validation",
                      "message": "Text only does not accept images. Pick a model that accepts images, "
                                 "or untick Images in the block."}
    assert not any(c.method == "POST" for c in hosted.calls)


def test_a_local_model_known_not_to_accept_images_is_refused():
    tags = {"models": [{"name": "llama3.2:latest"}]}
    local = FakeTransport({("GET", "http://localhost:11434/api/tags"): ok(tags),
                           ("POST", "http://localhost:11434/api/show"): ok({"capabilities": ["completion"]})})
    deps = make_deps(key=None, local=local)
    service.provider_statuses(deps)
    result = service.generate(payload(provider="ollama", model="llama3.2:latest",
                                      media=[ref("image", put("a.png", PNG))]), deps)
    assert result["kind"] == "validation"
    assert "does not accept images" in result["message"]
    assert not any(c.url == OLLAMA_CHAT for c in local.calls)


def test_an_unknown_model_with_media_is_sent_and_left_to_the_provider():
    hosted = FakeTransport({("POST", OR_CHAT): openai_reply()})
    result = service.generate(payload(model="typed/model-id", media=[ref("video", put("c.mp4", MP4))]),
                              make_deps(hosted=hosted))
    assert result["ok"] is True


# === files: missing, unsafe, too many, too big ==============================

def test_a_missing_or_deleted_file_is_a_readable_validation_error():
    image = put("gone.png", PNG)
    (output_folder.current() / "media" / "gone.png").unlink()
    hosted = FakeTransport()
    result = service.generate(payload(media=[ref("image", image)]), make_deps(hosted=hosted))
    assert result == {"ok": False, "kind": "validation",
                      "message": "gone.png no longer exists. Add it again in the block that loads it."}
    assert hosted.calls == []


@pytest.mark.parametrize("local", [
    "/outputs/../../etc/passwd",
    "/outputs/%2e%2e/%2e%2e/etc/passwd",
    "/etc/passwd",
    "../secret.png",
    "https://example.com/a.png",
    "file:///etc/passwd",
    "/outputs/a\x00.png",
    "",
    "   ",
    None,
    42,
])
def test_paths_outside_the_output_folder_are_refused_without_echo(local):
    hosted = FakeTransport()
    result = service.generate(payload(media=[{"kind": "image", "local": local}]), make_deps(hosted=hosted))
    assert result["ok"] is False
    assert result["kind"] == "validation"
    assert "passwd" not in result["message"]
    assert hosted.calls == []


def test_a_directory_is_not_a_file():
    (output_folder.current() / "media" / "dir.png").mkdir(parents=True)
    result = service.generate(payload(media=[ref("image", "/outputs/media/dir.png")]), make_deps())
    assert result["kind"] == "validation"


@pytest.mark.parametrize("media, fragment", [
    ("not-a-list", "media"),
    ([None], "media"),
    (["/outputs/a.png"], "media"),
    ([{"kind": "voice", "local": "/outputs/a.wav"}], "image, video or audio"),
    ([{"kind": "text", "local": "/outputs/a.txt"}], "image, video or audio"),
])
def test_malformed_media_is_refused(media, fragment):
    result = service.generate(payload(media=media), make_deps())
    assert result["kind"] == "validation"
    assert fragment in result["message"]


def test_a_file_with_the_wrong_type_for_its_kind_is_refused():
    result = service.generate(payload(media=[ref("image", put("notes.txt", b"hello"))]), make_deps())
    assert result["kind"] == "validation"
    assert "notes.txt" in result["message"]


def test_too_many_files_are_refused_before_reading_any(monkeypatch):
    refs = [ref("image", put(f"i{i}.png", PNG)) for i in range(service.MAX_MEDIA_FILES + 1)]
    reads = []
    real = service._read_media_file
    monkeypatch.setattr(service, "_read_media_file", lambda path: reads.append(path) or real(path))
    hosted = FakeTransport()
    result = service.generate(payload(media=refs), make_deps(hosted=hosted))
    assert result["kind"] == "validation"
    assert f"at most {service.MAX_MEDIA_FILES}" in result["message"]
    assert reads == [] and hosted.calls == []


def test_files_over_the_total_size_limit_are_refused(monkeypatch):
    monkeypatch.setattr(service, "MAX_MEDIA_TOTAL_BYTES", 20)
    hosted = FakeTransport()
    media = [ref("image", put("a.png", PNG)), ref("image", put("b.png", PNG))]
    result = service.generate(payload(media=media), make_deps(hosted=hosted))
    assert result["kind"] == "validation"
    assert "too large" in result["message"]
    assert hosted.calls == []


def test_the_limits_are_sensible():
    assert 1 <= service.MAX_MEDIA_FILES <= 20
    assert 1_000_000 <= service.MAX_MEDIA_TOTAL_BYTES <= 100_000_000


def test_file_contents_never_reach_the_logs_or_an_error(caplog):
    secret_bytes = b"\x89PNG" + b"PRIVATE-PIXELS"
    image = put("a.png", secret_bytes)
    hosted = FakeTransport({("POST", OR_CHAT): ok({"error": {"message": "bad image"}}, 400)})
    with caplog.at_level(logging.DEBUG):
        result = service.generate(payload(media=[ref("image", image)]), make_deps(hosted=hosted))
    assert result["ok"] is False
    for text in (caplog.text, str(result)):
        assert b64(secret_bytes) not in text
        assert "PRIVATE-PIXELS" not in text
        assert OR_KEY not in text
