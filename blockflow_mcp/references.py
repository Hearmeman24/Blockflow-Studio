"""Turn the references a tool caller gives into what the backend accepts.

A caller reference is ``{kind, path | url | character, media?, role?}``:

- ``kind``: ``image`` | ``video`` | ``audio``. Sound is one kind: audio is
  sent to the model as audio and the prompt says what to do with it. The old
  kind ``voice`` (older clients) is read as ``audio``.
- ``url``: a public ``http(s)://`` address (or a provider ``asset://`` id), sent as is.
- ``path``: either an app path ``/outputs/...`` (a file already in the BlockFlow
  output folder; sent as ``local``) or a file on this computer. A file inside
  the output folder is referenced where it is; any other file is checked
  (regular file, extension for its kind, size) and copied into the output
  folder through the loader blocks' ``save-local`` routes, the same way the
  Image and Video Loader blocks add a file. The backend therefore only ever
  sees ``/outputs/...`` values.
- ``character``: a character id or name (see ``tools_characters``). Without
  ``media`` an ``image`` is the character's default face and an ``audio`` its
  default audio clip; ``video`` needs ``media``. ``media``: a media id or file label of that kind
  belonging to that character. The character's file is referenced where it is
  (``/outputs/characters/...``), with the size, dimensions and duration the
  character record has.
- ``role``: ``reference`` (default), ``first_frame`` or ``last_frame``
  (Image to Video). A ``name`` (the old speaker name of a voice) is ignored.

``normalize_references`` is the single entry point. It dispatches on the
source field through ``SOURCES``; a tool group registers another source
(``character`` is the example) without touching the generation tools.
"""

import os
import re
from collections.abc import Callable, Mapping
from pathlib import Path, PurePosixPath
from typing import Any

from blockflow_mcp import character_lookup as lookup
from blockflow_mcp.client import BackendClient, ToolFailure, checked

KINDS = ("image", "video", "audio")
KIND_ALIASES = {"voice": "audio"}  # the old voice kind is audio
ROLES = ("reference", "first_frame", "last_frame")
# Same extensions as the loader blocks (frontend/src/lib/byok/loader-items.ts).
EXTENSIONS: dict[str, frozenset[str]] = {
    "image": frozenset({"jpg", "jpeg", "png", "webp", "bmp", "tiff", "tif", "gif", "heic", "heif"}),
    "video": frozenset({"mp4", "mov", "mkv", "webm", "m4v"}),
    "audio": frozenset({"mp3", "wav", "aac", "ogg", "flac", "m4a"}),
}
MAX_BYTES: dict[str, int] = {"image": 100 * 1024 ** 2, "video": 500 * 1024 ** 2, "audio": 200 * 1024 ** 2}
SAVE_ROUTES: dict[str, tuple[str, str]] = {
    "image": ("/api/blocks/upload_image_to_tmpfiles/save-local", "image_url"),
    "video": ("/api/blocks/video_loader/save-local", "video_url"),
    "audio": ("/api/blocks/video_loader/save-local", "video_url"),
}
UPLOAD_TIMEOUT_S = 300.0
OUTPUTS_PREFIX = "/outputs/"

# (resolved path, size, mtime_ns) -> /outputs value, so estimate -> generate copies a file once.
_imported: dict[tuple[str, int, int], str] = {}


def _fail(index: int, kind: str, message: str, **details: Any) -> ToolFailure:
    return ToolFailure(kind, f"references[{index}]: {message}", field=f"references[{index}]", **details)


def output_folders(client: BackendClient) -> list[Path]:
    """The app's output folders, as the running backend sees them now: the
    current one first, then earlier ones it still serves /outputs from. Empty
    when they cannot be known (then files are copied in, which is always safe)."""
    try:
        status, body = client.get("/api/settings/output-folder")
    except Exception:  # noqa: BLE001 - only an optimisation; fall back to copying
        return []
    if status != 200 or not isinstance(body, Mapping) or not isinstance(body.get("in_use"), str):
        return []
    folders = [Path(body["in_use"]).expanduser().resolve()]
    for item in body.get("previous") or []:
        if isinstance(item, Mapping) and item.get("available") and isinstance(item.get("path"), str):
            folder = Path(item["path"]).expanduser().resolve()
            if folder not in folders:
                folders.append(folder)
    return folders


