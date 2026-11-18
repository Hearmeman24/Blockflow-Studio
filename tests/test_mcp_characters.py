"""Character support in the MCP server: list_characters, get_character and the
`character` reference source of `generate`.

Everything runs against a fake backend transport (no network, no keys, no
provider calls) except the one contract test, which drives the real FastAPI
character routes through a TestClient with a temporary database and output
folder. Nothing here can spend credits.
"""

from __future__ import annotations

import sys
from pathlib import Path
from urllib.parse import quote, urlsplit

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend import character_routes, db, output_folder  # noqa: E402
from backend.byok.references import resolve_local  # noqa: E402
from blockflow_mcp import client as mcp_client  # noqa: E402
from blockflow_mcp import references as mcp_refs  # noqa: E402
from blockflow_mcp import tools_jobs  # noqa: E402
from blockflow_mcp.client import BackendClient  # noqa: E402
from blockflow_mcp.tools_characters import get_character, list_characters  # noqa: E402
from blockflow_mcp.tools_generation import estimate_cost, generate, validate_generation  # noqa: E402
from tests.mcp_fakes import BASE, FakeBackend, job  # noqa: E402

ESTIMATE = {"amount": 205.0, "unit": "credits", "usd_equivalent": 1.025, "basis": "5 s x 41 credits/s",
            "confidence": "listed", "source": "https://kie.ai/pricing"}
I2I = {"provider": "kie", "model": "seedream-5-flash", "mode": "image_to_image", "prompt": "a portrait"}
MIA = "char_" + "a" * 32
ANA = "char_" + "b" * 32
ZOE = "char_" + "c" * 32


def media(mid: str, kind: str, label: str, character_id: str = MIA, **extra):
    stored = quote(f"{mid}_{label}", safe="")
    base = {"id": mid, "kind": kind, "label": label, "local": f"/outputs/characters/{character_id}/{stored}",
            "size_bytes": None, "width": None, "height": None, "duration_s": None, "position": 0,
            "created_at": "2026-11-15T12:00:00Z"}
    return {**base, **extra}


def character(cid: str, name: str, files=(), face=None, audio=None, description=""):
    return {"id": cid, "name": name, "description": description,
            "created_at": "2026-11-15T12:00:00Z", "updated_at": "2026-11-15T12:05:00Z",
            "default_face_id": face, "default_audio_id": audio, "media": list(files)}


FACE1 = "media_" + "1" * 32
FACE2 = "media_" + "2" * 32
CLIP = "media_" + "3" * 32
HELLO = "media_" + "4" * 32
ANGRY = "media_" + "5" * 32
SONG = "media_" + "6" * 32


def mia_files():
    return [
        media(FACE1, "image", "face.png", size_bytes=482113, width=1024, height=1024),
        media(FACE2, "image", "Side View.PNG", size_bytes=300, width=800, height=600, position=1),
        media(CLIP, "video", "walk.mp4", size_bytes=9000, width=1280, height=720, duration_s=4.5),
        media(HELLO, "audio", "hello.mp3", size_bytes=1234, duration_s=3.25),
        media(ANGRY, "audio", "angry.mp3", size_bytes=2222, duration_s=5.0, position=1),
        media(SONG, "audio", "theme.wav", size_bytes=777, duration_s=60.0, position=2),
    ]


def roster():
    return [
        character(MIA, "Mia Rose", mia_files(), face=FACE1, audio=HELLO, description="Hero, red coat"),
        character(ANA, "Ana", []),
    ]


@pytest.fixture
def backend(monkeypatch):
    fake = FakeBackend()
    fake.on("GET", "/api/characters", {"ok": True, "characters": roster()})
    fake.on("POST", "/api/generation/validate", {"ok": True, "issues": []})
    fake.on("POST", "/api/generation/estimate", {"ok": True, "estimate": ESTIMATE})
    fake.on("POST", "/api/generation/submit", lambda call: (200, {"ok": True, "job": job("j1")}))
    mcp_client.set_client(fake.client())
    monkeypatch.setattr(tools_jobs, "sleep", lambda s: None)
    mcp_refs._imported.clear()
    yield fake
    mcp_client.set_client(None)


def character_reads(fake):
    return [c for c in fake.calls if c["path"].startswith("/api/characters")]


def submits(fake):
    return fake.bodies("/api/generation/submit")


