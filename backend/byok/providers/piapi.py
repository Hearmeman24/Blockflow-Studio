"""PiAPI adapter: unified task API (``model`` + ``task_type`` + ``input``).

Kling 4.0 / 4.0-flash reject unknown fields (error.code 10003) and require
``config.service_mode: "public"``, so only documented fields are sent.
"""

from __future__ import annotations

import base64
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any
from urllib.parse import quote

from backend.byok.errors import (
    ErrorInfo,
    ProviderError,
    classify,
    mentions_content_rejection,
    mentions_insufficient_credits,
    redact,
)
from backend.byok.http import NO_RETRY, USER_AGENT, json_body, lenient_json, parse_json, send, with_retry
from backend.byok.ledger import get_model
from backend.byok.providers.base import (
    Balance,
    Cost,
    KeyStatus,
    Output,
    PollResult,
    Prepared,
    ProviderAdapter,
    ProviderRequest,
    SubmitResult,
    finite_number,
    output_kind_for,
    unique_outputs,
)
from backend.byok.spec import Reference

API_BASE = "https://api.piapi.ai"
TASK_URL = f"{API_BASE}/api/v1/task"
ACCOUNT_URL = f"{API_BASE}/account/info"
UPLOAD_URL = "https://upload.theapi.app/api/ephemeral_resource"
UPLOAD_MAX_BYTES = 10_000_000
UPLOAD_EXTS = frozenset({"jpg", "jpeg", "png", "webp", "mp4", "wav", "mp3"})
LESS_RESTRICTION_SUFFIX = "-less-restriction"

# PiAPI reports a task's charge as ``meta.usage = {type, frozen, consume}`` in
# "points". No page states the conversion, but every worked example in the
# saved docs matches 10,000,000 points = $1: nano-banana-2 at $0.06/image
# consumes 600000 and nano-banana-2.1 at $0.03 consumes 300000
# (gemini-api_nano-banana-2.md); hailuo 6 s 768p at $0.23 consumes 2300000
# (hailuo-api_generate-video.md). Only the usage types seen in those examples
# are converted; any other type keeps its raw points with no USD value.
POINTS_PER_USD = 10_000_000
_CONVERTIBLE_USAGE = frozenset({"point", "llm"})


def usage_cost(task: Mapping[str, Any], status: str) -> Cost | None:
    """``data.meta.usage`` as a Cost, or None when it is absent, unreadable or
    still frozen (not settled)."""
    meta = task.get("meta")
    usage = meta.get("usage") if isinstance(meta, Mapping) else None
    if not isinstance(usage, Mapping):
        return None
    consume, frozen = finite_number(usage.get("consume")), finite_number(usage.get("frozen"))
    if consume is None or consume < 0:
        return None
    if consume == 0 and (frozen is None or frozen > 0):
        return None  # nothing settled yet: the reservation is still frozen
    if consume == 0 and status != "FAILED":
        return None  # a completed task that reports nothing consumed: not trustworthy
    kind = str(usage.get("type") or "").strip().lower()
    usd = round(consume / POINTS_PER_USD, 6) if kind in _CONVERTIBLE_USAGE else None
    return Cost(consume, "points", usd)


PIAPI_CODE_OVERRIDES: dict[int, tuple[str, bool]] = {10003: ("validation", False)}

STATUS_MAP = {
    "pending": "QUEUED", "staged": "QUEUED", "starting": "QUEUED",
    "processing": "RUNNING", "retry": "RUNNING", "running": "RUNNING",
    "completed": "COMPLETED", "success": "COMPLETED", "succeeded": "COMPLETED",
    "failed": "FAILED", "fail": "FAILED", "error": "FAILED",
}

_SEEDANCE_MODES = {"text_to_video": "text_to_video", "image_to_video": "first_last_frames",
                   "omni_reference_to_video": "omni_reference"}


