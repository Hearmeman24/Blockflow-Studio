"""Tool group: validate, estimate and run a generation (/api/generation/*).

`validate_generation` and `estimate_cost` never spend anything. `generate`
spends the user's provider credits, guarded by the estimate:

- No estimate (the price list does not cover the request) -> refused unless
  `allow_unknown_cost` is true.
- `max_cost_usd` set and the estimate is above it -> refused. The estimate's
  `usd_equivalent` is compared (or its amount when the unit is already USD);
  an estimate without a USD value counts as unknown.
"""

import uuid
from enum import StrEnum
from typing import Any

from blockflow_mcp import references as reference_input
from blockflow_mcp import tools_jobs
from blockflow_mcp.client import BackendError, ToolFailure, _is_secret_name, checked, failure_result, get_client, tool

SOURCE = "mcp"


class GenerateStage(StrEnum):
    """How far `generate` got: every result carries it as `stage`. Before
    `submit` nothing was sent; from the end of `submit` a job exists and every
    result carries its `job_id`."""

    VALIDATE = "validate"
    ESTIMATE = "estimate"
    SUBMIT = "submit"
    WAIT = "wait"


def _after_job_hint(job_id: str) -> str:
    return (f"Do not call generate again: job {job_id} exists and may already be spending credits. Use "
            f"job_status or wait_for_jobs with job_id {job_id} to follow it.")


_MAYBE_SUBMITTED_HINT = ("Do not call generate again yet: the job may have been created and may be spending "
                         "credits. Check list_jobs with source \"mcp\" (or the Artifacts page) first.")


def _maybe_submitted(exc: Exception) -> bool:
    """A submit failure after which the job may exist anyway: the request may
    have reached the backend (timeout, dropped connection, unreadable or 5xx
    reply, or a reply without a job). A JSON refusal (4xx) or a refused
    connection proves it does not."""
    if isinstance(exc, BackendError):
        return exc.may_have_arrived
    if isinstance(exc, ToolFailure):
        return (exc.result["error"].get("status") or 0) >= 500
    return True


def build_request(provider: str, model: str, mode: str, prompt: str | None, duration: int | None,
                  resolution: str | None, aspect_ratio: str | None, settings: dict[str, Any] | None,
                  refs: list[dict[str, Any]] | None) -> dict[str, Any]:
    """The backend request body (files referenced by path are copied in first)."""
    for name, value in (("provider", provider), ("model", model), ("mode", mode)):
        if not isinstance(value, str) or not value.strip():
            raise ToolFailure("missing_field", f"'{name}' is required.")
    if settings is not None and not isinstance(settings, dict):
        raise ToolFailure("invalid_settings", "'settings' must be an object of {key: value}.")
    secret = [k for k in (settings or {}) if isinstance(k, str) and _is_secret_name(k)]
    if secret:
        raise ToolFailure("key_in_request", "API keys are never accepted here; BlockFlow uses the keys saved in "
                                            "its Settings.", fields=secret)
    params: dict[str, Any] = {"settings": dict(settings or {})}
    if prompt:
        params["prompt"] = prompt
    if duration is not None:
        # Whole seconds go as integers: the backend does not price 5.0 like 5.
        is_whole = isinstance(duration, float) and duration.is_integer()
        params["duration"] = int(duration) if is_whole else duration
    if resolution:
        params["resolution"] = resolution
    if aspect_ratio:
        params["aspect_ratio"] = aspect_ratio
    return {"provider": provider.strip(), "model": model.strip(), "mode": mode.strip(), "params": params,
            "references": reference_input.normalize_references(get_client(), refs)}