# ------------------------------------------------------------------ list_characters


def test_list_characters_summarises_each_character(backend):
    result = list_characters()
    assert result["ok"] is True
    mia, ana = result["characters"]
    assert mia == {
        "id": MIA, "name": "Mia Rose", "description": "Hero, red coat",
        "counts": {"image": 2, "video": 1, "audio": 3},
        "default_face": {"id": FACE1, "label": "face.png", "path": f"/outputs/characters/{MIA}/{FACE1}_face.png"},
        "default_audio": {"id": HELLO, "label": "hello.mp3", "path": f"/outputs/characters/{MIA}/{HELLO}_hello.mp3"},
    }
    assert ana["counts"] == {"image": 0, "video": 0, "audio": 0}
    assert ana["default_face"] is None and ana["default_audio"] is None
    assert backend.paths() == ["/api/characters"]


def test_list_characters_empty(backend):
    backend.on("GET", "/api/characters", {"ok": True, "characters": []})
    assert list_characters() == {"ok": True, "characters": []}


def test_list_characters_ignores_a_stale_default_id(backend):
    stale = character(MIA, "Mia", mia_files(), face="media_" + "9" * 32, audio=FACE1)  # wrong kind and unknown
    backend.on("GET", "/api/characters", {"ok": True, "characters": [stale]})
    only = list_characters()["characters"][0]
    assert only["default_face"] is None and only["default_audio"] is None


# ------------------------------------------------------------------ get_character


def test_get_character_by_id_has_every_file_in_order(backend):
    result = get_character(MIA)
    assert result["ok"] is True
    c = result["character"]
    assert c["id"] == MIA and c["name"] == "Mia Rose" and "voice_name" not in c
    assert c["description"] == "Hero, red coat"
    assert c["created_at"] == "2026-11-15T12:00:00Z" and c["updated_at"] == "2026-11-15T12:05:00Z"
    assert c["default_face_id"] == FACE1 and c["default_audio_id"] == HELLO and "default_voice_id" not in c
    refs = c["references"]
    assert list(refs) == ["image", "video", "audio"]
    assert [f["id"] for f in refs["image"]] == [FACE1, FACE2]
    assert refs["image"][0] == {"id": FACE1, "kind": "image", "label": "face.png",
                                "path": f"/outputs/characters/{MIA}/{FACE1}_face.png", "size_bytes": 482113,
                                "width": 1024, "height": 1024, "duration_s": None, "is_default": True}
    assert [f["is_default"] for f in refs["image"]] == [True, False]
    assert [f["id"] for f in refs["audio"]] == [HELLO, ANGRY, SONG]
    assert [f["is_default"] for f in refs["audio"]] == [True, False, False]
    assert refs["video"][0]["is_default"] is False and refs["video"][0]["duration_s"] == 4.5
    assert "media" not in c


def test_get_character_without_files_has_empty_lists(backend):
    c = get_character(ANA)["character"]
    assert c["references"] == {"image": [], "video": [], "audio": []}
    assert c["default_face_id"] is None and c["default_audio_id"] is None


@pytest.mark.parametrize("value", ["Mia Rose", "mia rose", "  MIA ROSE\n", "mIa RoSe"])
def test_get_character_by_name_ignores_case_and_surrounding_space(backend, value):
    assert get_character(value)["character"]["id"] == MIA


def test_get_character_id_is_trimmed(backend):
    assert get_character(f"  {MIA} ")["character"]["name"] == "Mia Rose"


def test_get_character_unknown_lists_the_available_names(backend):
    result = get_character("Nobody")
    assert result["ok"] is False and result["error"]["kind"] == "unknown_character"
    assert "Mia Rose" in result["error"]["message"] and "Ana" in result["error"]["message"]
    assert "Nobody" in result["error"]["message"]


def test_get_character_unknown_id_is_unknown_character(backend):
    result = get_character("char_" + "0" * 32)
    assert result["error"]["kind"] == "unknown_character"


def test_unknown_character_message_caps_the_list(backend):
    many = [character("char_" + f"{i:032x}", f"Name {i:02d}") for i in range(30)]
    backend.on("GET", "/api/characters", {"ok": True, "characters": many})
    message = get_character("zzz")["error"]["message"]
    assert "Name 00" in message and "Name 19" in message and "Name 20" not in message
    assert "10 more" in message


