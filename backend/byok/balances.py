"""Remaining credits per provider, for the credits panel.

``get_balances(refresh=False)`` queries every configured provider in parallel
with a short timeout and returns one entry per provider, in ``PROVIDERS``
order::

    {provider, label, configured, status, amount?, unit?, usd_equivalent?,
     message?, kind?, fetched_at}

``status`` is ``ok`` | ``unavailable`` (the provider answered without a
readable balance) | ``error`` (auth, timeout, network, ...) |
``not_configured``. One provider failing never fails the others. Successful
and unavailable answers are cached for ``CACHE_TTL_S`` per provider and key
fingerprint, so saving a new key never shows the old key's balance; errors
are not cached. Keys are read from the settings store, passed only to the
adapter, and never returned or logged.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from typing import Any, Callable

from backend.byok import service
from backend.byok.errors import ProviderError, redact
from backend.byok.spec import PROVIDER_NAMES, PROVIDERS
from backend.statuses import BalanceStatus

logger = logging.getLogger(__name__)

CACHE_TTL_S = 30.0
TIMEOUT_S = 10.0  # wall-clock cap per provider, above the adapter's own timeout

clock: Callable[[], float] = time.time

_cache: dict[str, tuple[float, str, dict[str, Any]]] = {}
_cache_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=len(PROVIDERS) * 2, thread_name_prefix="byok-balance")


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _fingerprint(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def _base(provider: str, configured: bool) -> dict[str, Any]:
    return {"provider": provider, "label": PROVIDER_NAMES[provider], "configured": configured}


def _error(provider: str, kind: str, message: str) -> dict[str, Any]:
    return {**_base(provider, True), "status": BalanceStatus.ERROR, "kind": kind, "message": message, "fetched_at": clock()}


def _fetch(provider: str, key: str) -> dict[str, Any]:
    name = PROVIDER_NAMES[provider]
    try:
        balance = service.adapter_factory(provider).get_balance(key)
    except ProviderError as err:
        logger.info("balance lookup for %s failed (%s)", provider, err.kind)
        if err.kind == "auth":
            message = f"{name} rejected the saved API key. Check the {name} key in Settings."
        else:
            message = service.error_message(err.kind, err.message, provider, key)
        return _error(provider, err.kind, redact(message, key))
    except Exception as exc:  # noqa: BLE001 - one provider never fails the panel
        logger.warning("balance lookup for %s crashed (%s)", provider, type(exc).__name__)
        return _error(provider, "provider_failure", f"Could not read the {name} balance. Try again.")
    entry = {**_base(provider, True), "status": balance.status, "fetched_at": clock()}
    if balance.status == BalanceStatus.OK and balance.amount is not None:
        entry.update(amount=balance.amount, unit=balance.unit, usd_equivalent=balance.usd_equivalent)
    else:
        entry["status"] = BalanceStatus.UNAVAILABLE
        entry["message"] = redact(balance.message, key) or f"{name} did not report a balance."
    return entry


def get_balances(refresh: bool = False) -> list[dict[str, Any]]:
    keys = {p: service.get_api_key(p) for p in PROVIDERS}
    results: dict[str, dict[str, Any]] = {}
    pending: dict[str, Any] = {}
    now = clock()
    for provider in PROVIDERS:
        key = keys[provider]
        if not key:
            results[provider] = {**_base(provider, False), "status": BalanceStatus.NOT_CONFIGURED, "fetched_at": now}
            continue
        if not refresh:
            with _cache_lock:
                cached = _cache.get(provider)
            if cached and cached[0] > now and cached[1] == _fingerprint(key):
                results[provider] = dict(cached[2])
                continue
        pending[provider] = _pool.submit(_fetch, provider, key)
    for provider, future in pending.items():
        try:
            entry = future.result(timeout=TIMEOUT_S)
        except FutureTimeout:
            name = PROVIDER_NAMES[provider]
            entry = _error(provider, "timeout", f"{name} did not answer in time. Try again.")
        results[provider] = entry
        if entry["status"] in (BalanceStatus.OK, BalanceStatus.UNAVAILABLE):
            with _cache_lock:
                _cache[provider] = (clock() + CACHE_TTL_S, _fingerprint(keys[provider] or ""), dict(entry))
    return [results[p] for p in PROVIDERS]