def _seedance(prep: Prepared) -> tuple[str, dict[str, Any], dict[str, Any] | None]:
    p, spec = prep.params, prep.spec
    real_people = prep.setting("real_people") is True
    less = real_people or prep.setting("less_restriction") is True
    task_type = spec.ids.task_type + (LESS_RESTRICTION_SUFFIX if less else "")
    body: dict[str, Any] = {"mode": _SEEDANCE_MODES[spec.mode]}
    if p["prompt"] is not None:
        body["prompt"] = p["prompt"]
    for key in ("duration", "aspect_ratio", "resolution"):
        if p[key] is not None:
            body[key] = p[key]
    if spec.setting("audio") is not None:
        body["audio"] = prep.setting("audio")
    if spec.mode == "image_to_video":
        body["image_urls"] = [u for u in (prep.frame("first_frame"), prep.frame("last_frame")) if u]
    for kind in ("image", "video", "audio"):
        urls = prep.by_kind(kind)
        if urls:
            body[f"{kind}_urls"] = urls
    if spec.ids.task_type == "seedance-2.5" and spec.mode == "omni_reference_to_video":
        body["omni_reference_task_type"] = "reference"
    if less:
        # Accepted only on -less-restriction task types; always explicit there.
        body["auto_upload_assets"] = real_people
    return task_type, body, None


def _kling(prep: Prepared) -> tuple[str, dict[str, Any], dict[str, Any] | None]:
    p, spec = prep.params, prep.spec
    body: dict[str, Any] = {"prompt": p["prompt"], "version": spec.ids.version, "duration": p["duration"]}
    if spec.ids.task_type == "video_generation":
        body["mode"] = "pro" if p["resolution"] == "1080p" else "std"
        if p["aspect_ratio"] is not None:
            body["aspect_ratio"] = p["aspect_ratio"]
        first, last = prep.frame("first_frame"), prep.frame("last_frame")
        if first:
            body["image_url"] = first
        if last:
            body["image_tail_url"] = last
    else:
        body["resolution"] = p["resolution"]
        if p["aspect_ratio"] is not None:
            body["aspect_ratio"] = p["aspect_ratio"]
        body["enable_audio"] = prep.setting("enable_audio")
        for kind, field_name in (("image", "images"), ("video", "videos"), ("audio", "audio_urls")):
            urls = prep.by_kind(kind)
            if urls:
                body[field_name] = urls
        if prep.by_kind("video"):
            body["keep_original_audio"] = prep.setting("keep_original_audio")
    return spec.ids.task_type, body, {"service_mode": "public"}


def _seedream(prep: Prepared) -> tuple[str, dict[str, Any], dict[str, Any] | None]:
    p, spec = prep.params, prep.spec
    less = prep.setting("less_restriction") is True
    body: dict[str, Any] = {"prompt": p["prompt"], "aspect_ratio": p["aspect_ratio"], "size": p["resolution"],
                            "output_format": prep.setting("output_format")}
    images = prep.by_kind("image")
    if images:
        body["image_urls"] = images
    return spec.ids.task_type + (LESS_RESTRICTION_SUFFIX if less else ""), body, None


def _upscale(prep: Prepared) -> tuple[str, dict[str, Any], dict[str, Any] | None]:
    body = {"image": prep.by_kind("image")[0], "scale": prep.setting("scale"),
            "face_enhance": prep.setting("face_enhance")}
    return prep.spec.ids.task_type, body, None


BUILDERS = {"seedance": _seedance, "kling": _kling, "seedream": _seedream, "Qubico/image-toolkit": _upscale}


def _error_detail(payload: Any) -> tuple[str, Any]:
    """(message, code) from any PiAPI error shape."""
    if not isinstance(payload, dict):
        return "", None
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    for source in (data.get("error"), payload.get("error")):
        if isinstance(source, dict) and (source.get("message") or source.get("raw_message")):
            return str(source.get("message") or source.get("raw_message")), source.get("code")
    message = payload.get("message") or payload.get("msg") or ""
    return str(message) if message not in ("success", None) else "", payload.get("code")


def extract_outputs(output: Any, expected_kind: str | None) -> tuple[Output, ...]:
    """Normalise every documented PiAPI output shape into ``[Output(kind, url)]``."""
    if not isinstance(output, dict):
        return ()
    found: list[tuple[str, str]] = []
    for key in ("video", "video_url"):
        if isinstance(output.get(key), str):
            found.append(("video", output[key]))
    if isinstance(output.get("image_url"), str):
        found.append(("image", output["image_url"]))
    for key in ("image_urls", "images"):
        items = output.get(key)
        if isinstance(items, list):
            for item in items:
                url = item.get("url") if isinstance(item, dict) else item
                if isinstance(url, str):
                    found.append((output_kind_for(url, "image") if key == "images" else "image", url))
    if expected_kind:
        found = [(k if k != "unknown" else expected_kind, u) for k, u in found]
    return unique_outputs(found)