def test_unknown_character_when_there_are_none_points_to_the_page(backend):
    backend.on("GET", "/api/characters", {"ok": True, "characters": []})
    message = get_character("Mia")["error"]["message"]
    assert "Characters page" in message


def test_ambiguous_name_lists_the_ids(backend):
    twins = [character(MIA, "Twin"), character(ANA, "twin "), character(ZOE, "Other")]
    backend.on("GET", "/api/characters", {"ok": True, "characters": twins})
    result = get_character("TWIN")
    assert result["error"]["kind"] == "ambiguous_character"
    assert MIA in result["error"]["message"] and ANA in result["error"]["message"] and ZOE not in result["error"]["message"]
    # An id still picks exactly one of them.
    assert get_character(ANA)["character"]["id"] == ANA


@pytest.mark.parametrize("value", ["", "   ", None, 7, ["Mia"], {"a": 1}])
def test_blank_or_non_string_character_is_a_clear_failure(backend, value):
    result = get_character(value)
    assert result["ok"] is False and result["error"]["kind"] == "invalid_character"
    assert "name" in result["error"]["message"] and "id" in result["error"]["message"]
    assert character_reads(backend) == []


def test_unicode_names_and_labels_and_quoted_paths_are_returned_as_the_backend_sent_them(backend):
    label = "José's \"face\" (1) 李.png"
    f = media(FACE1, "image", label, ZOE)
    backend.on("GET", "/api/characters", {"ok": True, "characters": [character(ZOE, "李小龙 Zoë", [f], face=FACE1)]})
    listed = list_characters()["characters"][0]
    assert listed["name"] == "李小龙 Zoë" and "voice_name" not in listed
    assert listed["default_face"]["label"] == label and listed["default_face"]["path"] == f["local"]
    got = get_character("李小龙 zoë")["character"]
    assert got["references"]["image"][0]["path"] == f["local"]
    assert "%" in f["local"] and " " not in f["local"]


# ------------------------------------------------------------------ backend failures


@pytest.mark.parametrize("tool,arg", [(list_characters, ()), (get_character, ("Mia",))])
def test_unreachable_backend_is_a_readable_failure(backend, tool, arg):
    backend.on("GET", "/api/characters", ConnectionRefusedError("refused"))
    result = tool(*arg)
    assert result["ok"] is False and result["error"]["kind"] == "backend_unreachable"
    assert "uv run app.py" in result["error"]["message"]


@pytest.mark.parametrize("tool,arg", [(list_characters, ()), (get_character, ("Mia",))])
def test_server_error_is_a_readable_failure(backend, tool, arg):
    backend.on("GET", "/api/characters", {"ok": False, "error": "database is locked"}, status=500)
    result = tool(*arg)
    assert result["ok"] is False and result["error"]["kind"] == "backend"
    assert "database is locked" in result["error"]["message"]


@pytest.mark.parametrize("tool,arg", [(list_characters, ()), (get_character, ("Mia",))])
def test_malformed_json_is_a_readable_failure(backend, tool, arg):
    mcp_client.set_client(BackendClient(BASE, transport=lambda m, u, h, b, t: (200, b"<html>nope</html>")))
    result = tool(*arg)
    assert result["ok"] is False and result["error"]["kind"] == "bad_response"


@pytest.mark.parametrize("body", [{"ok": True}, {"ok": True, "characters": "x"}, {"ok": True, "characters": [1]}, []])
def test_unexpected_json_shapes_are_a_readable_failure(backend, body):
    backend.on("GET", "/api/characters", lambda call: (200, body))  # a callable: a bare list is a reply queue
    for result in (list_characters(), get_character("Mia")):
        assert result["ok"] is False and result["error"]["kind"] == "backend"
        assert "Traceback" not in result["error"]["message"]


def test_the_tools_are_read_only():
    assert list_characters.mcp_annotations["readOnlyHint"] is True
    assert get_character.mcp_annotations["readOnlyHint"] is True
    assert get_character.mcp_annotations["openWorldHint"] is False


# ------------------------------------------------------------------ character references


def resolve(backend, refs):
    return mcp_refs.normalize_references(backend.client(), refs)


def test_image_character_reference_is_the_default_face_with_metadata(backend):
    out = resolve(backend, [{"kind": "image", "character": "Mia Rose"}])
    assert out == [{"kind": "image", "role": "reference", "local": f"/outputs/characters/{MIA}/{FACE1}_face.png",
                    "size_bytes": 482113, "width": 1024, "height": 1024}]


