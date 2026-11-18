from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import settings_store  # noqa: E402


def _load_sidecar(slug: str):
    path = ROOT / "custom_blocks" / slug / "backend.block.py"
    spec = importlib.util.spec_from_file_location(f"{slug}_backend_for_asset_upload_test", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture(autouse=True)
def fresh_settings(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_store, "DB_PATH", tmp_path / "settings.db")
    settings_store.init_db()


def test_asset_upload_mode_defaults_to_local_only():
    """An install that never chose a mode keeps files local, like the generation service."""
    from backend import asset_uploads
    from backend.byok import service

    assert settings_store.get_app_pref("asset_storage_mode") is None
    assert asset_uploads.get_asset_storage_mode() == "local_only"
    assert asset_uploads.DEFAULT_ASSET_STORAGE_MODE == "local_only"
    assert service.STORAGE_MODE_PREF == asset_uploads.ASSET_STORAGE_MODE_PREF


def test_unset_mode_refuses_remote_upload_without_network(monkeypatch):
    from backend import asset_uploads

    calls: list[str] = []
    monkeypatch.setattr(asset_uploads, "_upload_to_tmpfiles", lambda *a, **k: calls.append("tmpfiles") or "x")

    with pytest.raises(asset_uploads.RemoteAssetUploadDisabled):
        asset_uploads.upload_asset(b"bytes", filename="a.png", content_type="image/png", media_kind="image")
    assert calls == []


def test_asset_upload_mode_invalid_value_falls_back_to_local_only():
    from backend import asset_uploads

    settings_store.set_app_pref("asset_storage_mode", "forever_public")

    assert asset_uploads.get_asset_storage_mode() == "local_only"


def test_local_only_mode_refuses_remote_upload():
    from backend import asset_uploads

    settings_store.set_app_pref("asset_storage_mode", "local_only")

    with pytest.raises(asset_uploads.RemoteAssetUploadDisabled) as exc:
        asset_uploads.upload_asset(
            b"image-bytes",
            filename="source.png",
            content_type="image/png",
            media_kind="image",
        )

    assert "local-only" in str(exc.value).lower()


def test_tmpfiles_mode_uses_tmpfiles_boundary(monkeypatch):
    from backend import asset_uploads

    settings_store.set_app_pref("asset_storage_mode", "tmpfiles")
    calls: list[tuple[bytes, str, str]] = []

    def fake_upload(data: bytes, filename: str, content_type: str) -> str:
        calls.append((data, filename, content_type))
        return "https://tmpfiles.org/dl/abc/source.png"

    monkeypatch.setattr(asset_uploads, "_upload_to_tmpfiles", fake_upload)

    result = asset_uploads.upload_asset(
        b"image-bytes",
        filename="source.png",
        content_type="image/png",
        media_kind="image",
    )

    assert result == {
        "url": "https://tmpfiles.org/dl/abc/source.png",
        "provider": "tmpfiles",
        "expires_at": None,
    }
    assert calls == [(b"image-bytes", "source.png", "image/png")]


def test_saved_r2_signed_mode_degrades_to_local_only(monkeypatch):
    """A pref saved by an older build that offered signed-bucket storage reads
    as local_only: nothing is sent to tmpfiles or a bucket."""
    from backend import asset_uploads

    settings_store.set_app_pref("asset_storage_mode", "r2_signed")
    calls: list[tuple[bytes, str, str]] = []

    def fake_upload(data: bytes, filename: str, content_type: str) -> str:
        calls.append((data, filename, content_type))
        return "https://tmpfiles.org/dl/abc/source.png"

    monkeypatch.setattr(asset_uploads, "_upload_to_tmpfiles", fake_upload)

    assert asset_uploads.get_asset_storage_mode() == "local_only"
    with pytest.raises(asset_uploads.RemoteAssetUploadDisabled):
        asset_uploads.upload_asset(
            b"image-bytes",
            filename="source.png",
            content_type="image/png",
            media_kind="image",
        )
    assert calls == []
    assert "r2_signed" not in asset_uploads.ASSET_STORAGE_MODES


def test_image_upload_route_returns_provider_metadata(monkeypatch):
    from backend import asset_uploads

    mod = _load_sidecar("upload_image_to_tmpfiles")
    app = FastAPI()
    app.include_router(mod.router)
    client = TestClient(app)

    def fake_upload(data: bytes, *, filename: str, content_type: str, media_kind: str):
        assert data == b"image-bytes"
        assert filename == "source.png"
        assert content_type == "image/png"
        assert media_kind == "image"
        return {
            "url": "https://tmpfiles.org/dl/xyz/image.png",
            "provider": "tmpfiles",
            "expires_at": None,
        }

    monkeypatch.setattr(asset_uploads, "upload_asset", fake_upload)

    res = client.post(
        "/upload",
        content=b"image-bytes",
        headers={"X-Filename": "source.png", "X-Content-Type": "image/png"},
    )

    assert res.status_code == 200
    assert res.json() == {
        "ok": True,
        "image_url": "https://tmpfiles.org/dl/xyz/image.png",
        "provider": "tmpfiles",
        "expires_at": None,
    }


def test_video_upload_route_reports_local_only_without_network(monkeypatch):
    from backend import asset_uploads

    mod = _load_sidecar("video_loader")
    app = FastAPI()
    app.include_router(mod.router)
    client = TestClient(app)

    def disabled(*args, **kwargs):
        raise asset_uploads.RemoteAssetUploadDisabled("Remote asset upload is disabled by local-only storage mode")

    monkeypatch.setattr(asset_uploads, "upload_asset", disabled)

    res = client.post(
        "/upload",
        content=b"video-bytes",
        headers={"X-Filename": "clip.mp4", "X-Content-Type": "video/mp4"},
    )

    assert res.status_code == 200
    assert res.json() == {
        "ok": False,
        "error": "Remote asset upload is disabled by local-only storage mode",
        "provider": "local_only",
    }
