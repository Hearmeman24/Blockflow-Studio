"""scripts/sync_price_ledger.py: refresh the bundled ledger from the ledger repository."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.byok import price_ledger  # noqa: E402
from backend.byok.errors import ProviderError  # noqa: E402
from backend.byok.http import HttpResponse  # noqa: E402

spec = importlib.util.spec_from_file_location("sync_price_ledger", ROOT / "scripts" / "sync_price_ledger.py")
sync = importlib.util.module_from_spec(spec)
sys.modules["sync_price_ledger"] = sync
spec.loader.exec_module(sync)

BUNDLED = price_ledger.BUNDLED_PATH.read_bytes()
MODEL_MAP = price_ledger.MODEL_MAP_PATH.read_bytes()


def newer(generated_at="2099-01-01T00:00:00Z", amount=None) -> bytes:
    data = json.loads(BUNDLED)
    data["generated_at"] = generated_at
    if amount is not None:
        data["entries"][0]["amount"] = amount
    return price_ledger.dumps(data).encode()


class FakeTransport:
    def __init__(self, files):
        self.files = files
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append((method, url, dict(headers)))
        item = self.files[url.rsplit("/", 1)[-1]]
        if isinstance(item, BaseException):
            raise item
        if isinstance(item, HttpResponse):
            return item
        return HttpResponse(200, item, {})


@pytest.fixture
def app(tmp_path):
    """A copy of the bundled files the script may rewrite."""
    d = tmp_path / "prices"
    d.mkdir()
    (d / "prices.json").write_bytes(BUNDLED)
    (d / "model-map.json").write_bytes(MODEL_MAP)
    return d


def run(app, *args, transport=None):
    return sync.run(["--dest", str(app), *args], transport=transport)


def test_defaults_point_at_the_ledger_repository():
    assert sync.DEFAULT_BASE == "https://raw.githubusercontent.com/Hearmeman24/blockflow-prices/main/"


def test_downloads_validates_and_rewrites(app):
    transport = FakeTransport({"prices.json": newer(amount=99.0), "model-map.json": MODEL_MAP})
    assert run(app, transport=transport) == sync.EXIT_OK
    assert json.loads((app / "prices.json").read_text())["generated_at"] == "2099-01-01T00:00:00Z"
    assert [c[1] for c in transport.calls] == [sync.DEFAULT_BASE + "prices.json", sync.DEFAULT_BASE + "model-map.json"]
    assert all(c[0] == "GET" and set(c[2]) <= {"Accept", "User-Agent"} for c in transport.calls)


def test_from_a_local_checkout(app, tmp_path):
    src = tmp_path / "checkout"
    src.mkdir()
    (src / "prices.json").write_bytes(newer())
    (src / "model-map.json").write_bytes(MODEL_MAP)
    assert run(app, "--from", str(src)) == sync.EXIT_OK
    assert (app / "prices.json").read_bytes() == newer()


def test_already_current_writes_nothing(app):
    before = (app / "prices.json").stat().st_mtime_ns
    assert run(app, transport=FakeTransport({"prices.json": BUNDLED, "model-map.json": MODEL_MAP})) == sync.EXIT_OK
    assert (app / "prices.json").stat().st_mtime_ns == before


@pytest.mark.parametrize("files", [
    {"prices.json": b"{nope", "model-map.json": MODEL_MAP},
    {"prices.json": b'{"schema_version": 1, "entries": []}', "model-map.json": MODEL_MAP},
    {"prices.json": newer(), "model-map.json": b'{"schema_version": 1}'},
    {"prices.json": HttpResponse(404, b"404: Not Found", {}), "model-map.json": MODEL_MAP},
    {"prices.json": ProviderError("timeout", "slow"), "model-map.json": MODEL_MAP},
])
def test_invalid_or_unreachable_files_are_refused(app, files):
    assert run(app, transport=FakeTransport(files)) == sync.EXIT_REFUSED
    assert (app / "prices.json").read_bytes() == BUNDLED
    assert (app / "model-map.json").read_bytes() == MODEL_MAP


def test_an_older_ledger_is_refused(app):
    transport = FakeTransport({"prices.json": newer("2020-01-01T00:00:00Z"), "model-map.json": MODEL_MAP})
    assert run(app, transport=transport) == sync.EXIT_REFUSED
    assert (app / "prices.json").read_bytes() == BUNDLED


def test_check_mode(app):
    behind = FakeTransport({"prices.json": newer(), "model-map.json": MODEL_MAP})
    assert run(app, "--check", transport=behind) == sync.EXIT_BEHIND
    assert (app / "prices.json").read_bytes() == BUNDLED  # never writes
    current = FakeTransport({"prices.json": BUNDLED, "model-map.json": MODEL_MAP})
    assert run(app, "--check", transport=current) == sync.EXIT_OK


def test_a_changed_model_map_alone_counts(app):
    data = json.loads(MODEL_MAP)
    data["kie"]["watch"].append("newmodel")
    changed = (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode()
    files = {"prices.json": BUNDLED, "model-map.json": changed}
    assert run(app, "--check", transport=FakeTransport(files)) == sync.EXIT_BEHIND
    assert run(app, transport=FakeTransport(files)) == sync.EXIT_OK
    assert (app / "model-map.json").read_bytes() == changed