def test_character_reference_by_id_and_role(backend):
    out = resolve(backend, [{"kind": "image", "character": MIA, "role": "first_frame"}])
    assert out[0]["role"] == "first_frame" and out[0]["local"].endswith(f"{FACE1}_face.png")


DEFAULT_AUDIO = {"kind": "audio", "role": "reference", "local": f"/outputs/characters/{MIA}/{HELLO}_hello.mp3",
                 "size_bytes": 1234, "duration_s": 3.25}


def test_audio_without_media_is_the_default_audio(backend):
    assert resolve(backend, [{"kind": "audio", "character": "mia rose"}]) == [DEFAULT_AUDIO]


def test_the_old_voice_kind_is_audio_and_its_name_is_ignored(backend):
    assert resolve(backend, [{"kind": "voice", "character": "Mia Rose", "name": "  Rosie "}]) == [DEFAULT_AUDIO]
    out = resolve(backend, [{"kind": "voice", "url": "https://x.test/v.mp3", "name": "Anna"}])
    assert out == [{"kind": "audio", "role": "reference", "url": "https://x.test/v.mp3"}]


def test_a_name_is_ignored_on_every_kind(backend):
    out = resolve(backend, [{"kind": "image", "character": "Mia Rose", "name": "Rosie"},
                            {"kind": "audio", "url": "https://x.test/a.mp3", "name": 5}])
    assert "name" not in out[0] and "name" not in out[1]


def test_media_by_id_picks_a_non_default_file(backend):
    out = resolve(backend, [{"kind": "image", "character": "Mia Rose", "media": FACE2}])
    assert out[0]["local"] == f"/outputs/characters/{MIA}/{FACE2}_Side%20View.PNG"
    assert (out[0]["width"], out[0]["height"], out[0]["size_bytes"]) == (800, 600, 300)
    assert "duration_s" not in out[0]


@pytest.mark.parametrize("label", ["Side View.PNG", "side view.png", "SIDE VIEW.png"])
def test_media_by_label_exact_then_case_insensitive(backend, label):
    out = resolve(backend, [{"kind": "image", "character": "Mia Rose", "media": label}])
    assert out[0]["local"].endswith(f"{FACE2}_Side%20View.PNG")


def test_exact_label_wins_over_a_case_insensitive_match(backend):
    files = [media(FACE1, "image", "Face.png"), media(FACE2, "image", "face.png", position=1)]
    backend.on("GET", "/api/characters", {"ok": True, "characters": [character(MIA, "Mia", files, face=FACE1)]})
    out = resolve(backend, [{"kind": "image", "character": "Mia", "media": "face.png"}])
    assert out[0]["local"].endswith(f"{FACE2}_face.png")


def test_video_and_audio_media_with_duration(backend):
    out = resolve(backend, [{"kind": "video", "character": "Mia Rose", "media": "walk.mp4"},
                            {"kind": "audio", "character": "Mia Rose", "media": SONG}])
    assert out[0] == {"kind": "video", "role": "reference", "local": f"/outputs/characters/{MIA}/{CLIP}_walk.mp4",
                      "size_bytes": 9000, "width": 1280, "height": 720, "duration_s": 4.5}
    assert out[1]["kind"] == "audio" and out[1]["duration_s"] == 60.0 and "name" not in out[1]


def test_another_audio_by_label(backend):
    out = resolve(backend, [{"kind": "audio", "character": "Mia Rose", "media": "angry.mp3"}])
    assert out[0]["local"].endswith(f"{ANGRY}_angry.mp3") and "name" not in out[0]


def test_null_metadata_is_not_sent(backend):
    files = [media(FACE1, "image", "bare.png")]
    backend.on("GET", "/api/characters", {"ok": True, "characters": [character(MIA, "Mia", files, face=FACE1)]})
    out = resolve(backend, [{"kind": "image", "character": "Mia"}])
    assert out == [{"kind": "image", "role": "reference", "local": f"/outputs/characters/{MIA}/{FACE1}_bare.png"}]


def failure(backend, ref, index=0, refs=None):
    with pytest.raises(mcp_client.ToolFailure) as caught:
        resolve(backend, refs or [ref])
    error = caught.value.result["error"]
    assert error["field"] == f"references[{index}]" and error["message"].startswith(f"references[{index}]: ")
    return error


