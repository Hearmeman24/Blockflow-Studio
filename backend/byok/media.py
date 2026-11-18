"""Turn references into URLs the provider can fetch.

Public ``http(s)://`` and ``asset://`` URLs pass through unchanged. Local files
are uploaded through the provider's own upload API; when that is unavailable
(PiAPI plan gate, file over the cap, unsupported type) the shared tmpfiles
helper is used instead. Uploaders are injected so tests use fakes.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Callable, Sequence
from pathlib import Path

from backend.byok.errors import ProviderError
from backend.byok.spec import Reference

Uploader = Callable[[Path, str], str]
FallbackUploader = Callable[[Path], str]

# Provider upload failures that mean "use the fallback host instead".
FALLBACK_CODES = frozenset({"plan_required", "file_too_large", "unsupported_file_type"})

_PASS_THROUGH = ("http://", "https://", "asset://")


def default_resolve_local(url: str) -> Path:
    """Map an app ``/outputs/...`` path (or a plain filesystem path) to a file."""
    if url.startswith("/outputs/"):
        from backend import output_folder

        return output_folder.locate(url)
    return Path(url)


def default_fallback_uploader(path: Path) -> str:
    from backend import tmpfiles

    return tmpfiles.upload_to_tmpfiles(path)


def prepare_reference(
    ref: Reference,
    provider: str,
    api_key: str,
    *,
    uploader: Uploader,
    fallback_uploader: FallbackUploader | None = None,
    resolve_local: Callable[[str], Path] = default_resolve_local,
) -> str:
    """Return a URL for ``ref`` that ``provider`` can fetch."""
    url = (ref.url or "").strip()
    if not url:
        raise ProviderError("validation", "A reference has no file or URL.", provider=provider, retryable=False)
    if url.lower().startswith(_PASS_THROUGH):
        return url
    path = resolve_local(url)
    if not path.is_file():
        raise ProviderError("validation", f"Reference file not found: {path.name}", provider=provider,
                            retryable=False)
    try:
        return uploader(path, api_key)
    except ProviderError as err:
        if err.kind != "unsupported" or err.provider_code not in FALLBACK_CODES:
            raise
    fallback = fallback_uploader or default_fallback_uploader
    try:
        return fallback(path)
    except ProviderError:
        raise
    except (OSError, RuntimeError, ValueError) as exc:
        raise ProviderError("network", f"Could not upload {path.name} to the temporary file host.",
                            provider=provider, retryable=True) from exc


def prepare_references(
    refs: Sequence[Reference],
    provider: str,
    api_key: str,
    *,
    uploader: Uploader,
    fallback_uploader: FallbackUploader | None = None,
    resolve_local: Callable[[str], Path] = default_resolve_local,
) -> list[Reference]:
    """New references with prepared URLs, same order and count. Inputs are not mutated."""
    return [
        dataclasses.replace(r, url=prepare_reference(r, provider, api_key, uploader=uploader,
                                                     fallback_uploader=fallback_uploader,
                                                     resolve_local=resolve_local))
        for r in refs
    ]
