"""Pre-run cost estimates.

Neither Kie nor PiAPI documents a price-quote endpoint, so the estimate a
generation block shows before a run comes from prices, in this order:

1. ``observed``: a unit price this install learned from the provider's own
   charge for an earlier run (``learned_prices.py``);
2. ``ledger``: the price ledger refreshed from ``PRICE_LEDGER_URL``
   (``price_sources.py``), when one is configured and newer than the bundled copy;
3. ``bundled``: ``prices/prices.json`` shipped with the app.

Where no layer lists a price for the request, ``estimate_cost`` returns
``None`` (no estimate is better than a wrong one). The provider's actual
charge is reported after the run (``job.cost``) and is authoritative.

Public API:

- ``estimate_cost(provider, model_id, mode, params, references) -> dict | None``
  ``{amount, unit, usd_equivalent, basis, source, as_of, confidence,
  price_source, price_updated_at}``; ``confidence`` is ``listed`` or
  ``partial`` (a lower bound, or a rounding/billing rule the docs leave
  open); ``price_source`` is ``observed`` | ``ledger`` | ``bundled``
- ``price_components(...)``: the price keys and quantities a request is billed
  on (used to learn unit prices from actual charges)
- ``estimate_payload(body)`` for ``POST /api/generation/estimate``

Never calls a provider and never mutates its inputs.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from backend.byok import ledger, price_ledger
from backend.byok.providers.kie import KIE_USD_PER_CREDIT
from backend.byok.spec import PROVIDER_NAMES, ModeSpec, Reference

_KIE_UPSCALE_TIERS = (("2k", 2 ** 22), ("4k", 2 ** 24), ("8k", 2 ** 26))
_LESS = "-less-restriction"

PriceKey = tuple[str, str, str, str | None, str | None]  # provider, model, unit, resolution, variant


@dataclass(frozen=True)
class Rate:
    """One unit price, from whichever layer supplied it."""

    key: PriceKey
    rate: float
    layer: str  # observed | ledger | bundled
    source: str  # human-readable source for the tooltip
    as_of: str  # YYYY-MM-DD
    updated_at: str  # ISO timestamp of the layer (ledger generated_at, or observation time)

    @property
    def provider(self) -> str:
        return self.key[0]

    @property
    def unit(self) -> str:
        return self.key[2]


def _bundled_provider() -> tuple[price_ledger.Ledger, str]:
    from backend.byok import price_sources

    return price_sources.active_ledger()


def _observed_provider(key: PriceKey) -> Any:
    from backend.byok import learned_prices

    return learned_prices.lookup(key)


# Injection points (tests replace these).
ledger_provider: Callable[[], tuple[price_ledger.Ledger, str]] = _bundled_provider
observed_provider: Callable[[PriceKey], Any] = _observed_provider


def _source_text(led: price_ledger.Ledger, source_key: str) -> str:
    src = led.sources.get(source_key, {})
    parts = [src.get("url", source_key)]
    if src.get("local_copy"):
        parts.append(src["local_copy"])
    return "; ".join(parts)


class _Unpriceable(Exception):
    """No estimate. ``code`` is ``missing`` (no price for ``key``: the ledger's
    not-priceable notes say why, else ``no_published_price``) or a final
    reason code with its ``message``."""

    def __init__(self, code: str = "not_priceable_request", message: str = "",
                 key: PriceKey | None = None) -> None:
        super().__init__(code)
        self.code, self.message, self.key = code, message, key


@dataclass
class _Ctx:
    """Looks prices up through the layers and records what a request used."""

    use_observed: bool = True
    record_only: bool = False  # price_components: any key "exists" with rate 1
    used: list[tuple[Rate, float]] = field(default_factory=list)
    partial: bool = False
    _ledger: tuple[price_ledger.Ledger, str] | None = None

    def ledger(self) -> tuple[price_ledger.Ledger, str]:
        if self._ledger is None:
            self._ledger = ledger_provider()
        return self._ledger

    def find(self, key: PriceKey) -> Rate | None:
        """The price for ``key`` or None. Optional components (surcharges) use
        this, also in record-only mode, so they count only where a price exists."""
        if self.use_observed:
            obs = observed_provider(key)
            if obs is not None:
                return Rate(key, float(obs.amount), "observed",
                            f"Observed from your own {obs.samples} run{'s' if obs.samples != 1 else ''}",
                            obs.observed_at[:10], obs.observed_at)
        led, layer = self.ledger()
        entry = led.find(*key)
        if entry is None:
            return None
        return Rate(key, entry.amount, layer, _source_text(led, entry.source), entry.as_of, led.generated_at)

    def get(self, key: PriceKey) -> Rate:
        """The price of a required component. Record-only mode needs no price."""
        if self.record_only:
            return Rate(key, 1.0, "bundled", "", "", "")
        rate = self.find(key)
        if rate is None:
            raise _Unpriceable("missing", key=key)
        return rate

    def use(self, rate: Rate, quantity: float) -> None:
        self.used.append((rate, quantity))


def _num(value: float) -> str:
    return f"{value:g}" if value == int(value) or abs(value) >= 1 else f"{value:.4g}"


def _usd(value: float) -> str:
    return f"${value:.2f}" if round(value, 2) == value else f"${value:.4g}"


def _rate_text(rate: Rate) -> str:
    unit = "/s" if rate.unit.endswith("_second") else "/image"
    return f"{_num(rate.rate)} credits{unit}" if rate.provider == "kie" else f"{_usd(rate.rate)}{unit}"


def _unit(provider: str, kind: str) -> str:
    return f"{'credits' if provider == 'kie' else 'usd'}_per_{kind}"


class _Request:
    def __init__(self, spec: ModeSpec, params: dict[str, Any], refs: list[Reference]) -> None:
        self.spec, self.params, self.refs = spec, params, refs

    @property
    def resolution(self) -> str | None:
        res = self.params.get("resolution")
        return str(res).strip().lower() if res is not None else None

    def setting(self, key: str) -> Any:
        return (self.params.get("settings") or {}).get(key)

    def duration(self) -> float:
        d = self.params.get("duration")
        auto = self.spec.duration.auto_value if self.spec.duration else None
        if auto is not None and d == auto:
            raise _Unpriceable("auto_duration", MESSAGES["auto_duration"])  # billing follows the length generated
        if isinstance(d, bool) or not isinstance(d, (int, float)) or d <= 0:
            raise _Unpriceable()
        return float(d)

    def refs_of(self, kind: str) -> list[Reference]:
        return [r for r in self.refs if r.kind == kind and r.role == "reference"]

    def images(self) -> list[Reference]:
        return [r for r in self.refs if r.kind == "image"]

    def input_video_s(self) -> float | None:
        """Total reference-video seconds; None when any length is unknown."""
        total = 0.0
        for ref in self.refs_of("video"):
            d = ref.duration_s
            if isinstance(d, bool) or not isinstance(d, (int, float)) or not math.isfinite(d) or d <= 0:
                return None
            total += float(d)
        return total


def _result(ctx: _Ctx, amount: float, provider: str, basis: str) -> dict[str, Any]:
    rates = [r for r, _ in ctx.used]
    if provider == "kie":
        amount = round(amount, 4)
        unit, usd = "credits", round(amount * KIE_USD_PER_CREDIT, 6)
    else:
        amount = round(amount, 6)
        unit, usd = "usd", amount
    main = rates[0]
    return {"amount": amount, "unit": unit, "usd_equivalent": usd, "basis": basis,
            "source": "; ".join(dict.fromkeys(r.source for r in rates)),
            "as_of": min(r.as_of for r in rates), "confidence": "partial" if ctx.partial else "listed",
            "price_source": main.layer, "price_updated_at": main.updated_at}


# ------------------------------------------------------------------ per-second video


def _video(ctx: _Ctx, provider: str, model: str, req: _Request, rule: str, label: str = "",
           video_variant: str | None = "video_input") -> dict[str, Any]:
    """``rule``: ``sum`` (rate x (input + output); the rate is the
    ``video_variant`` entry, None for the base rate), ``kling`` (reduced
    rate x (output + max(input, output))), ``half`` (rate x output + rate/2 x
    input), ``none`` (no video-input billing rule documented)."""
    out = req.duration()
    res = req.resolution
    unit = _unit(provider, "second")
    videos = req.refs_of("video")
    at = f" at {res}" if res else ""
    tag = f" ({label})" if label else ""
    cents = model.startswith("kling:")  # "the task total is rounded to the nearest cent once"
    if not videos:
        rate = ctx.get((provider, model, unit, res, None))
        ctx.use(rate, out)
        amount = round(rate.rate * out, 2) if cents else rate.rate * out
        return _result(ctx, amount, provider, f"{_num(out)} s × {_rate_text(rate)}{at}{tag}")
    if rule == "none":  # a rate may be listed, but not how input seconds are billed
        raise _Unpriceable("missing", key=(provider, model, unit, res, video_variant), message="rule_unknown")
    inp = req.input_video_s()
    known = inp is not None
    inp_v = inp if known else 0.0
    ctx.partial = not known
    if rule == "half":
        rate = ctx.get((provider, model, unit, res, None))
        ctx.use(rate, out + inp_v / 2)
        amount = rate.rate * out + rate.rate / 2 * inp_v
        if known:
            basis = (f"{_num(out)} s × {_rate_text(rate)} + {_num(inp_v)} s input video × "
                     f"{_usd(rate.rate / 2)}/s{at}{tag}")
        else:
            basis = (f"at least {_num(out)} s × {_rate_text(rate)}{at}{tag}, plus half that rate per second "
                     "of input video (length unknown)")
        return _result(ctx, amount, provider, basis)
    rate = ctx.get((provider, model, unit, res, video_variant))
    if known:
        billable = out + (max(inp_v, out) if rule == "kling" else inp_v)
    else:
        billable = 2 * out if rule == "kling" else out
    ctx.use(rate, billable)
    amount = round(rate.rate * billable, 2) if cents else rate.rate * billable
    with_video = " with video input" if video_variant else ""
    if known:
        basis = (f"{_num(billable)} billable s ({_num(out)} s output + {_num(inp_v)} s input video) × "
                 f"{_rate_text(rate)}{at}{with_video}{tag}")
    else:
        basis = (f"at least {_num(billable)} billable s × {_rate_text(rate)}{at}{with_video}{tag} "
                 "(input-video length unknown)")
    return _result(ctx, amount, provider, basis)


# ------------------------------------------------------------------ per-image


def _image(ctx: _Ctx, provider: str, model: str, req: _Request, res: str | None, label: str = "") -> dict[str, Any]:
    rate = ctx.get((provider, model, _unit(provider, "image"), res, None))
    ctx.use(rate, 1)
    amount = rate.rate
    parts = [f"1 image × {_rate_text(rate)}" + (f" at {res.upper()}" if res else "")]
    images = len(req.images())
    for kind, count, text in (("extra_image", max(0, images - 1), "extra input image"),
                              ("reference_image", images, "input image")):
        if not count:
            continue
        surcharge = ctx.find((provider, model, _unit(provider, kind), None, None))
        if surcharge is None:
            continue
        ctx.use(surcharge, count)
        amount += surcharge.rate * count
        price = f"{_num(surcharge.rate)} credits" if provider == "kie" else _usd(surcharge.rate)
        parts.append(f"{count} {text}{'s' if count > 1 else ''} × {price}")
    basis = " + ".join(parts) + (f" ({label})" if label else "")
    return _result(ctx, amount, provider, basis)


def _output_pixels(req: _Request, factor: Any) -> int:
    images = req.images()
    size = _Unpriceable("not_priceable_request",
                        "The price depends on the input image size, which is not known yet.")
    if len(images) != 1:
        raise size
    w, h = images[0].width, images[0].height
    try:
        f = float(factor)
    except (TypeError, ValueError):
        raise size from None
    if not all(isinstance(v, int) and not isinstance(v, bool) and v > 0 for v in (w, h)) or f <= 0:
        raise size
    return int(w * f) * int(h * f)


def _kie_upscale(ctx: _Ctx, req: _Request) -> dict[str, Any]:
    pixels = _output_pixels(req, req.setting("upscale_factor"))
    for tier, limit in _KIE_UPSCALE_TIERS:
        if pixels <= limit:
            rate = ctx.get(("kie", "kie/image-upscale", "credits_per_image", tier, None))
            ctx.use(rate, 1)
            basis = f"1 image × {_rate_text(rate)} ({tier.upper()} tier, {pixels / 1e6:.2f} MP output)"
            return _result(ctx, rate.rate, "kie", basis)
    raise _Unpriceable("missing", key=("kie", "kie/image-upscale", "credits_per_image", "above-8k", None))


def _piapi_upscale(ctx: _Ctx, req: _Request) -> dict[str, Any]:
    pixels = _output_pixels(req, req.setting("scale"))
    rate = ctx.get(("piapi", "upscale", "usd_per_megapixel", None, None))
    mpx = pixels / 2 ** 20
    ctx.partial = True
    ctx.use(rate, max(1.0, mpx))
    basis = f"{mpx:.2f} MP output × {_usd(rate.rate)} per MP (minimum 1 MP; rounding not documented)"
    return _result(ctx, rate.rate * max(1.0, mpx), "piapi", basis)


# ------------------------------------------------------------------ dispatch


def _kie(ctx: _Ctx, req: _Request) -> dict[str, Any]:
    model = req.spec.ids.model
    if model.startswith("bytedance/"):
        return _video(ctx, "kie", model, req, "sum")
    if model.startswith("wan/"):  # input seconds are billed at the normal rate
        return _video(ctx, "kie", model, req, "sum", video_variant=None)
    if model in ("kling-4.0/reference-to-video", "kling-4.0/keyframe-to-video"):
        return _video(ctx, "kie", model, req, "kling")
    if model.startswith("kling-4.0/flash-"):
        return _video(ctx, "kie", model, req, "none")
    if model.startswith("seedream/5-pro-"):
        quality = req.setting("quality")
        res = {"basic": "1k", "high": "2k"}.get(str(quality))
        if res is None:
            raise _Unpriceable()
        return _image(ctx, "kie", model, req, res, f"quality {quality}")
    if model.startswith(("seedream/5-5-", "seedream/5-flash-", "minimax-h3/", "gpt-image-2-6/")):
        return _image(ctx, "kie", model, req, req.resolution or ("1k" if "economy" in model else None))
    if model == "kie/image-upscale":
        return _kie_upscale(ctx, req)
    raise _Unpriceable("missing", key=("kie", model, "credits_per_image", None, None))


def _piapi(ctx: _Ctx, req: _Request) -> dict[str, Any]:
    ids = req.spec.ids
    less = req.setting("less_restriction") is True or req.setting("real_people") is True
    if ids.model == "seedance":
        task = ids.task_type + (_LESS if less else "")
        return _video(ctx, "piapi", task, req, "half", task if less else "")
    if ids.model == "kling":
        return _video(ctx, "piapi", f"kling:{ids.version}", req, "kling")
    if ids.model == "seedream":
        task = ids.task_type + (_LESS if req.setting("less_restriction") is True else "")
        return _image(ctx, "piapi", task, req, req.resolution, task if task.endswith(_LESS) else "")
    if ids.model == "Qubico/image-toolkit" and ids.task_type == "upscale":
        return _piapi_upscale(ctx, req)
    raise _Unpriceable("missing", key=("piapi", ids.task_type or ids.model, "usd_per_image", None, None))


AFTER_RUN = "The actual charge will be shown after the run."
MESSAGES = {
    "auto_duration": "The length is set to auto, so the cost depends on how long the result is.",
    "input_video_billing_unknown": "{p} lists no rule for how input-video seconds are billed on this model.",
    "no_published_price": "{p} has not published a price for this model or setting.",
    "not_priceable_request": "This request cannot be priced yet. Check the model, mode and settings.",
}


def _run(ctx: _Ctx, provider: str, model_id: str, mode: str, params: Mapping[str, Any] | None,
         references: Sequence[Reference | Mapping[str, Any]] | None) -> dict[str, Any]:
    """The estimate, or raises _Unpriceable with the reason."""
    if params is None:
        params = {}
    if not isinstance(params, Mapping) or not isinstance(references or [], (list, tuple)):
        raise _Unpriceable()
    try:
        refs = [ledger.coerce_reference(r) for r in references or []]
        issues = ledger.validate_request(provider, model_id, mode, dict(params), refs)
        # The prompt never changes the price, so prompt issues do not block an estimate.
        if any(i.severity == "error" and not i.field.startswith("prompt") for i in issues):
            raise _Unpriceable()
        settings = params.get("settings") or {}
        spec = ledger.get_mode_spec(provider, model_id, mode, settings if isinstance(settings, Mapping) else {})
        if spec is None or not spec.supported or spec.ids is None or provider not in ("kie", "piapi"):
            raise _Unpriceable()
        req = _Request(spec, ledger.effective_params(spec, params), refs)
        return _kie(ctx, req) if provider == "kie" else _piapi(ctx, req)
    except (TypeError, ValueError, KeyError, AttributeError):
        raise _Unpriceable() from None


def _unavailable(ctx: _Ctx, provider: str, exc: _Unpriceable) -> dict[str, str]:
    name = PROVIDER_NAMES.get(provider, "The provider")
    code, message = exc.code, exc.message
    if code == "missing":
        _, model, _, _, variant = exc.key
        led, _ = ctx.ledger()
        note = led.note(provider, model, variant)
        if note is not None:
            code, message = note.code, note.message
        elif exc.message == "rule_unknown":
            code, message = "input_video_billing_unknown", MESSAGES["input_video_billing_unknown"]
        else:
            code, message = "no_published_price", MESSAGES["no_published_price"]
    message = (message or MESSAGES["not_priceable_request"]).format(p=name)
    return {"code": code, "message": f"{message.rstrip()} {AFTER_RUN}"}


def explain_cost(provider: str, model_id: str, mode: str, params: Mapping[str, Any] | None,
                 references: Sequence[Reference | Mapping[str, Any]] | None, *,
                 use_observed: bool = True, price_list: price_ledger.Ledger | None = None,
                 ) -> tuple[dict[str, Any] | None, dict[str, str] | None]:
    """``(estimate, None)`` or ``(None, {code, message})`` saying why there is
    no estimate. Codes: priced_per_token, input_video_billing_unknown,
    conflicting_sources, no_published_price (from the ledger's not-priceable
    notes or a missing row); auto_duration and not_priceable_request (from the
    request). The message ends with ``AFTER_RUN``. ``price_list`` prices
    against that ledger only (no learned prices), e.g. for the coverage docs."""
    ctx = _Ctx(use_observed=use_observed and price_list is None)
    if price_list is not None:
        ctx._ledger = (price_list, "bundled")
    try:
        return _run(ctx, provider, model_id, mode, params, references), None
    except _Unpriceable as exc:
        try:
            return None, _unavailable(ctx, provider, exc)
        except Exception:  # noqa: BLE001 - a broken ledger never breaks the route
            return None, {"code": "not_priceable_request",
                          "message": f"{MESSAGES['not_priceable_request']} {AFTER_RUN}"}


def estimate_cost(provider: str, model_id: str, mode: str, params: Mapping[str, Any] | None,
                  references: Sequence[Reference | Mapping[str, Any]] | None, *,
                  use_observed: bool = True) -> dict[str, Any] | None:
    """The estimated cost of one request, or None when it cannot be priced.
    ``use_observed=False`` prices from the ledger only (for price checks)."""
    return explain_cost(provider, model_id, mode, params, references, use_observed=use_observed)[0]


@dataclass(frozen=True)
class Components:
    """What a request is billed on: ``[(price key, quantity)]``; ``partial``
    when a quantity is only a lower bound (e.g. unknown input-video length)."""

    items: tuple[tuple[PriceKey, float], ...]
    partial: bool


def price_components(provider: str, model_id: str, mode: str, params: Mapping[str, Any] | None,
                     references: Sequence[Reference | Mapping[str, Any]] | None) -> Components | None:
    """The billing structure of a request, independent of any known price."""
    ctx = _Ctx(record_only=True)
    try:
        _run(ctx, provider, model_id, mode, params, references)
    except _Unpriceable:
        return None
    return Components(tuple((rate.key, qty) for rate, qty in ctx.used), ctx.partial)


def estimate_response(payload: Any) -> dict[str, Any]:
    """``POST /api/generation/estimate`` body (same shape as validate) ->
    ``{"estimate": {...}}`` or ``{"estimate": None, "unavailable": {code, message}}``."""
    generic = {"estimate": None, "unavailable": {
        "code": "not_priceable_request", "message": f"{MESSAGES['not_priceable_request']} {AFTER_RUN}"}}
    if not isinstance(payload, Mapping):
        return generic
    fields = [payload.get(k) for k in ("provider", "model", "mode")]
    if not all(isinstance(f, str) and f.strip() for f in fields):
        return generic
    provider, model, mode = (f.strip() for f in fields)
    refs = payload.get("references")
    if not isinstance(refs, list):
        refs = []
    # A local file (``local``) prices the same as its uploaded URL would.
    refs = [{**r, "url": r.get("url") or r.get("local")} if isinstance(r, Mapping) else r for r in refs]
    estimate, unavailable = explain_cost(provider, model, mode, payload.get("params"), refs)
    return {"estimate": estimate} if estimate is not None else {"estimate": None, "unavailable": unavailable}


def estimate_payload(payload: Any) -> dict[str, Any] | None:
    """The estimate alone (``None`` when there is none); see ``estimate_response``."""
    return estimate_response(payload)["estimate"]