def test_no_default_face_says_what_to_do(backend):
    error = failure(backend, {"kind": "image", "character": "Ana"})
    assert error["kind"] == "no_default_face"
    assert "Ana" in error["message"] and "no face image" in error["message"]
    assert "Characters page" in error["message"] and "media" in error["message"]


def test_no_default_audio_says_what_to_do(backend):
    error = failure(backend, {"kind": "audio", "character": "Ana"})
    assert error["kind"] == "no_default_audio"
    assert "no default audio" in error["message"] and "Characters page" in error["message"]
    assert "Ana has no audio files." in error["message"]
    for_voice = failure(backend, {"kind": "voice", "character": "Ana"})
    assert for_voice == error


def test_no_default_audio_lists_the_audio_files(backend):
    backend.on("GET", "/api/characters", {"ok": True, "characters": [
        character(MIA, "Mia", mia_files(), face=FACE1, audio=None)]})
    error = failure(backend, {"kind": "audio", "character": "Mia"})
    assert error["kind"] == "no_default_audio"
    assert all(label in error["message"] for label in ("hello.mp3", "angry.mp3", "theme.wav"))
    assert "walk.mp4" not in error["message"]


def test_a_stale_default_counts_as_no_default(backend):
    backend.on("GET", "/api/characters", {"ok": True, "characters": [
        character(MIA, "Mia", mia_files(), face="media_" + "9" * 32, audio=FACE1)]})
    assert failure(backend, {"kind": "image", "character": "Mia"})["kind"] == "no_default_face"
    assert failure(backend, {"kind": "audio", "character": "Mia"})["kind"] == "no_default_audio"


@pytest.mark.parametrize("kind,have", [("video", "walk.mp4")])
def test_video_has_no_default_and_lists_what_exists(backend, kind, have):
    error = failure(backend, {"kind": kind, "character": "Mia Rose"})
    assert error["kind"] == "media_required"
    assert f"no default {kind}" in error["message"] and have in error["message"]


def test_video_without_any_file_says_there_are_none(backend):
    error = failure(backend, {"kind": "video", "character": "Ana"})
    assert error["kind"] == "media_required" and "has no video files" in error["message"]


def test_unknown_media_names_the_candidates(backend):
    error = failure(backend, {"kind": "image", "character": "Mia Rose", "media": "nope.png"})
    assert error["kind"] == "unknown_media"
    assert "face.png" in error["message"] and "Side View.PNG" in error["message"]
    assert "walk.mp4" not in error["message"]


def test_unknown_media_id(backend):
    error = failure(backend, {"kind": "image", "character": "Mia Rose", "media": "media_" + "9" * 32})
    assert error["kind"] == "unknown_media"


def test_media_of_another_kind_is_refused(backend):
    by_id = failure(backend, {"kind": "image", "character": "Mia Rose", "media": CLIP})
    by_label = failure(backend, {"kind": "image", "character": "Mia Rose", "media": "walk.mp4"})
    for error in (by_id, by_label):
        assert error["kind"] == "wrong_media_kind"
        assert "video" in error["message"] and "image" in error["message"]


def test_media_of_another_character_is_unknown(backend):
    other = media("media_" + "7" * 32, "image", "other.png", ANA)
    backend.on("GET", "/api/characters", {"ok": True, "characters": [
        character(MIA, "Mia", mia_files(), face=FACE1), character(ANA, "Ana", [other], face=other["id"])]})
    assert failure(backend, {"kind": "image", "character": "Mia", "media": other["id"]})["kind"] == "unknown_media"
    assert failure(backend, {"kind": "image", "character": "Mia", "media": "other.png"})["kind"] == "unknown_media"


def test_a_label_matching_several_files_is_ambiguous(backend):
    files = [media(FACE1, "image", "pose.png"), media(FACE2, "image", "POSE.png", position=1)]
    backend.on("GET", "/api/characters", {"ok": True, "characters": [character(MIA, "Mia", files, face=FACE1)]})
    error = failure(backend, {"kind": "image", "character": "Mia", "media": "Pose.png"})
    assert error["kind"] == "ambiguous_media"
    assert FACE1 in error["message"] and FACE2 in error["message"]