def output_folder(client: BackendClient) -> Path | None:
    """The folder new files go to, or None when it cannot be known."""
    folders = output_folders(client)
    return folders[0] if folders else None


def _app_path(index: int, value: str) -> str:
    rel = value[len(OUTPUTS_PREFIX):]
    parts = PurePosixPath(rel.replace("\\", "/")).parts
    if "\x00" in value or not rel or ".." in parts or rel.startswith("/"):
        raise _fail(index, "unsafe_path", f"{value!r} is not a file inside the BlockFlow output folder.")
    return value


def _safe_name(name: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._") or "file"
    return stem[-120:]


def _import_file(client: BackendClient, index: int, kind: str, raw: str, roots: list[Path]) -> str:
    path = Path(os.path.expanduser(raw))
    if "\x00" in raw:
        raise _fail(index, "unsafe_path", "the path contains an invalid character.")
    if not path.is_absolute():
        raise _fail(index, "invalid_path", f"{raw!r} must be an absolute path (or an /outputs/... app path).")
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError):
        raise _fail(index, "missing_file", f"{raw} does not exist.") from None
    if not resolved.is_file():
        raise _fail(index, "missing_file", f"{raw} is not a regular file.")
    ext = resolved.suffix.lower().lstrip(".")
    if ext not in EXTENSIONS[kind]:
        allowed = ", ".join(sorted(EXTENSIONS[kind]))
        raise _fail(index, "wrong_type", f"{resolved.name} is not a {kind} file (allowed: {allowed}).")
    stat = resolved.stat()
    if stat.st_size == 0:
        raise _fail(index, "empty_file", f"{resolved.name} is empty.")
    if stat.st_size > MAX_BYTES[kind]:
        raise _fail(index, "too_large", f"{resolved.name} is {stat.st_size} bytes; the limit for a {kind} "
                                        f"is {MAX_BYTES[kind]} bytes.")
    for root in roots:  # already in an output folder the backend serves: no copy
        if resolved != root and resolved.is_relative_to(root):
            return OUTPUTS_PREFIX + resolved.relative_to(root).as_posix()
    key = (str(resolved), stat.st_size, stat.st_mtime_ns)
    if key in _imported:
        return _imported[key]
    route, field = SAVE_ROUTES[kind]
    status, body = client.post(route, data=resolved.read_bytes(), timeout=UPLOAD_TIMEOUT_S,
                               headers={"Content-Type": "application/octet-stream",
                                        "X-Filename": _safe_name(resolved.name)})
    body = checked(status, body, f"Copying {resolved.name} into the output folder")
    saved = body.get(field)
    if not isinstance(saved, str) or not saved.startswith(OUTPUTS_PREFIX):
        raise _fail(index, "import_failed", f"BlockFlow did not return a saved path for {resolved.name}.")
    _imported[key] = saved
    return saved


def _from_url(client: BackendClient, index: int, ref: Mapping[str, Any], root_getter: Callable[[], list[Path]],
              cache: dict[str, Any]) -> dict[str, Any]:
    url = ref["url"]
    if not isinstance(url, str) or not re.match(r"^(https?://\S+|asset://\S+)$", url.strip(), re.IGNORECASE):
        raise _fail(index, "invalid_url", "'url' must be a public http(s):// address.")
    return {"url": url.strip()}


def _from_path(client: BackendClient, index: int, ref: Mapping[str, Any], root_getter: Callable[[], list[Path]],
               cache: dict[str, Any]) -> dict[str, Any]:
    raw = ref.get("path") if ref.get("path") is not None else ref.get("local")
    if not isinstance(raw, str) or not raw.strip():
        raise _fail(index, "invalid_path", "'path' must be a non-empty string.")
    raw = raw.strip()
    if raw.startswith(OUTPUTS_PREFIX):
        return {"local": _app_path(index, raw)}
    return {"local": _import_file(client, index, ref["kind"], raw, root_getter())}


