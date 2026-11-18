"""Common provider interface and result types.

Adapters never hold an API key: it is passed to each network call and only
ever placed into the outgoing request headers.
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from backend.byok import ledger
from backend.byok.errors import ErrorInfo, ProviderError
from backend.byok.http import RetryPolicy, Transport, UrllibTransport
from backend.byok.spec import PROVIDER_NAMES, Issue, ModeSpec, Reference

JobStatus = Literal["QUEUED", "RUNNING", "COMPLETED", "FAILED"]


@dataclass(frozen=True)
class ProviderRequest:
    """A fully built provider request. Contains no secret."""

    provider: str
    model_id: str
    mode: str
    method: str
    url: str
    headers: tuple[tuple[str, str], ...]
    body: Mapping[str, Any]
    output_kind: Literal["video", "image"]
    warnings: tuple[Issue, ...] = ()

    @property
    def header_dict(self) -> dict[str, str]:
        return dict(self.headers)


@dataclass(frozen=True)
class Output:
    kind: str
    url: str


@dataclass(frozen=True)
class Cost:
    """What the provider reports it charged for one task.

    ``unit`` is the provider's own unit (Kie ``credits``, PiAPI ``points``);
    ``usd_equivalent`` is ``None`` when the conversion is not documented.
    """

    amount: float
    unit: str
    usd_equivalent: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return {"amount": self.amount, "unit": self.unit, "usd_equivalent": self.usd_equivalent}


@dataclass(frozen=True)
class PollResult:
    status: JobStatus
    remote_status: str
    progress: float | None = None
    outputs: tuple[Output, ...] = ()
    error: ErrorInfo | None = None
    request_echo: Mapping[str, Any] | None = None
    cost: Cost | None = None


BalanceStatus = Literal["ok", "unavailable"]


@dataclass(frozen=True)
class Balance:
    """A normalised account balance. ``status="unavailable"`` means the
    provider answered but the balance could not be read; ``amount`` is then
    ``None`` and ``message`` says why. Never carries the key."""

    provider: str
    status: BalanceStatus
    amount: float | None = None
    unit: str | None = None
    usd_equivalent: float | None = None
    raw_label: str | None = None
    message: str = ""


def finite_number(value: Any) -> float | None:
    """A finite float from a JSON number or numeric string; ``None`` otherwise
    (bools, NaN, infinities, objects and non-numeric strings are rejected)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        try:
            value = float(value.strip())
        except ValueError:
            return None
    if not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) else None


@dataclass(frozen=True)
class SubmitResult:
    """The provider accepted the task ``remote_job_id``. ``initial`` is its
    result when the provider answered synchronously; ``initial_error`` is set
    instead when that synchronous result could not be read (the task still
    exists and may bill, so the id must not be lost)."""

    remote_job_id: str
    initial: PollResult | None = None
    initial_error: ProviderError | None = None


@dataclass(frozen=True)
class KeyStatus:
    provider: str
    valid: bool
    message: str
    balance: float | None = None
    balance_unit: str | None = None


@dataclass
class Prepared:
    """Validated inputs for an adapter's body builder."""

    spec: ModeSpec
    params: dict[str, Any]
    refs: list[Reference]
    warnings: tuple[Issue, ...] = field(default_factory=tuple)

    def by_kind(self, kind: str) -> list[str]:
        return [r.url for r in self.refs if r.kind == kind and r.role == "reference"]

    def frame(self, role: str) -> str | None:
        for r in self.refs:
            if r.role == role:
                return r.url
        return None

    def setting(self, key: str) -> Any:
        return self.params["settings"].get(key)


class ProviderAdapter(ABC):
    name: str = ""
    poll_timeout_s: float = 30.0
    submit_timeout_s: float = 60.0
    upload_timeout_s: float = 180.0

    def __init__(self, transport: Transport | None = None, retry: RetryPolicy | None = None) -> None:
        self.transport = transport or UrllibTransport()
        self.retry = retry or RetryPolicy()

    @property
    def display_name(self) -> str:
        return PROVIDER_NAMES[self.name]

    def __repr__(self) -> str:
        return f"{type(self).__name__}()"

    # -- request construction (pure) ---------------------------------------

    def prepare(self, model_id: str, mode: str, params: Mapping[str, Any] | None,
                references: Sequence[Reference | Mapping[str, Any]] | None) -> Prepared:
        params = params or {}
        issues = ledger.validate_request(self.name, model_id, mode, params, references)
        errors = [i for i in issues if i.severity == "error"]
        if errors:
            lookup = {"unknown_provider", "unknown_model", "unknown_mode", "model_not_offered", "mode_unsupported"}
            kind = "unsupported" if errors[0].code in lookup else "validation"
            raise ProviderError(kind, " ".join(i.message for i in errors), provider=self.name, retryable=False,
                                provider_code=errors[0].code, issues=errors)
        spec = ledger.get_mode_spec(self.name, model_id, mode, params.get("settings") or {})
        refs = [ledger.coerce_reference(r) for r in references or []]
        return Prepared(spec, ledger.effective_params(spec, params), refs,
                        tuple(i for i in issues if i.severity == "warning"))

    @abstractmethod
    def build_request(self, model_id: str, mode: str, params: Mapping[str, Any] | None,
                      references: Sequence[Reference | Mapping[str, Any]] | None) -> ProviderRequest: ...

    # -- network -------------------------------------------------------------

    @abstractmethod
    def submit(self, request: ProviderRequest, api_key: str) -> SubmitResult: ...

    @abstractmethod
    def poll(self, remote_job_id: str, api_key: str, expected_kind: str | None = None) -> PollResult: ...

    @abstractmethod
    def upload_file(self, path: Path, api_key: str) -> str: ...

    @abstractmethod
    def validate_key(self, api_key: str) -> KeyStatus: ...

    #: Balance lookups are interactive (the credits panel): short timeout, no retry.
    balance_timeout_s: float = 8.0

    @abstractmethod
    def get_balance(self, api_key: str) -> Balance:
        """The account balance. Raises ProviderError (``auth`` for a rejected
        key, ``timeout``/``network``/... otherwise); returns an ``unavailable``
        Balance when the provider answered without a readable balance."""

    def _require_key(self, api_key: str | None) -> str:
        if not api_key or not str(api_key).strip():
            raise ProviderError("auth", f"No {self.display_name} API key is configured. Add one in Settings.",
                                provider=self.name, retryable=False)
        return str(api_key).strip()


_VIDEO_EXTS = (".mp4", ".mov", ".webm", ".mkv", ".m4v")
_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg", ".tiff", ".heic")


def output_kind_for(url: str, expected: str | None) -> str:
    path = url.split("?", 1)[0].lower()
    if path.endswith(_VIDEO_EXTS):
        return "video"
    if path.endswith(_IMAGE_EXTS):
        return "image"
    return expected or "unknown"


def unique_outputs(urls: Sequence[tuple[str, str]]) -> tuple[Output, ...]:
    seen: set[str] = set()
    out: list[Output] = []
    for kind, url in urls:
        if isinstance(url, str) and url.strip() and url not in seen:
            seen.add(url)
            out.append(Output(kind, url))
    return tuple(out)