def test_duplicate_labels_are_ambiguous_even_when_exact(backend):
    files = [media(FACE1, "image", "same.png"), media(FACE2, "image", "same.png", position=1)]
    backend.on("GET", "/api/characters", {"ok": True, "characters": [character(MIA, "Mia", files, face=FACE1)]})
    assert failure(backend, {"kind": "image", "character": "Mia", "media": "same.png"})["kind"] == "ambiguous_media"
    # the id of one of them still works
    assert resolve(backend, [{"kind": "image", "character": "Mia", "media": FACE2}])[0]["local"].endswith(FACE2 + "_same.png")


def test_unknown_and_ambiguous_character_inside_a_reference(backend):
    assert failure(backend, {"kind": "image", "character": "Nobody"})["kind"] == "unknown_character"
    backend.on("GET", "/api/characters", {"ok": True, "characters": [character(MIA, "T"), character(ANA, "t")]})
    assert failure(backend, {"kind": "image", "character": "T"})["kind"] == "ambiguous_character"


@pytest.mark.parametrize("value", ["", "  ", 5, ["Mia"]])
def test_blank_character_value_in_a_reference(backend, value):
    # `""` is a present-but-empty source, not an absent one.
    error = failure(backend, {"kind": "image", "character": value})
    assert error["kind"] in {"invalid_character", "invalid_reference"}


@pytest.mark.parametrize("value", ["", "  ", 5])
def test_blank_media_value(backend, value):
    assert failure(backend, {"kind": "image", "character": "Mia Rose", "media": value})["kind"] == "invalid_reference"


def test_media_without_character_is_an_error(backend):
    error = failure(backend, {"kind": "image", "path": "/outputs/a.png", "media": "x"})
    assert error["kind"] == "invalid_reference" and "'media'" in error["message"] and "'character'" in error["message"]
    assert failure(backend, {"kind": "image", "media": "x"})["kind"] == "invalid_reference"
    assert character_reads(backend) == []


@pytest.mark.parametrize("other", [{"path": "/outputs/a.png"}, {"url": "https://x.test/a.png"}, {"local": "/outputs/a.png"}])
def test_character_cannot_be_combined_with_path_or_url(backend, other):
    error = failure(backend, {"kind": "image", "character": "Mia Rose", **other})
    assert error["kind"] == "invalid_reference"
    assert "character" in error["message"] and character_reads(backend) == []


def test_the_exactly_one_message_mentions_character(backend):
    message = failure(backend, {"kind": "image"})["message"]
    assert "'path'" in message and "'url'" in message and "'character'" in message


def test_each_character_is_read_once_per_call(backend):
    out = resolve(backend, [
        {"kind": "image", "character": "Mia Rose"}, {"kind": "audio", "character": MIA},
        {"kind": "video", "character": "mia rose", "media": CLIP}, {"kind": "image", "character": "MIA ROSE", "media": FACE2}])
    assert len(out) == 4
    assert backend.paths() == ["/api/characters"]
    resolve(backend, [{"kind": "image", "character": "Mia Rose"}])
    assert backend.paths() == ["/api/characters", "/api/characters"]  # a new call reads again, no stale cache


def test_no_character_reference_means_no_character_read(backend):
    resolve(backend, [{"kind": "image", "url": "https://x.test/a.png"}, {"kind": "image", "path": "/outputs/a.png"}])
    assert character_reads(backend) == []


def test_mixed_references_keep_order_roles_and_error_indexes(backend):
    refs = [
        {"kind": "image", "path": "/outputs/start.png", "role": "first_frame"},
        {"kind": "image", "url": "https://img.test/b.png"},
        {"kind": "voice", "character": "Mia Rose", "name": "Rosie"},
        {"kind": "image", "character": "Mia Rose", "role": "last_frame"},
    ]
    out = resolve(backend, refs)
    assert [(r["kind"], r["role"]) for r in out] == [("image", "first_frame"), ("image", "reference"),
                                                    ("audio", "reference"), ("image", "last_frame")]
    assert out[0]["local"] == "/outputs/start.png" and out[1]["url"] == "https://img.test/b.png"
    assert out[2] == DEFAULT_AUDIO and out[3]["local"].endswith(f"{FACE1}_face.png")

    error = failure(backend, None, index=2, refs=[refs[0], refs[1], {"kind": "image", "character": "Ana"}, refs[3]])
    assert error["kind"] == "no_default_face"