def _no_default(index: int, character: Mapping[str, Any], kind: str) -> ToolFailure:
    name = character.get("name")
    if kind == "image":
        return _fail(index, "no_default_face", f"{name} has no face image. Add one on the Characters page, or pass "
                                               f"'media'. {lookup.describe_files(character, 'image')}")
    if kind == "audio":
        return _fail(index, "no_default_audio", f"{name} has no default audio. Add an audio clip on the Characters "
                                                f"page, or pass 'media'. {lookup.describe_files(character, 'audio')}",
                     available=[m.get("label") for m in lookup.media_of(character, "audio")])
    return _fail(index, "media_required", f"There is no default {kind} for a character; pass 'media' (a file "
                                          f"label or media id). {lookup.describe_files(character, kind)}")


def _from_character(client: BackendClient, index: int, ref: Mapping[str, Any],
                    root_getter: Callable[[], list[Path]], cache: dict[str, Any]) -> dict[str, Any]:
    kind = ref["kind"]
    try:
        character = lookup.find_character(client, ref["character"], cache)
        if ref.get("media") is not None:
            file = lookup.find_media(character, kind, ref["media"])
        else:
            file = lookup.default_media(character, kind)
            if file is None:
                raise _no_default(index, character, kind)
        out: dict[str, Any] = {"local": lookup.app_path(file), **lookup.metadata(file)}
    except ToolFailure as failure:
        if failure.result["error"].get("field") == f"references[{index}]":
            raise
        details = {k: v for k, v in failure.result["error"].items() if k not in ("kind", "message")}
        raise _fail(index, failure.result["error"]["kind"], failure.result["error"]["message"], **details) from None
    return out


# source field -> resolver(client, index, ref, output_folders getter, per-call cache) -> {"url"} | {"local", ...}
SOURCES: dict[str, Callable[..., dict[str, Any]]] = {"url": _from_url, "path": _from_path, "local": _from_path,
                                                     "character": _from_character}


def normalize_references(client: BackendClient, references: Any) -> list[dict[str, Any]]:
    """Backend reference dicts for the caller's references (files copied in as
    needed). Raises ToolFailure naming the bad reference."""
    if references is None:
        return []
    if not isinstance(references, list):
        raise ToolFailure("invalid_references", "'references' must be a list of {kind, path | url | character, media?, role?}.")
    root_cache: list[list[Path]] = []
    cache: dict[str, Any] = {}  # per call: the characters are read from the backend once

    def root() -> list[Path]:
        if not root_cache:
            root_cache.append(output_folders(client))
        return root_cache[0]

    out: list[dict[str, Any]] = []
    for i, ref in enumerate(references):
        if not isinstance(ref, Mapping):
            raise _fail(i, "invalid_reference", "each reference must be an object.")
        kind = ref.get("kind")
        if isinstance(kind, str) and kind in KIND_ALIASES:
            kind = KIND_ALIASES[kind]
            ref = {**ref, "kind": kind}
        if kind not in KINDS:
            raise _fail(i, "invalid_reference", f"'kind' must be one of {', '.join(KINDS)}.")
        sources = [s for s in SOURCES if ref.get(s) is not None]
        if "path" in sources and "local" in sources:
            sources.remove("local")
        if ref.get("media") is not None and "character" not in sources:
            raise _fail(i, "invalid_reference", "'media' is used together with 'character' only.")
        if len(sources) != 1:
            raise _fail(i, "invalid_reference", "give exactly one of 'path', 'url' or 'character'.")
        role = ref.get("role") or "reference"
        if role not in ROLES:
            raise _fail(i, "invalid_reference", f"'role' must be one of {', '.join(ROLES)}.")
        # A `name` (an old voice's speaker name) is ignored: nothing names a reference any more.
        item: dict[str, Any] = {"kind": kind, "role": role, **SOURCES[sources[0]](client, i, ref, root, cache)}
        out.append(item)
    return out
