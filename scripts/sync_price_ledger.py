#!/usr/bin/env python3
"""Refresh the bundled price ledger from the ledger repository.

The price list lives in https://github.com/Hearmeman24/blockflow-prices (a
daily job there keeps ``prices.json`` current). Each BlockFlow release
bundles a copy in ``prices/``; run this before a release:

    uv run python scripts/sync_price_ledger.py            # download, validate, rewrite prices/
    uv run python scripts/sync_price_ledger.py --check    # exit 1 when the bundled copy is behind
    uv run python scripts/sync_price_ledger.py --from ../blockflow-prices   # a local checkout

Both files are validated with the app's own validator. An invalid file, or a
``prices.json`` older than the bundled one, is refused and nothing is
written. Afterwards regenerate the docs (``scripts/gen_byok_docs.py``): the
pricing-coverage page is built from the ledger.

Exit codes: 0 done or already current · 1 ``--check``: the bundled copy is
behind · 2 refused (unreachable, invalid or older).
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.byok import price_ledger  # noqa: E402
from backend.byok.errors import ProviderError  # noqa: E402
from backend.byok.http import Transport, UrllibTransport  # noqa: E402

DEFAULT_BASE = "https://raw.githubusercontent.com/Hearmeman24/blockflow-prices/main/"
FILES = ("prices.json", "model-map.json")
EXIT_OK, EXIT_BEHIND, EXIT_REFUSED = 0, 1, 2
TIMEOUT_S = 30.0
MAX_BYTES = 5_000_000


class Refused(Exception):
    pass


def _download(transport: Transport, url: str) -> bytes:
    try:
        resp = transport("GET", url, {"Accept": "application/json", "User-Agent": "BlockFlow price sync"}, None,
                         TIMEOUT_S)
    except ProviderError as exc:
        raise Refused(f"{url}: {exc.kind}") from None
    if resp.status != 200:
        raise Refused(f"{url}: HTTP {resp.status}")
    if len(resp.body) > MAX_BYTES:
        raise Refused(f"{url}: larger than {MAX_BYTES} bytes")
    return resp.body


def _when(ledger: price_ledger.Ledger) -> datetime:
    return datetime.fromisoformat(ledger.generated_at.replace("Z", "+00:00"))


def fetch(source: str | None, transport: Transport) -> dict[str, bytes]:
    if source and not source.startswith("https://"):
        base = Path(source)
        try:
            return {name: (base / name).read_bytes() for name in FILES}
        except OSError as exc:
            raise Refused(f"{source}: {type(exc).__name__}") from None
    base_url = source or DEFAULT_BASE
    base_url = base_url if base_url.endswith("/") else base_url + "/"
    return {name: _download(transport, base_url + name) for name in FILES}


def validate(files: dict[str, bytes], dest: Path) -> None:
    try:
        ledger = price_ledger.validate_ledger(json.loads(files["prices.json"]))
        price_ledger.validate_model_map(json.loads(files["model-map.json"]))
    except (ValueError, UnicodeDecodeError) as exc:
        raise Refused(f"invalid file: {str(exc)[:200]}") from None
    current = dest / "prices.json"
    if current.exists():
        try:
            bundled = price_ledger.load_file(current)
        except price_ledger.LedgerError:
            return  # a broken bundled copy may always be replaced by a valid one
        if _when(ledger) < _when(bundled):
            raise Refused(f"prices.json from {ledger.generated_at} is older than the bundled {bundled.generated_at}")


def run(argv: Sequence[str] | None = None, transport: Transport | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from", dest="source", help="a local checkout of the ledger repo, or another https base URL")
    parser.add_argument("--dest", type=Path, default=price_ledger.PRICES_DIR, help=argparse.SUPPRESS)
    parser.add_argument("--check", action="store_true", help="exit 1 when the bundled copy is behind")
    args = parser.parse_args(argv)
    try:
        files = fetch(args.source, transport or UrllibTransport())
        validate(files, args.dest)
    except Refused as exc:
        print(f"Refused: {exc}. The bundled copy was not changed.", file=sys.stderr)
        return EXIT_REFUSED
    changed = [n for n in FILES if not (args.dest / n).exists() or (args.dest / n).read_bytes() != files[n]]
    if not changed:
        print("The bundled price ledger is current.")
        return EXIT_OK
    if args.check:
        print("Behind the ledger repository: " + ", ".join(changed), file=sys.stderr)
        return EXIT_BEHIND
    for name in changed:
        tmp = args.dest / f".{name}.tmp"
        tmp.write_bytes(files[name])
        tmp.replace(args.dest / name)
    print("Updated " + ", ".join(changed) + ". Now run: uv run python scripts/gen_byok_docs.py")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(run())