def test_the_backend_local_must_be_an_outputs_path(backend):
    bad = media(FACE1, "image", "x.png", local="/etc/passwd")
    backend.on("GET", "/api/characters", {"ok": True, "characters": [character(MIA, "Mia", [bad], face=FACE1)]})
    error = failure(backend, {"kind": "image", "character": "Mia"})
    assert error["kind"] == "backend"


def test_character_read_failures_name_the_reference(backend):
    backend.on("GET", "/api/characters", {"ok": False, "error": "boom"}, status=500)
    error = failure(backend, {"kind": "image", "character": "Mia"})
    assert error["kind"] == "backend" and "boom" in error["message"]


def test_unreachable_backend_inside_generate(backend):
    backend.on("GET", "/api/characters", ConnectionRefusedError("refused"))
    result = generate(**I2I, references=[{"kind": "image", "character": "Mia"}])
    assert result["ok"] is False and result["error"]["kind"] == "backend_unreachable"
    assert submits(backend) == []


def test_malformed_character_json_inside_generate(backend):
    mcp_client.set_client(BackendClient(BASE, transport=lambda m, u, h, b, t: (200, b"not json")))
    result = generate(**I2I, references=[{"kind": "image", "character": "Mia"}])
    assert result["ok"] is False and result["error"]["kind"] == "bad_response"


# ------------------------------------------------------------------ generate with a character


REFS = [{"kind": "image", "character": "Mia Rose"}, {"kind": "audio", "character": "Mia Rose"}]
RESOLVED = [
    {"kind": "image", "role": "reference", "local": f"/outputs/characters/{MIA}/{FACE1}_face.png",
     "size_bytes": 482113, "width": 1024, "height": 1024},
    {"kind": "audio", "role": "reference", "local": f"/outputs/characters/{MIA}/{HELLO}_hello.mp3",
     "size_bytes": 1234, "duration_s": 3.25},
]


def test_generate_submits_the_resolved_characters_files_as_mcp(backend):
    result = generate(**I2I, references=REFS)
    assert result["ok"] is True
    body = submits(backend)[0]
    assert body["source"] == "mcp" and body["references"] == RESOLVED
    assert backend.bodies("/api/generation/validate")[0]["references"] == RESOLVED
    assert backend.bodies("/api/generation/estimate")[0]["references"] == RESOLVED
    assert backend.paths().count("/api/characters") == 1


def test_validate_and_estimate_use_the_same_resolution(backend):
    assert validate_generation(**I2I, references=REFS)["references"] == RESOLVED
    estimate_cost(**I2I, references=REFS)
    assert backend.bodies("/api/generation/estimate")[0]["references"] == RESOLVED
    assert submits(backend) == []


def test_generate_still_refuses_on_failed_validation(backend):
    issue = {"code": "file_too_large", "severity": "error", "field": "references[0].size_bytes",
             "message": "This file is too big."}
    backend.on("POST", "/api/generation/validate", {"ok": True, "issues": [issue]})
    result = generate(**I2I, references=REFS)
    assert result["ok"] is False and result["error"]["kind"] == "validation"
    assert submits(backend) == []


def test_generate_still_refuses_unknown_cost(backend):
    backend.on("POST", "/api/generation/estimate", {"ok": True, "estimate": None,
                                                    "unavailable": {"message": "No price for this model."}})
    result = generate(**I2I, references=REFS)
    assert result["error"]["kind"] == "unknown_cost" and submits(backend) == []
    assert generate(**I2I, references=REFS, allow_unknown_cost=True)["ok"] is True
    assert len(submits(backend)) == 1


def test_generate_still_refuses_over_max_cost(backend):
    result = generate(**I2I, references=REFS, max_cost_usd=0.5)
    assert result["error"]["kind"] == "over_budget" and submits(backend) == []
    assert generate(**I2I, references=REFS, max_cost_usd=2)["ok"] is True


def test_a_failing_character_reference_submits_nothing(backend):
    result = generate(**I2I, references=[{"kind": "image", "character": "Ana"}])
    assert result["error"]["kind"] == "no_default_face"
    assert result["error"]["field"] == "references[0]"
    assert backend.bodies("/api/generation/validate") == [] and submits(backend) == []


# ------------------------------------------------------------------ contract: the real routes