def _issues(body: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    issues = body.get("issues") or []
    return ([i for i in issues if i.get("severity") == "error"], [i for i in issues if i.get("severity") != "error"])


def _validate(request: dict[str, Any]) -> dict[str, Any]:
    status, body = get_client().post("/api/generation/validate", json_body=request)
    if status >= 400 or not isinstance(body, dict) or "issues" not in body:
        raise ToolFailure("backend", f"Validation could not run (HTTP {status}).",
                          **({"issues": body.get("issues")} if isinstance(body, dict) and body.get("issues") else {}))
    errors, warnings = _issues(body)
    return {"valid": not errors, "errors": errors, "warnings": warnings}


def _estimate(request: dict[str, Any]) -> dict[str, Any]:
    status, body = get_client().post("/api/generation/estimate", json_body=request)
    body = checked(status, body, "Estimating the cost")
    return {"estimate": body.get("estimate"), "unavailable": body.get("unavailable")}


def estimate_usd(estimate: dict[str, Any] | None) -> float | None:
    if not estimate:
        return None
    usd = estimate.get("usd_equivalent")
    if usd is None and str(estimate.get("unit", "")).lower() == "usd":
        usd = estimate.get("amount")
    return float(usd) if isinstance(usd, (int, float)) and not isinstance(usd, bool) else None


@tool(read_only=True)
def validate_generation(provider: str, model: str, mode: str, prompt: str = "", duration: int | None = None,
                        resolution: str | None = None, aspect_ratio: str | None = None,
                        settings: dict[str, Any] | None = None,
                        references: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Check a request against the model's limits without running it or
    spending anything. Returns `valid`, `errors` and `warnings` (each with
    code, field and message). Same parameters as `generate`, including
    character references."""
    request = build_request(provider, model, mode, prompt, duration, resolution, aspect_ratio, settings, references)
    return {"ok": True, **_validate(request), "references": request["references"]}


@tool(read_only=True)
def estimate_cost(provider: str, model: str, mode: str, prompt: str = "", duration: int | None = None,
                  resolution: str | None = None, aspect_ratio: str | None = None,
                  settings: dict[str, Any] | None = None,
                  references: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Estimate what a generation would cost, from BlockFlow's price list. Never
    contacts the provider and never spends anything. Returns `estimate`
    (`amount`, `unit` such as credits or usd, `usd_equivalent`, `basis`,
    `confidence`, `source`) or `estimate: null` with `unavailable.message`
    explaining why there is none. Same parameters as `generate`, including
    character references."""
    request = build_request(provider, model, mode, prompt, duration, resolution, aspect_ratio, settings, references)
    result = _estimate(request)
    return {"ok": True, **result, "usd": estimate_usd(result["estimate"])}


@tool(read_only=False, spends=True)
def generate(provider: str, model: str, mode: str, prompt: str = "", duration: int | None = None,
             resolution: str | None = None, aspect_ratio: str | None = None, settings: dict[str, Any] | None = None,
             references: list[dict[str, Any]] | None = None, wait: bool = False, timeout_s: float = 600,
             max_cost_usd: float | None = None, allow_unknown_cost: bool = False,
             label: str | None = None) -> dict[str, Any]:
    """Run an image or video generation. THIS SPENDS THE USER'S PROVIDER
    CREDITS (Kie or PiAPI, billed by the provider). Check the cost with
    `estimate_cost` first and pass `max_cost_usd` to cap it.

    Steps: validate -> estimate -> submit. Refused, with nothing sent, when
    validation fails, when there is no cost estimate (unless
    `allow_unknown_cost` is true), or when the estimate in USD is above
    `max_cost_usd`.

    - provider / model / mode: from `list_models` / `get_model`.
    - prompt, duration (seconds), resolution, aspect_ratio, settings
      ({key: value}): as `get_model` lists them; omitted values use the defaults.
    - references: [{kind: image|video|audio, path | url | character,
      media?, role?}]. Give exactly one of:
      `path`, an absolute file on this computer (copied into the BlockFlow
      output folder) or an /outputs/... app path; `url`, a public http(s) URL;
      `character`, a saved character's name or id (see `list_characters`,
      `get_character`): {kind: "image", character: "Mia"} is its default face,
      {kind: "audio", character: "Mia"} its default audio, and
      {kind: "video"|"audio"|"image", character: "Mia", media: "<file label or
      media id>"} one specific file (video always needs `media`). Character
      files are used where they are; they go through the same validation and
      cost checks. `role`: reference (default), first_frame or last_frame
      (Image to Video). Audio (speech, music, ambience) is sent to the model as
      audio; say in the prompt what to do with it, mentioning it as `get_model`
      shows (e.g. `@sound_1` for Kling 4.0 on Kie). The old kind "voice" is read
      as audio and a `name` is ignored.
    - wait: true to wait (up to `timeout_s`, default 600) and return outputs,
      status, actual cost and error; false returns the job id at once (then use
      `job_status` / `wait_for_jobs`).
    - label: the run's name in the Artifacts page (default "MCP — <model> — <time>").

    Every result has `stage` (validate, estimate, submit or wait): how far it
    got. Once the job exists, every result, error or not, has its `job_id`.
    An error with a `job_id` means the job was created and may be spending
    credits: do NOT call generate again; follow `next` (job_status /
    wait_for_jobs with that job_id). A `submit` error that says the job may
    have been created (a timeout or lost connection) has no job_id: check
    list_jobs (source "mcp") or the Artifacts page before trying again.
    Errors without `next` were refused before anything was sent.

    The finished job is saved as a run in Artifacts (MCP filter)."""
    stage = GenerateStage.VALIDATE
    job_id: str | None = None
    try:
        if max_cost_usd is not None and (isinstance(max_cost_usd, bool)
                                         or not isinstance(max_cost_usd, (int, float)) or max_cost_usd < 0):
            raise ToolFailure("invalid_max_cost", "'max_cost_usd' must be a number of US dollars, 0 or more.")
        timeout = tools_jobs._timeout(timeout_s)
        request = build_request(provider, model, mode, prompt, duration, resolution, aspect_ratio, settings,
                                references)
        validation = _validate(request)
        if not validation["valid"]:
            raise ToolFailure("validation", "; ".join(str(e.get("message")) for e in validation["errors"]),
                              issues=validation["errors"] + validation["warnings"])
        stage = GenerateStage.ESTIMATE
        cost = _estimate(request)
        usd = estimate_usd(cost["estimate"])
        if usd is None and not allow_unknown_cost:
            reason = (cost.get("unavailable") or {}).get("message") or "The estimate has no US dollar value."
            raise ToolFailure("unknown_cost", f"Not submitted: there is no cost estimate for this request. {reason} "
                                              "Pass allow_unknown_cost=true to run it anyway.",
                              estimate=cost["estimate"], unavailable=cost.get("unavailable"))
        if max_cost_usd is not None and usd is not None and usd > max_cost_usd:
            raise ToolFailure("over_budget", f"Not submitted: the estimate is ${usd:.4f}, above max_cost_usd "
                                             f"${float(max_cost_usd):.4f}.", estimate=cost["estimate"], usd=usd)

        stage = GenerateStage.SUBMIT
        body: dict[str, Any] = {**request, "source": SOURCE, "client_request_id": f"mcp-{uuid.uuid4()}"}
        if label is not None and str(label).strip():
            body["label"] = str(label).strip()
        # Sent once and never retried: a second submit could be a second paid job.
        status, reply = get_client().post("/api/generation/submit", json_body=body)
        job = checked(status, reply, "Submitting the generation")["job"]
        job_id = job["job_id"]
        if not isinstance(job_id, str) or not job_id:
            raise ValueError("the backend's reply names no job id")
        result: dict[str, Any] = {"ok": True, "job_id": job_id, "stage": stage, "estimate": cost["estimate"],
                                  "estimate_usd": usd, "warnings": validation["warnings"]}
        if not wait:
            return {**result, "status": job.get("status"), "job": tools_jobs.summarize(job),
                    "next": "Use job_status or wait_for_jobs with this job_id."}
        stage = GenerateStage.WAIT
        jobs, pending = tools_jobs.wait_for([job_id], timeout)
        final = tools_jobs.summarize(jobs[job_id], roots=reference_input.output_folders(get_client()))
        result.update({"stage": stage, "status": final["status"], "job": final, "timed_out": bool(pending)})
        if pending:
            result["next"] = ("Still running; waiting stopped but the job continues. Use wait_for_jobs to keep "
                              "waiting, or cancel_job to stop following it.")
        return result
    except Exception as exc:  # noqa: BLE001 - every failure answers with its stage (and job id)
        failed = failure_result(exc)
        failed["stage"] = stage
        if job_id is not None:
            failed.update(job_id=job_id, next=_after_job_hint(job_id))
        elif stage == GenerateStage.SUBMIT and _maybe_submitted(exc):
            failed["error"]["message"] = (
                f"{failed['error']['message'].rstrip()} The submit request may have reached BlockFlow, so the job "
                "may have been created and may be spending credits: check list_jobs (source \"mcp\") or the "
                "Artifacts page before trying again.")
            failed["next"] = _MAYBE_SUBMITTED_HINT
        return failed


TOOLS = [validate_generation, estimate_cost, generate]
