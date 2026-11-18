# AGENTS.md: BlockFlow Studio

**What this is.** BlockFlow Studio is a local app for building left-to-right
pipelines of blocks that generate images and videos with the user's own Kie and
PiAPI API keys. A FastAPI backend and a Next.js frontend run on the user's
computer, and an MCP server lets an AI agent generate through the same app.

This file is the source of truth for coding agents. It is beta software: expect
bugs, and report them (see [Beta status](#beta-status)).

## Quick facts

| | |
|---|---|
| Languages | Python 3.12+, TypeScript 5 (React/TSX) |
| Backend | FastAPI `>=0.115` (locked 0.136.1), uvicorn `>=0.30` (locked 0.47.0), SQLite; `pyproject.toml`, `uv.lock` |
| Frontend | Next.js 16.1.6, React 19.2.3, Tailwind CSS 4, shadcn/ui, Vitest 4, ESLint 9; `frontend/package.json` |
| Tooling | [uv](https://docs.astral.sh/uv/) for Python, Node.js `>=22.14.0` with npm, ruff, pytest |
| Entry points | `app.py` (starts both servers), `backend/main.py` (FastAPI app), `frontend/src/app/` (pages), `mcp_server.py` (MCP, stdio) |
| Ports | frontend `47300`, backend `47301`; override with `FRONTEND_PORT` / `BACKEND_PORT` |
| User data | settings database (keys), jobs, runs, flows. Default: macOS `~/Library/Application Support/BlockFlow Studio`, Windows `%LOCALAPPDATA%\BlockFlow Studio`, Linux `$XDG_DATA_HOME/blockflow-studio` or `~/.local/share/blockflow-studio`. `BLOCKFLOW_DATA_DIR` (or `BLOCKFLOW_HOME`) overrides it. |
| Output folder | `<user data>/output` unless the user chose another in Settings, then App |
| Providers | Kie and PiAPI, described by the capability ledger in `backend/byok/` |
| Repository | `Hearmeman24/Blockflow-Studio` (also in `package.json` and `backend/app_update/settings.py`; `tests/test_repo_identity.py` keeps them in step) |

## Set up BlockFlow Studio for a user

Follow this when a person says "set up BlockFlow for me". Run the commands from
the repository root. Steps 1 to 6 are free; step 7 spends the user's credits and
needs their explicit yes.

1. **Check prerequisites.** `python3 scripts/doctor.py` (Windows: `py
   scripts\doctor.py`). It uses only the standard library, so it runs before
   anything is installed.
   *Success:* no `fail` among `git`, `uv`, `python`, `node`, `npm`. For each
   `fail`, give the user the printed `fix` (install uv, Node.js 22.14+, or
   `uv python install 3.12`). Do not install system software without asking.
2. **Start the app.** `uv run app.py`, as a long-running background process
   (keep it running; it opens a browser unless `BLOCKFLOW_NO_OPEN=1`). On the
   first start it installs what is missing before the servers start (`npm ci`
   in `frontend/`, the block codegen and a FastMCP download, one line each),
   which can take a few minutes, and then compiles the frontend. If an install
   step fails it stops with a readable error and the command to retry; `uv run
   python scripts/setup.py` repairs the install. Then run `uv run python
   scripts/doctor.py --expect-running`.
   *Success:* `backend` and `frontend` are `ok`; the app answers at
   <http://localhost:47300>. If either server stops on its own, `app.py`
   prints an `[app]` line naming it and its exit code and exits with code 1
   (Ctrl+C exits 0); run `python3 scripts/doctor.py`, then start it again.
3. **The user enters their key.** Tell the user to open
   <http://localhost:47300> and enter a Kie and/or PiAPI key in the Welcome
   dialog, or later in **Settings, then API keys**. Never ask for a key in chat,
   never read it, and never put it in a file, environment variable or command.
   If the user pastes a key into the chat anyway, do not use it: ask them to
   enter it in the app and suggest they rotate it.
4. **Confirm a provider is configured.** `uv run python scripts/doctor.py`.
   *Success:* `providers` says `Key saved for: Kie` (or PiAPI). The doctor reads
   `GET /api/providers/catalog`, which reports only `configured: true/false`,
   never the key. `balances` `ok` means the key works.
5. **Register the MCP server** (server name `blockflow-studio`). Claude Code,
   from the repository root:

   ```bash
   claude mcp add blockflow-studio -- uv run --directory "$(pwd)" --with fastmcp mcp_server.py
   ```

   (PowerShell: `"${PWD}"`. Add `--scope user` to use it from any folder. If the
   app runs on another port, add `-e BLOCKFLOW_URL=http://127.0.0.1:<port>`
   before `--`.) Any other MCP client, with the absolute path filled in:

   ```json
   {"mcpServers": {"blockflow-studio": {
     "command": "uv",
     "args": ["run", "--directory", "/absolute/path/to/Blockflow-Studio", "--with", "fastmcp", "mcp_server.py"],
     "env": {"BLOCKFLOW_URL": "http://127.0.0.1:47301"}}}}
   ```

   *Success:* `claude mcp list` shows `blockflow-studio` as connected. The
   client loads new servers at the start of a session, so the user may need to
   restart it (Claude Code: start a new session) before the tools appear.
6. **Verify the MCP connection with read-only tools.** Call `list_models` with
   `{"mode": "text_to_image"}` and `get_balances`.
   *Success:* `ok: true`, and at least one model has a provider with
   `available: true`.
7. **Run one test generation (costs money; ask first).**
   - For each available `text_to_image` model and provider, call `estimate_cost`
     with `{"provider", "model", "mode": "text_to_image", "prompt": "a red apple
     on a wooden table, soft studio light"}`. Skip results with `estimate:
     null`. Pick the lowest `usd`.
   - Tell the user the model, provider and estimated cost in US dollars, and ask
     for an explicit yes. Without one, stop here: setup is done.
   - Call `generate` with the same arguments plus `"wait": true`,
     `"label": "Setup test"` and `"max_cost_usd"` = the estimate times 1.25,
     rounded up to the next cent.
   - *Success:* `job.status` is `COMPLETED`. Show the user `outputs[0].file_path`
     and tell them the run is on the **Artifacts** page
     (<http://localhost:47300/artifacts>, filter Source, MCP), where
     **Restore** opens it as a pipeline. `job.cost` is the provider's actual
     charge.

**The three most likely failures**

| Symptom | Fix |
|---|---|
| Doctor: `backend_port` or `frontend_port` `fail` ("in use by another program"), often the original BlockFlow app | Stop the other program, or start this one with `BACKEND_PORT=48001 FRONTEND_PORT=48000 uv run app.py` and register the MCP server with `-e BLOCKFLOW_URL=http://127.0.0.1:48001`. |
| MCP tools missing, or every tool returns `error.kind: "backend_unreachable"` | The app must be running (step 2), and the client must be restarted after `claude mcp add`. Check `claude mcp list`; the `--directory` path must be the absolute repository path. |
| `generate` refuses with `auth`, `unknown_cost` or `over_budget` | `auth`: no key for that provider, back to step 3. `unknown_cost`: pick a model with an estimate. `over_budget`: the cap is below the estimate; ask the user before raising it. |

## Commands

| Command | When |
|---|---|
| `uv run app.py` | Run the app (backend :47301, frontend :47300). |
| `python3 scripts/doctor.py [--json] [--expect-running]` | Health check; read-only, no keys in the output. `--json` for bug reports. |
| `uv run python scripts/setup.py [--check]` | Install or repair everything, idempotently, including the Python dev tools for tests and lint (`uv run app.py` installs only what the app needs). Refuses `npm ci` while this checkout's app is running. |
| `uv run ruff check .` | Python lint. Before every hand-off. |
| `uv run pytest tests/ -q` | Backend tests. Focused: `uv run pytest tests/test_byok_service.py -q`. |
| `uv run --with fastmcp pytest tests/test_mcp_*.py -q` | MCP tests including the FastMCP registration test (skipped without `--with fastmcp`). |
| `npm --prefix frontend run gen:custom-blocks` | Block codegen. After adding, renaming or removing a block. |
| `npm --prefix frontend exec tsc -- --noEmit` | Type check. |
| `npm --prefix frontend run lint` | ESLint; 0 errors required, warnings allowed. |
| `npm --prefix frontend test` | Vitest. Focused: `npm --prefix frontend test -- model-select`. |
| `npm --prefix frontend run build` | Production build. Not while a dev server from the same checkout is running. |
| `uv run python tests/test_byok_catalog_fixture.py` | Regenerate the frontend catalog fixtures after a ledger change. |
| `uv run python tests/test_status_contract_fixture.py` | Regenerate the status-contract fixture after changing `backend/statuses.py`. |
| `uv run python scripts/sync_price_ledger.py` | Pull the price ledger from `Hearmeman24/blockflow-prices`. |

CI (`.github/workflows/ci.yml`) runs ruff, pytest, codegen, tsc, lint, Vitest
and the build.

## Project map

```
app.py                      installs what a fresh clone is missing, then starts backend + frontend;
                            the only entry point users run (BLOCKFLOW_NO_AUTO_SETUP=1 skips the install)
mcp_server.py               MCP server entry (stdio); code in blockflow_mcp/ (one module per tool group)
backend/
  main.py                   FastAPI app; mounts routers and every block sidecar at /api/blocks/<slug>
  statuses.py               every status vocabulary (jobs, runs, updater, ...) as StrEnums; stdlib only
  config.py                 user data folder and output folder resolution
  byok/                     capability ledger (catalog.py, spec.py, validation.py), provider adapters
                            (providers/), generation service, pricing, balances, /api/providers/*, /api/generation/*
  job_store.py, job_routes.py         persisted jobs, /api/jobs*
  settings_store.py, settings_routes.py  allow-listed credentials and app prefs
  characters.py, character_routes.py    Characters
  prompt_writer/            Prompt Writer LLM adapters (OpenRouter, Ollama, LM Studio)
custom_blocks/<slug>/       blocks shipped with the project: frontend.block.tsx (+ optional backend.block.py)
private_blocks/<slug>/      a user's own blocks; git-ignored, same layout
frontend/src/
  app/                      pages: generate, characters, artifacts, settings
  lib/pipeline/             registry (BlockDef, ports), runner, flow I/O and migrations
  lib/status/               the same vocabularies for the frontend, checked against the backend by a fixture
  components/pipeline/      canvas, block card; custom_blocks/_register.ts is generated
  components/byok/, lib/byok/  generation block shell, loaders, catalog client, cost
  components/ui/            shadcn primitives
prices/                     bundled price ledger
scripts/                    doctor.py, setup.py, install_steps.py (shared by setup.py and app.py),
                            sync_price_ledger.py, ...
tests/                      pytest; frontend tests sit next to their code as *.test.ts(x)
README.md, AGENTS.md        the only documentation shipped with the repository
```

## Boundaries

**Always**
- Write a failing test first for any behaviour change, run it, then implement
  (see [Engineering rules](#engineering-rules)).
- Run the relevant gates from [Commands](#commands) before saying work is done,
  and report what you ran.
- Put a user's own blocks in `private_blocks/<slug>/`, not `custom_blocks/`.
- Take model facts (limits, modes, formats, identifiers) from the capability
  ledger, and add new ones there only.
- Mock providers at the HTTP transport in tests.
- Keep the shipped documentation to `README.md` and `AGENTS.md`, and update
  them when a change affects what they say. Private notes go in the git-ignored
  `internal_docs/` folder; nothing the app or the tests depend on lives there.
- Estimate the cost and tell the user before anything that spends credits.

**Ask first**
- Anything that spends provider credits, including MCP `generate`, the
  generation submit route and a pipeline run with a generation block.
- Adding or upgrading a dependency (Python or npm).
- Changing the saved-flow schema (`schema_version`), database tables or stored
  preference names.
- Changing a provider request shape or adapter.
- Deleting user data, or files in the output folder or user data folder.
- Pushing, tagging, releasing or publishing anything, or opening a pull request.
- Installing system software (uv, Node.js, Python).

**Never**
- Read, print, log, store or transmit an API key, or ask for one in chat; keys
  are entered by the user in the app only.
- Commit secrets, `.env` files, the settings database or `private_blocks/`.
- Call a provider from the frontend or from a block, or bypass the backend's
  provider adapters.
- Create a `docs/` or `public_docs/` directory or other documentation files in
  the repository, or link to or read from `internal_docs/` in tracked files
  (`tests/test_public_tree.py` enforces this).
- Delete, skip or weaken a failing test to make a gate pass.
- Hard-code model limits, prices or provider identifiers outside the ledgers.
- Run destructive git commands (`reset --hard`, `clean -fd`, `push --force`,
  branch deletion) on a user's checkout, or use `--no-verify`.
- Open, migrate or modify the original BlockFlow app's data folder.
- Publish to npm or any package registry: BlockFlow Studio is distributed by
  cloning the repository, and the root `package.json` is private.

## Adding a block

Where it goes: a block for **this user only** goes in `private_blocks/<slug>/`
(git-ignored, so pulling updates never touches it). A block **contributed to the
project** goes in `custom_blocks/<slug>/`. The layout is the same; a slug may
not exist in both: the codegen and the backend loader both fail loudly on a
collision instead of shadowing one side. Both scan `custom_blocks/` then
`private_blocks/` (a missing folder counts as empty) and sort by slug; a
private block's routes mount at the same `/api/blocks/<slug>/` prefix. There is
no switch: the folder is on disk or it is not.

1. Create `<dir>/<slug>/frontend.block.tsx` exporting `blockDef: BlockDef`.
2. Optionally create `<dir>/<slug>/backend.block.py` exporting `router =
   APIRouter()`; it is mounted at `/api/blocks/<slug>/`.
3. Write tests: backend with `TestClient` and `load_block_sidecars` (see
   `tests/test_block_sidecar_overlay.py`), frontend with Vitest/RTL importing
   `@/components/pipeline/custom_blocks/_register`.
4. Run `npm --prefix frontend run gen:custom-blocks`, then tsc, lint and the
   tests. Restart the app so the backend loads a new sidecar.

A complete example, verified by building it in a temporary slug (codegen, tsc,
lint, a Vitest test including cancellation, and a backend route test):

```tsx
// private_blocks/prompt_suffix/frontend.block.tsx
'use client'

import { useEffect } from 'react'
import { Input } from '@/components/ui/input'
import { BlockField } from '@/components/pipeline/block-field'
import { toText } from '@/lib/pipeline/block-utils'
import { PORT_TEXT, type BlockComponentProps, type BlockDef } from '@/lib/pipeline/registry'
import { useSessionState } from '@/lib/use-session-state'

function PromptSuffixBlock({ blockId, setOutput, registerExecute, setStatusMessage }: BlockComponentProps) {
  // Saved with the flow because 'suffix' is listed in configKeys below.
  const [suffix, setSuffix] = useSessionState(`block_${blockId}_suffix`, ', cinematic lighting')

  useEffect(() => {
    // Fresh inputs and an AbortSignal come from the runner on every run.
    registerExecute(async (inputs, signal) => {
      const prompt = toText(inputs.prompt).trim()
      if (!prompt) throw new Error('Connect a block that outputs a prompt.')
      setStatusMessage('Adding suffix…')
      const res = await fetch('/api/blocks/prompt_suffix/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, suffix }),
        signal, // Cancel stops the request; fetch then rejects with an AbortError.
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.message)
      setOutput('prompt', data.text)
    })
  })

  return (
    <BlockField label="Suffix" htmlFor={`${blockId}-suffix`}>
      <Input id={`${blockId}-suffix`} value={suffix} onChange={(e) => setSuffix(e.target.value)} />
    </BlockField>
  )
}

export const blockDef: BlockDef = {
  type: 'promptSuffix',
  label: 'Prompt Suffix',
  description: 'Append fixed text to the upstream prompt.',
  size: 'sm',
  role: 'prompt',
  canStart: false,
  inputs: [{ name: 'prompt', kind: PORT_TEXT }],
  outputs: [{ name: 'prompt', kind: PORT_TEXT }],
  configKeys: ['suffix'],
  component: PromptSuffixBlock,
}
```

```python
# private_blocks/prompt_suffix/backend.block.py
"""Prompt Suffix routes, mounted at /api/blocks/prompt_suffix."""
from __future__ import annotations

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

router = APIRouter()


@router.post("/apply")
def apply(body: object = Body(default=None)) -> JSONResponse:
    prompt = body.get("prompt") if isinstance(body, dict) else None
    suffix = body.get("suffix", "") if isinstance(body, dict) else ""
    if not isinstance(prompt, str) or not prompt.strip() or not isinstance(suffix, str):
        return JSONResponse({"ok": False, "kind": "validation", "message": "Send {prompt, suffix} as text."},
                            status_code=422)
    return JSONResponse({"ok": True, "text": prompt.rstrip() + suffix})
```

Block rules: "block" is the product term (not node, step or stage); one global
**Run Pipeline** button, no per-block run action; `execute` reads the `inputs`
it is given, not stale state; async work honours the `AbortSignal`; multiple
pipeline tabs run at once and cancellation is per tab. The runner marks a
block a cancel interrupts `cancelled`; a block that reports its own status
(`setExecutionStatus`, e.g. for a job resumed after a reload) ends a stopped
job as `cancelled` too, never leaving it `running`. Widths: `sm` 280,
`md` 360, `lg` 440, `huge` 540 px. A card is as tall as its content (the
reduced layout fixes it at 220, 320, 460 or 580 px); a media loader reporting
its items through `useMediaItemCount` takes the `md` width while no section
holds more than two. `role` (`image`, `video`, `loader`, `prompt`;
`lib/pipeline/block-role.ts`) sets the block's colour and its add-block menu
section; without it the role comes from the ports. Spacing: the block body
makes the block's root a flex column with the standard gap (`gap-3`), so a
block sets no `space-y-*`, `gap-*` or `mt-*` between its top-level items.
Generation blocks (Text to Image
and the other four) have no sidecar; they use `/api/generation/*` and
`/api/jobs*`, take references only from loader blocks (`starterPrereqs`), and
read every selector and limit from the ledger.

**Adding a model or provider:** add a `ModelEntry` to `backend/byok/catalog.py`
(types in `spec.py`), map the request in the provider adapter, test the exact
request body with a mocked transport, then regenerate the frontend fixtures
(`uv run python tests/test_byok_catalog_fixture.py`) and run the frontend tests.
Record anything the provider leaves unclear in `UNVERIFIED`, and features the
app deliberately does not offer in `UNSUPPORTED_FEATURES`.

- Kie (`backend/byok/providers/kie.py`): the `FAMILIES` table maps a model
  prefix to its reference and resolution fields; special fields go in
  `_build_input`. PiAPI (`backend/byok/providers/piapi.py`): `BUILDERS` maps
  the model string to a builder returning `(task_type, input, config)`. A model
  with no mapping fails with `unsupported` rather than sending a guess.
- Update the expected-model lists in `tests/test_byok_ledger.py`, limits in
  `tests/test_byok_validation.py` and exact bodies in
  `tests/test_byok_requests.py`.
- A new provider also needs: `PROVIDERS`/`PROVIDER_NAMES` in `spec.py`, a
  `ProviderAdapter` subclass registered in `ADAPTERS`
  (`backend/byok/providers/`), errors mapped to the kinds in
  `backend/byok/errors.py`, its credential name in `ALLOWED_CREDENTIALS`
  (`backend/settings_store.py`) and `CREDENTIALS` (`backend/byok/service.py`),
  and the frontend key specs (`lib/settings/client.ts`,
  `components/settings/provider-keys.tsx`, `lib/provider-referrals.ts`).

**Prices** come from the price ledger, maintained in
[Hearmeman24/blockflow-prices](https://github.com/Hearmeman24/blockflow-prices)
(bundled copy in `prices/`, code in `backend/byok/pricing.py`). A new model
gets an estimate only after that repository maps its price rows (or records a
`not_priceable` note); then run `uv run python scripts/sync_price_ledger.py`
here (`--check` exits 1 when the bundled copy is behind). A new billing scheme
needs `pricing.py` changes and tests in `tests/test_byok_pricing.py`. The
provider's charge after a run (`job.cost`) is authoritative; estimates are
estimates.

## Code patterns

A backend route that never echoes the body and maps error kinds to statuses
(`custom_blocks/prompt_writer/backend.block.py`):

```python
_STATUS_BY_KIND = {"validation": 422, "unavailable": 503, "timeout": 504}

@router.post("/generate")
async def generate(request: Request) -> JSONResponse:
    try:
        payload = json.loads(await request.body())
    except (ValueError, UnicodeDecodeError):
        # Never echo the body: it could hold anything the client sent.
        return JSONResponse({"ok": False, "kind": "validation", "message": "Send the request as JSON."},
                            status_code=422)
    result = await run_in_threadpool(service.generate, payload, service.default_deps())
    status = 200 if result["ok"] else _STATUS_BY_KIND.get(result["kind"], 502)
    return JSONResponse(result, status_code=status)
```

A ledger-driven control: options and availability come from the catalog, not
from constants (`frontend/src/components/byok/model-select.tsx`):

```tsx
const options = useMemo(
  () => modelsForMode(catalog, mode).map((model) => ({
    model,
    availability: modelAvailability(catalog, model.id, provider, mode),
  })),
  [catalog, mode, provider],
)
```

A test that mocks the provider at the HTTP transport and asserts the request
(`tests/test_byok_balances.py`):

```python
def test_kie_balance_reads_credits_and_converts_to_usd():
    adapter, transport = _adapter("kie", {"code": 200, "msg": "success", "data": 100.5})
    bal = adapter.get_balance(KIE_KEY)
    assert bal.amount == 100.5 and bal.unit == "credits"
    assert transport.calls[0]["url"] == "https://api.kie.ai/api/v1/chat/credit"
```

Non-blocking warnings go to the block header; errors that block a run stay in
the body (`frontend/src/components/byok/generation-block-shell.tsx`):

```tsx
if (state.missingOutput) {
  warnings.push({
    id: 'missing-output',
    message: `No output block. Add ${article(state.viewer.label)} ${state.viewer.label} after this block to see the result.`,
    action: { label: `Add ${state.viewer.label}`, onClick: state.addViewer },
  })
}
useHeaderWarnings(setHeaderWarnings, warnings)
```

## Engineering rules

### Test-driven development

No production code without a failing test first: write the test, run it and see
it fail for the expected reason, write the minimal implementation, see it pass,
then refactor. Tests assert the behaviour produced, not only that a route
returns 200 or a component renders: the file written, the state stored, the
payload sent, the fields returned. Before a non-trivial change, list the edge
cases: empty, missing or malformed input; network and provider failures;
partial failures; concurrency; boundary values and large inputs; Unicode; auth
failures; cancellation through `AbortSignal`. Tests never call a real provider.
Tests that need paid APIs, real credentials or human visual judgment are flagged
to the user before they are written. Mock at the boundary (the HTTP transport,
the command runner), never the logic under test.

### Blast radius before fixing

Classify a block bug first: a **local defect** (this block only), a **contract
defect** (shared pipeline semantics, media references, settings, credentials,
cancellation, artifacts, provider input shape, generated block glue) or a
**sibling-pattern defect** (a pattern other blocks copied). For the last two,
audit the siblings and shared helpers before fixing, and fix in the shared
place when that is where the bug is. For every non-trivial fix, record the
failing surface, the shared contract involved, what you audited, why the fix is
local or shared, and regression tests for the whole class. A surgical local fix
is allowed only when labelled as one, with follow-up work tracked.

### Product conventions

- Keys live only in the backend settings store (allow-listed names in
  `backend/settings_store.py`, file mode 0600). The API returns only
  "configured" and the last four characters; job records strip secret-named
  fields and errors redact the key.
- Saved flows carry `schema_version`; removed or unknown block types load as
  unsupported blocks and are never dropped silently.
- Filters and sort state belong in URL search params.
- Use the existing structured parsers and shared helpers; prefer existing block
  and pipeline patterns over new abstractions.

### UI design system

- **Dark theme only** (`class="dark"` on `<html>`).
- **Primitive-first:** use `components/ui/*` (`Button`, `Input`, `Select`,
  `Textarea`, `Dialog`/`AlertDialog`, `Progress`) instead of raw elements or
  hand-made overlays. No `confirm()`/`alert()`/`prompt()`.
- **Tokens:** dense text uses `text-2xs` / `text-3xs` / `text-4xs`; state colours
  use `--success` / `--warning` / `--info` / `--link` and `destructive`, not raw
  `emerald-*`, `amber-*` or `blue-*`. Block-role colours from
  `blockRoleStyle()` (`frontend/src/lib/pipeline/block-role.ts`: image violet,
  video blue, loader amber, prompt emerald) and the media-kind accents from
  `kindAccent()` (`frontend/src/lib/byok/kind-accent.ts`) are decorative and
  never signal state.
- **Block spacing:** one vertical gap between a block's top-level items, set by
  the block body in `block-card.tsx`; blocks do not set their own on the root
  (a contract test in `block-contracts.test.tsx` enforces it). Tighter gaps
  stay inside a group, such as a field's label and control.
- **Shared atoms:** `StatusBadge`, `WarningBadge` with `useHeaderWarnings`,
  `AlertPanel`, `EmptyState`, `PageHeader`, `FavoriteButton`,
  `DeleteIconButton`, `BlockField`, `BlockFooter` (a top-level item of the
  block, which the body makes a flex column), `BlockRoleTile`,
  `pipeline/collapsible-section`, `ChipTooltip`,
  `byok/media-thumb`, and the `lib/` helpers. Add to a shared module before
  pasting a second copy.
- **Three states:** every data-driven surface has a `Skeleton` loading state,
  an `EmptyState` with one action, and a readable error with one recovery
  action; transient feedback uses `sonner` toasts.
- **One primary action per view**; on `/generate` it is **Run Pipeline**.
- **Layout:** content pages use one of the two standard max-widths and
  `PageHeader`.

### Delivery

- Work on a branch for non-trivial changes and keep each change scoped to its
  task.
- Before handing off: `git status --short`, confirm no unrelated user changes
  were touched, run the relevant gates, and report what changed, what was
  verified and what is not pushed.
- Do not push, merge to `main`, release or open a pull request without the
  user's explicit confirmation in the conversation. Committed locally is not
  done.
- Releases and in-app updates: the release repository is `DEFAULT_REPO` in
  `backend/app_update/settings.py`. Before tagging, sync the price ledger and
  run every gate including the build. Bump `version` in `package.json` (and
  `pyproject.toml`), tag `vX.Y.Z` (pre-releases `vX.Y.Z-beta.N`) on `main`'s
  history, push the tag and publish a GitHub Release. Never rewrite `main` or
  move a published tag: users update with `git merge --ff-only <tag>`, then
  `uv sync --frozen`, `npm --prefix frontend ci` (only when the lockfile
  changed), the block codegen, and a restart through `app.py`'s supervisor. A
  change to `app.py` itself needs a manual restart. By hand: stop the app,
  `git fetch --tags origin`, `git merge --ff-only vX.Y.Z`, `uv sync --frozen`,
  then `uv run app.py` (it reinstalls the frontend when the lockfile changed).

## Beta status

- **Report a bug:** open an issue with the bug template
  (`.github/ISSUE_TEMPLATE/bug_report.yml`) and attach `python3
  scripts/doctor.py --json` (it contains no keys). Never paste an API key.
- **Not yet verified:** most provider paths have only run against mocks. The
  ledger's `UNVERIFIED` list (`backend/byok/catalog.py`) records where the
  provider documentation was silent or contradictory.
