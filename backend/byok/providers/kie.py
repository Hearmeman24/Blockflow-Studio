"""Kie adapter: one createTask endpoint, the ``model`` string selects the mode.

Kie returns HTTP 200 with an error ``code`` in the body, so every response's
``code`` is checked. Results come back in a JSON-encoded ``resultJson``
string, and the echoed ``param`` (and its ``input``) are encoded twice.
"""

from __future__ import annotations

import json
import mimetypes
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any
from urllib.parse import quote

from backend.byok.catalog import KIE_KLING_AUDIO_NAME
from backend.byok.errors import ErrorInfo, ProviderError, classify, mentions_content_rejection, redact
from backend.byok.http import (
    NO_RETRY,
    USER_AGENT,
    json_body,
    lenient_json,
    multipart,
    parse_json,
    send,
    with_retry,
)
from backend.byok.ledger import get_model
from backend.byok.providers.base import (
    Balance,
    Cost,
    KeyStatus,
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

API_BASE = "https://api.kie.ai"
CREATE_URL = f"{API_BASE}/api/v1/jobs/createTask"
RECORD_URL = f"{API_BASE}/api/v1/jobs/recordInfo"
CREDIT_URL = f"{API_BASE}/api/v1/chat/credit"
UPLOAD_URL = "https://kieai.redpandaai.co/api/file-stream-upload"
UPLOAD_PATH = "blockflow-byok"

# One Kie credit is $0.005. Every price line on the saved kie.ai model pages
# agrees, e.g. "19 credits ($0.095) per second" (seedance-2-0.txt) and
# "160 credits ($0.80)" (wan3.0-video.txt), snapshot 2026-11-15.
KIE_USD_PER_CREDIT = 0.005


def credits_cost(value: Any) -> Cost | None:
    """``recordInfo.data.creditsConsumed`` as a Cost; None when absent or garbage."""
    amount = finite_number(value)
    if amount is None or amount < 0:
        return None
    return Cost(amount, "credits", round(amount * KIE_USD_PER_CREDIT, 6))

# Body codes whose meaning differs from the generic HTTP mapping.
KIE_CODE_OVERRIDES: dict[int, tuple[str, bool]] = {
    433: ("provider_failure", False),
    455: ("provider_failure", True),  # maintenance
    501: ("provider_failure", False),  # generation failed
    505: ("unsupported", False),  # feature disabled
}

STATE_MAP = {"waiting": "QUEUED", "queuing": "QUEUED", "generating": "RUNNING", "success": "COMPLETED",
             "fail": "FAILED"}

_SEEDANCE_FIELDS = {"image": "reference_image_urls", "video": "reference_video_urls",
                    "audio": "reference_audio_urls"}

# model prefix -> (reference field per kind, resolution field)
FAMILIES: tuple[tuple[str, Mapping[str, str], str], ...] = (
    ("bytedance/", _SEEDANCE_FIELDS, "resolution"),
    ("wan/", _SEEDANCE_FIELDS, "resolution"),
    ("kling-4.0/", {"image": "image_urls", "video": "video_urls"}, "resolution"),
    ("seedream/", {"image": "image_urls"}, "size"),
    ("gpt-image-2-6/", {"image": "input_urls"}, "resolution"),
    ("minimax-h3/", {"image": "image_urls"}, "resolution"),
    ("kie/image-upscale", {}, "resolution"),
)

# Settings that are not sent as same-named input fields.
_NOT_SENT = frozenset({"tier"})


def _family(model: str) -> tuple[Mapping[str, str], str]:
    for prefix, fields, res_field in FAMILIES:
        if model.startswith(prefix):
            return fields, res_field
    raise ProviderError("unsupported", f"Kie model '{model}' has no request mapping.", provider="kie",
                        retryable=False)


def _build_input(prep: Prepared) -> dict[str, Any]:
    model = prep.spec.ids.model
    ref_fields, res_field = _family(model)
    p = prep.params
    body: dict[str, Any] = {}
    if p["prompt"] is not None:
        body["prompt"] = p["prompt"]
    if p["duration"] is not None:
        body["duration"] = p["duration"]
    if p["resolution"] is not None:
        body[res_field] = p["resolution"]
    if p["aspect_ratio"] is not None:
        body["aspect_ratio"] = p["aspect_ratio"]
    has_video = bool(prep.by_kind("video"))
    for key, value in p["settings"].items():
        if value is None or key in _NOT_SENT:
            continue
        if key == "keep_original_sound" and not has_video:
            continue  # only takes effect with reference videos
        body[key] = value
    first, last = prep.frame("first_frame"), prep.frame("last_frame")
    if first:
        body["first_frame_url"] = first
    if last:
        body["last_frame_url"] = last
    for kind, field_name in ref_fields.items():
        urls = prep.by_kind(kind)
        if urls:
            body[field_name] = urls
    if model.startswith("kling-4.0/"):
        # Kling has no audio field: each audio reference is one entry of the
        # API's `voices` list, named as the prompt mentions it (catalog.py).
        voices = [{"name": KIE_KLING_AUDIO_NAME.format(n=n), "audio_url": url}
                  for n, url in enumerate(prep.by_kind("audio"), start=1)]
        if voices:
            body["voices"] = voices
    if model == "kie/image-upscale":
        body["image_url"] = prep.by_kind("image")[0]
    if model == "bytedance/seedance-2-5" and prep.spec.mode == "omni_reference_to_video":
        body["omni_reference_task_type"] = "reference"
    return body


def _loads_deep(value: Any, depth: int = 3) -> Any:
    """Decode a JSON value that may be encoded as a string up to ``depth`` times."""
    for _ in range(depth):
        if not isinstance(value, str):
            break
        if not value.strip():
            return None
        value = json.loads(value)
    return value


class KieAdapter(ProviderAdapter):
    name = "kie"

    # -- pure ------------------------------------------------------------------

    def build_request(self, model_id: str, mode: str, params: Mapping[str, Any] | None,
                      references: Sequence[Reference | Mapping[str, Any]] | None) -> ProviderRequest:
        prep = self.prepare(model_id, mode, params, references)
        return ProviderRequest(
            provider=self.name,
            model_id=model_id,
            mode=mode,
            method="POST",
            url=CREATE_URL,
            headers=(("Content-Type", "application/json"), ("Accept", "application/json"),
                     ("User-Agent", USER_AGENT)),
            body={"model": prep.spec.ids.model, "input": _build_input(prep)},
            output_kind=get_model(model_id).output,
            warnings=prep.warnings,
        )

    # -- helpers -----------------------------------------------------------------

    def _headers(self, api_key: str, extra: Mapping[str, str] | None = None) -> dict[str, str]:
        headers = {"Accept": "application/json", "User-Agent": USER_AGENT, "Authorization": f"Bearer {api_key}"}
        headers.update(extra or {})
        return headers

    def _call(self, method: str, url: str, api_key: str, body: bytes | None = None,
              content_type: str | None = None, timeout: float = 30.0) -> Any:
        headers = self._headers(api_key, {"Content-Type": content_type} if content_type else None)
        resp = send(self.transport, method, url, headers, body, timeout=timeout, provider=self.name,
                    api_key=api_key)
        if resp.status != 200:
            data = lenient_json(resp)
            detail = redact(data.get("msg") if isinstance(data, dict) else "", api_key)
            raise classify(self.name, self.display_name, resp.status, detail, api_key=api_key,
                           http_status=resp.status, overrides=KIE_CODE_OVERRIDES)
        data = parse_json(resp, self.name, self.display_name, api_key)
        detail = redact(data.get("msg") if isinstance(data, dict) else "", api_key)
        if not isinstance(data, dict):
            raise ProviderError("malformed_response", "Kie returned an unexpected response.", provider=self.name,
                                retryable=False, http_status=resp.status)
        code = data.get("code")
        if code != 200:
            if not isinstance(code, int):
                raise ProviderError("malformed_response", "Kie returned a response without a status code.",
                                    provider=self.name, retryable=False, http_status=resp.status)
            raise classify(self.name, self.display_name, code, detail, api_key=api_key, provider_code=code,
                           http_status=resp.status, overrides=KIE_CODE_OVERRIDES)
        return data

    # -- network -------------------------------------------------------------------

    def submit(self, request: ProviderRequest, api_key: str) -> SubmitResult:
        key = self._require_key(api_key)
        # Never retried: a duplicate createTask is a second paid job.
        data = with_retry(lambda: self._call("POST", request.url, key, json_body(request.body),
                                             "application/json", self.submit_timeout_s), NO_RETRY)
        task_id = (data.get("data") or {}).get("taskId") if isinstance(data.get("data"), dict) else None
        if not isinstance(task_id, str) or not task_id:
            raise ProviderError("malformed_response", "Kie accepted the request but returned no task id.",
                                provider=self.name, retryable=False)
        return SubmitResult(task_id)

    def poll(self, remote_job_id: str, api_key: str, expected_kind: str | None = None) -> PollResult:
        key = self._require_key(api_key)
        url = f"{RECORD_URL}?taskId={quote(str(remote_job_id), safe='')}"
        data = with_retry(lambda: self._call("GET", url, key, timeout=self.poll_timeout_s), self.retry)
        task = data.get("data")
        if not isinstance(task, dict):
            raise ProviderError("malformed_response", "Kie returned a task record without data.",
                                provider=self.name, retryable=True)
        state = str(task.get("state") or "")
        status = STATE_MAP.get(state.lower())
        if status is None:
            raise ProviderError("malformed_response", f"Kie returned an unknown task state '{state[:40]}'.",
                                provider=self.name, retryable=True)
        progress = task.get("progress")
        progress = float(progress) if isinstance(progress, (int, float)) and not isinstance(progress, bool) else None
        echo = self._decode_param(task.get("param"))
        if status == "FAILED":
            message = redact(task.get("failMsg") or "", key).strip()
            kind = "content_rejected" if message and mentions_content_rejection(message) else "provider_failure"
            text = ("Kie rejected the content of this request." if kind == "content_rejected"
                    else "Kie could not generate this result.")
            info = ErrorInfo(kind, f"{text} ({message[:300]})" if message else text, False, None,
                             str(task.get("failCode") or "") or None, self.name)
            return PollResult(status, state, progress, (), info, echo, credits_cost(task.get("creditsConsumed")))
        outputs = ()
        if status == "COMPLETED":
            outputs = self._outputs(task, expected_kind)
            if not outputs:
                raise ProviderError("malformed_response", "Kie reported success but returned no result URLs.",
                                    provider=self.name, retryable=False)
        cost = credits_cost(task.get("creditsConsumed")) if status == "COMPLETED" else None
        return PollResult(status, state, progress, outputs, None, echo, cost)

    def _outputs(self, task: Mapping[str, Any], expected_kind: str | None):
        try:
            result = _loads_deep(task.get("resultJson"))
        except (json.JSONDecodeError, TypeError):
            raise ProviderError("malformed_response", "Kie returned a result that is not valid JSON.",
                                provider=self.name, retryable=False) from None
        if not isinstance(result, dict) and isinstance(task.get("response"), dict):
            result = task["response"]
        urls = result.get("resultUrls") if isinstance(result, dict) else None
        if isinstance(urls, str):
            urls = [urls]
        if not isinstance(urls, list):
            return ()
        return unique_outputs([(output_kind_for(u, expected_kind), u) for u in urls if isinstance(u, str)])

    @staticmethod
    def _decode_param(param: Any) -> dict[str, Any] | None:
        try:
            decoded = _loads_deep(param)
            if isinstance(decoded, dict) and isinstance(decoded.get("input"), str):
                decoded = {**decoded, "input": _loads_deep(decoded["input"])}
        except (json.JSONDecodeError, TypeError):
            return None
        return decoded if isinstance(decoded, dict) else None

    def upload_file(self, path: Path, api_key: str) -> str:
        key = self._require_key(api_key)
        path = Path(path)
        if not path.is_file():
            raise ProviderError("validation", f"File not found: {path.name}", provider=self.name, retryable=False)
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        body, ctype = multipart({"uploadPath": UPLOAD_PATH, "fileName": path.name}, "file", path.name,
                                path.read_bytes(), content_type)
        data = self._call("POST", UPLOAD_URL, key, body, ctype, self.upload_timeout_s)
        url = (data.get("data") or {}).get("downloadUrl") if isinstance(data.get("data"), dict) else None
        if not isinstance(url, str) or not url.startswith("http"):
            raise ProviderError("malformed_response", "Kie upload returned no download URL.", provider=self.name,
                                retryable=False)
        return url

    def validate_key(self, api_key: str) -> KeyStatus:
        key = self._require_key(api_key)
        try:
            data = with_retry(lambda: self._call("GET", CREDIT_URL, key, timeout=self.poll_timeout_s), self.retry)
        except ProviderError as err:
            if err.kind == "auth":
                return KeyStatus(self.name, False, "Kie rejected this API key.")
            raise
        balance = data.get("data")
        balance = float(balance) if isinstance(balance, (int, float)) and not isinstance(balance, bool) else None
        return KeyStatus(self.name, True, "Kie API key is valid.", balance, "credits")

    def get_balance(self, api_key: str) -> Balance:
        key = self._require_key(api_key)
        data = self._call("GET", CREDIT_URL, key, timeout=self.balance_timeout_s)
        amount = finite_number(data.get("data"))
        if amount is None:
            return Balance(self.name, "unavailable", message="Kie answered without a readable credit balance.")
        return Balance(self.name, "ok", amount, "credits", round(amount * KIE_USD_PER_CREDIT, 6), "credits")