class PiAPIAdapter(ProviderAdapter):
    name = "piapi"

    def build_request(self, model_id: str, mode: str, params: Mapping[str, Any] | None,
                      references: Sequence[Reference | Mapping[str, Any]] | None) -> ProviderRequest:
        prep = self.prepare(model_id, mode, params, references)
        builder = BUILDERS.get(prep.spec.ids.model)
        if builder is None:
            raise ProviderError("unsupported", f"PiAPI model '{prep.spec.ids.model}' has no request mapping.",
                                provider=self.name, retryable=False)
        task_type, input_body, config = builder(prep)
        body: dict[str, Any] = {"model": prep.spec.ids.model, "task_type": task_type, "input": input_body}
        if config:
            body["config"] = config
        return ProviderRequest(
            provider=self.name, model_id=model_id, mode=mode, method="POST", url=TASK_URL,
            headers=(("Content-Type", "application/json"), ("Accept", "application/json"),
                     ("User-Agent", USER_AGENT)),
            body=body, output_kind=get_model(model_id).output, warnings=prep.warnings,
        )

    # -- helpers -----------------------------------------------------------------

    def _call(self, method: str, url: str, api_key: str, payload: Mapping[str, Any] | None = None,
              timeout: float = 30.0) -> dict[str, Any]:
        headers = {"x-api-key": api_key, "Accept": "application/json", "User-Agent": USER_AGENT}
        body = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            body = json_body(payload)
        resp = send(self.transport, method, url, headers, body, timeout=timeout, provider=self.name,
                    api_key=api_key)
        if resp.status != 200:
            message, code = _error_detail(lenient_json(resp))
            raise classify(self.name, self.display_name, resp.status, message, api_key=api_key,
                           provider_code=code if code not in (None, 0) else resp.status, http_status=resp.status)
        data = parse_json(resp, self.name, self.display_name, api_key)
        if not isinstance(data, dict):
            raise ProviderError("malformed_response", "PiAPI returned an unexpected response.", provider=self.name,
                                retryable=False, http_status=resp.status)
        code = data.get("code")
        if code is not None and code != 200:
            message, _ = _error_detail(data)
            status = code if isinstance(code, int) else 500
            raise classify(self.name, self.display_name, status, message, api_key=api_key, provider_code=code,
                           http_status=resp.status, overrides=PIAPI_CODE_OVERRIDES)
        return data

    def _poll_result(self, task: Mapping[str, Any], api_key: str, expected_kind: str | None) -> PollResult:
        raw = str(task.get("status") or "")
        status = STATUS_MAP.get(raw.strip().lower())
        if status is None:
            raise ProviderError("malformed_response", f"PiAPI returned an unknown task status '{raw[:40]}'.",
                                provider=self.name, retryable=True)
        if status == "FAILED":
            message, code = _error_detail({"data": task})
            message = redact(message, api_key).strip()
            if message and mentions_content_rejection(message):
                kind, text = "content_rejected", "PiAPI rejected the content of this request."
            elif message and mentions_insufficient_credits(message):
                kind, text = "insufficient_credits", "Your PiAPI account does not have enough credits."
            else:
                kind, text = "provider_failure", "PiAPI could not generate this result."
            info = ErrorInfo(kind, f"{text} ({message[:300]})" if message else text, False, None,
                             None if code in (None, 0) else str(code), self.name)
            return PollResult(status, raw, None, (), info, cost=usage_cost(task, status))
        outputs = ()
        if status == "COMPLETED":
            outputs = extract_outputs(task.get("output"), expected_kind)
            if not outputs:
                raise ProviderError("malformed_response", "PiAPI reported success but returned no output URL.",
                                    provider=self.name, retryable=False)
        cost = usage_cost(task, status) if status == "COMPLETED" else None
        return PollResult(status, raw, None, outputs, cost=cost)

    # -- network -------------------------------------------------------------------

    def submit(self, request: ProviderRequest, api_key: str) -> SubmitResult:
        key = self._require_key(api_key)
        # Never retried: a duplicate create is a second paid job.
        data = with_retry(lambda: self._call("POST", request.url, key, request.body, self.submit_timeout_s),
                          NO_RETRY)
        task = data.get("data")
        task_id = task.get("task_id") if isinstance(task, dict) else None
        if not isinstance(task_id, str) or not task_id:
            raise ProviderError("malformed_response", "PiAPI accepted the request but returned no task id.",
                                provider=self.name, retryable=False)
        initial = None
        if STATUS_MAP.get(str(task.get("status") or "").strip().lower()) in ("COMPLETED", "FAILED"):
            # Seedream is documented as synchronous: the result may already be here.
            initial = self._poll_result(task, key, request.output_kind)
        return SubmitResult(task_id, initial)

    def poll(self, remote_job_id: str, api_key: str, expected_kind: str | None = None) -> PollResult:
        key = self._require_key(api_key)
        url = f"{TASK_URL}/{quote(str(remote_job_id), safe='')}"
        data = with_retry(lambda: self._call("GET", url, key, timeout=self.poll_timeout_s), self.retry)
        task = data.get("data")
        if not isinstance(task, dict):
            raise ProviderError("malformed_response", "PiAPI returned a task without data.", provider=self.name,
                                retryable=True)
        return self._poll_result(task, key, expected_kind)

    def upload_file(self, path: Path, api_key: str) -> str:
        key = self._require_key(api_key)
        path = Path(path)
        if not path.is_file():
            raise ProviderError("validation", f"File not found: {path.name}", provider=self.name, retryable=False)
        ext = path.suffix.lower().lstrip(".")
        if ext not in UPLOAD_EXTS:
            raise ProviderError("unsupported", f"PiAPI upload does not accept .{ext} files.", provider=self.name,
                                retryable=False, provider_code="unsupported_file_type")
        size = path.stat().st_size
        if size > UPLOAD_MAX_BYTES:
            raise ProviderError("unsupported", "PiAPI upload accepts files up to 10 MB.", provider=self.name,
                                retryable=False, provider_code="file_too_large")
        payload = {"file_name": path.name[-128:], "file_data": base64.b64encode(path.read_bytes()).decode("ascii")}
        try:
            data = self._call("POST", UPLOAD_URL, key, payload, self.upload_timeout_s)
        except ProviderError as err:
            if err.http_status == 403:
                raise ProviderError("unsupported", "PiAPI file upload needs a Creator plan or higher.",
                                    provider=self.name, retryable=False, http_status=403,
                                    provider_code="plan_required") from None
            raise
        url = (data.get("data") or {}).get("url") if isinstance(data.get("data"), dict) else None
        if not isinstance(url, str) or not url.startswith("http"):
            raise ProviderError("malformed_response", "PiAPI upload returned no URL.", provider=self.name,
                                retryable=False)
        return url

    def validate_key(self, api_key: str) -> KeyStatus:
        key = self._require_key(api_key)
        try:
            data = with_retry(lambda: self._call("GET", ACCOUNT_URL, key, timeout=self.poll_timeout_s), self.retry)
        except ProviderError as err:
            if err.kind == "auth":
                return KeyStatus(self.name, False, "PiAPI rejected this API key.")
            raise
        info = data.get("data") if isinstance(data.get("data"), dict) else data
        balance, unit = None, None
        for field_name, field_unit in (("equivalent_in_usd", "usd"), ("credits", "credits")):
            value = info.get(field_name)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                balance, unit = float(value), field_unit
                break
        return KeyStatus(self.name, True, "PiAPI API key is valid.", balance, unit)

    def get_balance(self, api_key: str) -> Balance:
        """``GET /account/info``. Its response schema is undocumented apart from
        ``equivalent_in_usd`` ("the actually valid balance value in US dollar"),
        so only that field (or, failing it, a numeric ``credits``) is read."""
        key = self._require_key(api_key)
        data = self._call("GET", ACCOUNT_URL, key, timeout=self.balance_timeout_s)
        info = data.get("data") if isinstance(data.get("data"), dict) else data
        usd = finite_number(info.get("equivalent_in_usd"))
        if usd is not None:
            return Balance(self.name, "ok", usd, "usd", usd, "USD")
        credits = finite_number(info.get("credits"))
        if credits is not None:
            return Balance(self.name, "ok", credits, "credits", None, "credits")
        return Balance(self.name, "unavailable",
                       message="PiAPI answered without a readable balance (no equivalent_in_usd or credits field).")
