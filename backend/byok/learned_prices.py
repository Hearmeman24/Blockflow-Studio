"""Unit prices learned from the provider's own charges, and price checks.

When a job finishes with a provider-reported cost, ``learn()``:

1. works out the request's billing structure with ``pricing.price_components``;
   when it is a single price key with a known quantity (e.g. 5 s at 720p, or
   one image), the unit price is ``actual / quantity`` and is stored in the
   ``learned_prices`` table with the date (newest observation wins). Requests
   that cannot be split unambiguously (an unknown reference-video length,
   a main price plus surcharges, auto duration) teach nothing;
2. compares the actual charge with what the ledger (not a learned price)
   predicts and returns a ``price_check``::

       {"expected": {amount, unit}, "actual": {amount, unit},
        "source": "ledger" | "bundled", "differs": bool,
        "checked_at": ISO, "report_url": str | None}

   ``differs`` when they are apart by more than 5 % or one smallest unit
   (0.5 Kie credit, $0.01). ``report_url`` is a prefilled new-issue link on
   ``PRICE_LEDGER_REPO`` holding only provider, provider model identifier,
   variant, unit, ledger price, observed price and dates; it is ``None``
   without a configured repo or when the request had several price parts.

Everything stays on this machine; nothing here makes a network call.
"""

from __future__ import annotations

import logging
import math
import sqlite3
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlencode

from backend import db
from backend.byok import price_sources, pricing

logger = logging.getLogger(__name__)

TABLE = "learned_prices"
TOLERANCE = 0.05
SMALLEST_UNIT = {"kie": 0.5, "piapi": 0.01}
# The "Report a price change" issue form in the ledger repository
# (.github/ISSUE_TEMPLATE/price-change.yml): its field ids are these query
# parameters, which GitHub uses to prefill the form. Keep both in sync.
REPORT_TEMPLATE = "price-change.yml"
REPORT_FIELDS = ("provider", "model", "variant", "unit", "ledger_price", "ledger_date", "observed_price",
                 "observed_date")
clock: Callable[[], float] = time.time


@dataclass(frozen=True)
class Observed:
    amount: float
    observed_at: str
    samples: int


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(db.DB_PATH), timeout=10)
    conn.execute(
        f"CREATE TABLE IF NOT EXISTS {TABLE} ("
        " provider TEXT NOT NULL, model TEXT NOT NULL, unit TEXT NOT NULL,"
        " resolution TEXT NOT NULL DEFAULT '', variant TEXT NOT NULL DEFAULT '',"
        " amount REAL NOT NULL, observed_at TEXT NOT NULL, samples INTEGER NOT NULL DEFAULT 1,"
        " PRIMARY KEY (provider, model, unit, resolution, variant))"
    )
    return conn


def _row_key(key: pricing.PriceKey) -> tuple[str, str, str, str, str]:
    provider, model, unit, resolution, variant = key
    return (provider, model, unit, resolution or "", variant or "")


def lookup(key: pricing.PriceKey) -> Observed | None:
    try:
        conn = _connect()
        try:
            row = conn.execute(
                f"SELECT amount, observed_at, samples FROM {TABLE} WHERE provider = ? AND model = ? AND unit = ?"
                " AND resolution = ? AND variant = ?", _row_key(key)).fetchone()
        finally:
            conn.close()
    except sqlite3.Error:
        return None
    return Observed(float(row[0]), row[1], int(row[2])) if row else None


def _store(key: pricing.PriceKey, amount: float, observed_at: str) -> None:
    conn = _connect()
    try:
        conn.execute(
            f"INSERT INTO {TABLE} (provider, model, unit, resolution, variant, amount, observed_at, samples)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT (provider, model, unit, resolution, variant)"
            " DO UPDATE SET amount = excluded.amount, observed_at = excluded.observed_at, samples = samples + 1",
            (*_row_key(key), amount, observed_at))
        conn.commit()
    finally:
        conn.close()


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _actual(provider: str, cost: Mapping[str, Any]) -> float | None:
    """The charge in the ledger's currency: Kie credits, PiAPI dollars."""
    unit = str(cost.get("unit") or "").lower()
    value = cost.get("amount") if provider == "kie" and unit == "credits" else (
        cost.get("usd_equivalent") if provider == "piapi" else None)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value)


def report_url(key: pricing.PriceKey, ledger_rate: float, ledger_date: str, observed_rate: float,
               observed_date: str) -> str | None:
    repo = price_sources.configured_repo()
    if not repo:
        return None
    provider, model, unit, resolution, variant = key
    title = f"Price change: {provider} {model}" + (f" {resolution}" if resolution else "")
    values = {
        "provider": provider,
        "model": model,
        "variant": ", ".join(x for x in (resolution, variant) if x) or "none",
        "unit": unit,
        "ledger_price": f"{ledger_rate:g}",
        "ledger_date": ledger_date,
        "observed_price": f"{observed_rate:g}",
        "observed_date": observed_date,
    }
    query = {"template": REPORT_TEMPLATE, "title": title, **{name: values[name] for name in REPORT_FIELDS}}
    return f"https://github.com/{repo}/issues/new?" + urlencode(query)


def learn(provider: str, model_id: str, mode: str, params: Mapping[str, Any] | None,
          references: Sequence[Mapping[str, Any]] | None, cost: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Learn from one finished job's charge; return its price check (or None)."""
    try:
        _connect().close()  # create the table on first use (older databases lack it)
    except sqlite3.Error:
        pass
    if not isinstance(cost, Mapping):
        return None
    actual = _actual(provider, cost)
    if actual is None:
        return None
    refs = [{**r, "url": r.get("url") or r.get("local")} for r in references or [] if isinstance(r, Mapping)]
    now = _iso(clock())
    components = pricing.price_components(provider, model_id, mode, params, refs)
    single = components is not None and not components.partial and len(components.items) == 1 \
        and components.items[0][1] > 0
    if single:
        # A model priced per token has no unit price to learn per image or second.
        key = components.items[0][0]
        note = pricing.ledger_provider()[0].note(key[0], key[1], key[4])
        single = note is None or note.code != "priced_per_token"
    observed_rate = None
    if single and actual > 0:
        key, quantity = components.items[0]
        observed_rate = actual / quantity
        try:
            _store(key, observed_rate, now)
        except sqlite3.Error as exc:
            logger.warning("could not store a learned price: %s", type(exc).__name__)
    expected = pricing.estimate_cost(provider, model_id, mode, params, refs, use_observed=False)
    if expected is None or expected.get("confidence") != "listed":
        return None
    exp_amount = float(expected["amount"])
    tolerance = max(TOLERANCE * exp_amount, SMALLEST_UNIT.get(provider, 0.0))
    differs = abs(actual - exp_amount) > tolerance + 1e-9
    url = None
    if differs and observed_rate is not None:
        key = components.items[0][0]
        ledger, _ = pricing.ledger_provider()
        entry = ledger.find(*key)
        if entry is not None:
            url = report_url(key, entry.amount, entry.as_of, round(observed_rate, 6), now[:10])
    unit = "credits" if provider == "kie" else "usd"
    return {"expected": {"amount": exp_amount, "unit": unit}, "actual": {"amount": actual, "unit": unit},
            "source": expected["price_source"], "differs": differs, "checked_at": now, "report_url": url}