def forwarding_transport(test_client: TestClient):
    """A BackendClient transport that answers from the real FastAPI routes."""

    def transport(method, url, headers, body, timeout):
        parts = urlsplit(url)
        target = parts.path + (f"?{parts.query}" if parts.query else "")
        response = test_client.request(method, target, content=body, headers=headers)
        return response.status_code, response.content

    return transport


def test_tools_agree_with_the_real_character_routes(tmp_path, monkeypatch):
    out = tmp_path / "outputs"
    out.mkdir()
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "contract.db")
    monkeypatch.setattr(output_folder, "_state", output_folder.pinned_state(out))
    app = FastAPI()
    app.include_router(character_routes.router)
    http = TestClient(app)

    made = http.post("/api/characters", params={"name": "Zoë Rose", "width": 640, "height": 480},
                     content=b"FACE-BYTES", headers={"X-Filename": "José's \"face\" 李.png".encode("utf-8")})
    assert made.status_code == 200, made.text
    created = made.json()["character"]
    cid = created["id"]
    assert http.patch(f"/api/characters/{cid}", json={"description": "Lead"}).status_code == 200

    def upload(kind, filename, data, **params):
        raw = filename.encode("utf-8") if not filename.isascii() else filename
        reply = http.post(f"/api/characters/{cid}/media", params={"kind": kind, **params}, content=data,
                          headers={"X-Filename": raw})
        assert reply.status_code == 200, reply.text
        return reply.json()["media"]

    face = created["media"][0]
    assert created["default_face_id"] == face["id"] and face["label"] == "José's \"face\" 李.png"
    side = upload("image", "side view.png", b"SIDE-BYTES")
    voice = upload("voice", "hello there.mp3", b"VOICE-BYTES", duration_s=2.5)
    clip = upload("video", "walk.mp4", b"CLIP-BYTES", width=1280, height=720, duration_s=4.0)
    assert http.patch(f"/api/characters/{cid}", json={"default_face_id": face["id"]}).status_code == 200

    mcp_client.set_client(BackendClient(BASE, transport=forwarding_transport(http)))
    try:
        listed = list_characters()
        assert listed["ok"] is True and len(listed["characters"]) == 1
        summary = listed["characters"][0]
        assert summary["id"] == cid and "voice_name" not in summary
        assert summary["counts"] == {"image": 2, "video": 1, "audio": 1}
        assert summary["default_face"] == {"id": face["id"], "label": face["label"], "path": face["local"]}
        assert summary["default_audio"]["id"] == voice["id"] and voice["kind"] == "audio"

        got = get_character("ZOË ROSE")
        assert got["ok"] is True
        files = got["character"]["references"]
        assert [f["id"] for f in files["image"]] == [face["id"], side["id"]]
        assert [f["is_default"] for f in files["image"]] == [True, False]
        assert files["image"][0]["path"] == face["local"] and files["image"][0]["width"] == 640
        assert files["audio"][0]["duration_s"] == 2.5 and files["audio"][0]["is_default"] is True
        assert files["video"][0]["id"] == clip["id"] and list(files) == ["image", "video", "audio"]
        assert get_character(cid)["character"]["name"] == "Zoë Rose"

        refs = mcp_refs.normalize_references(BackendClient(BASE, transport=forwarding_transport(http)), [
            {"kind": "image", "character": cid},
            {"kind": "image", "character": "Zoë Rose", "media": "SIDE VIEW.PNG"},
            {"kind": "voice", "character": "zoë rose"},  # the old kind: the default audio
            {"kind": "video", "character": "Zoë Rose", "media": clip["id"], "role": "reference"},
        ])
    finally:
        mcp_client.set_client(None)

    assert [r["kind"] for r in refs] == ["image", "image", "audio", "video"]
    expected_bytes = [b"FACE-BYTES", b"SIDE-BYTES", b"VOICE-BYTES", b"CLIP-BYTES"]
    for ref, data in zip(refs, expected_bytes, strict=True):
        assert resolve_local(ref["local"], out).read_bytes() == data
        assert resolve_local(ref["local"]).read_bytes() == data
    assert refs[0]["local"] == face["local"] and refs[0]["width"] == 640 and refs[0]["size_bytes"] == len(b"FACE-BYTES")
    assert "name" not in refs[2] and refs[2]["duration_s"] == 2.5
    assert refs[3]["duration_s"] == 4.0 and refs[3]["height"] == 720
