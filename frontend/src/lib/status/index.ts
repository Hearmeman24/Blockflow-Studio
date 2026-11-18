/**
 * Status vocabularies, declared once for the frontend.
 *
 * Every value is the exact string the backend stores and returns. The lists
 * that have a backend counterpart (`backend/statuses.py`) are checked against
 * `./__fixtures__/status-contract.json` by `status-contract.test.ts`; after a
 * backend change, regenerate it with
 * `uv run python tests/test_status_contract_fixture.py`.
 *
 * The older modules (`@/lib/types`, `@/lib/pipeline/types`,
 * `@/lib/byok/run-generation`, `@/lib/app-update/client`, ...) re-export from
 * here, so existing imports keep working.
 */

// ---- Generation jobs (/api/jobs) ----

export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ['QUEUED', 'RUNNING']
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']

/** What an active job's backend worker is doing (`phase` on a job snapshot).
 * Kept in the backend's memory only; absent once the job is terminal. */
export const JOB_PHASES = ['preparing', 'submitting', 'polling', 'downloading'] as const
export type JobPhase = (typeof JOB_PHASES)[number]

// ---- Pipeline blocks ----

/** A block's live status in the pipeline runner. */
export const BLOCK_STATUSES = ['idle', 'running', 'completed', 'error', 'skipped'] as const
export type BlockStatus = (typeof BLOCK_STATUSES)[number]

/** `status` of a block in a saved run's `block_results`: a live status, or
 * `cancelled` for a block a cancel left running. Older runs may hold `running`. */
export const SAVED_BLOCK_STATUSES = [...BLOCK_STATUSES, 'cancelled'] as const
export type SavedBlockStatus = (typeof SAVED_BLOCK_STATUSES)[number]

// ---- Saved runs (/api/runs) ----

export const RUN_STATUSES = ['completed', 'partial', 'failed'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export interface RunStatusBadge {
  label: string
  tone: 'warning' | 'error'
}

const RUN_STATUS_BADGE: Record<RunStatus, RunStatusBadge | null> = {
  completed: null,
  partial: { label: 'Partial', tone: 'warning' },
  failed: { label: 'Failed', tone: 'error' },
}

/** The Artifacts badge for a run's status: none for a completed run or a
 * value this build does not know (older rows). */
export function runStatusBadge(status: string): RunStatusBadge | null {
  return Object.hasOwn(RUN_STATUS_BADGE, status) ? RUN_STATUS_BADGE[status as RunStatus] : null
}

// ---- Generation block run (frontend only) ----

export const GENERATION_RUN_STATUSES = [
  'validating',
  'submitting',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const
export type GenerationRunStatus = (typeof GENERATION_RUN_STATUSES)[number]
export const ACTIVE_GENERATION_RUN_STATUSES: readonly GenerationRunStatus[] = ['validating', 'submitting', 'queued', 'running']

export const GENERATION_RUN_STATUS_BY_JOB: Record<JobStatus, GenerationRunStatus> = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
}

/** The block header's status text. While running with a known progress the
 * header shows the percentage instead (`use-generation-block.ts`). */
export const GENERATION_RUN_STATUS_LABEL: Record<GenerationRunStatus, string> = {
  validating: 'Checking the request…',
  submitting: 'Submitting…',
  queued: 'Queued',
  running: 'Running…',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timed_out: 'Timed out',
}

// ---- In-app updater (/api/app/update) ----

export const UPDATE_STATES = ['idle', 'running', 'restarting', 'done', 'failed', 'rolled_back'] as const
export type UpdateState = (typeof UPDATE_STATES)[number]
export const ACTIVE_UPDATE_STATES: readonly UpdateState[] = ['running', 'restarting']
export const FINISHED_UPDATE_STATES: readonly UpdateState[] = ['done', 'failed', 'rolled_back']

export const UPDATE_STEP_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'] as const
export type UpdateStepStatus = (typeof UPDATE_STEP_STATUSES)[number]

// ---- Providers, references, storage ----

export const BALANCE_STATUSES = ['ok', 'unavailable', 'error', 'not_configured'] as const
export type BalanceStatus = (typeof BALANCE_STATUSES)[number]

export const REFERENCE_HEALTH_STATUSES = ['ok', 'missing_local', 'unreachable', 'expired', 'malformed', 'unchecked'] as const
export type ReferenceHealthStatus = (typeof REFERENCE_HEALTH_STATUSES)[number]

/** The `asset_storage_mode` preference. */
export const ASSET_STORAGE_MODES = ['local_only', 'tmpfiles'] as const
export type AssetStorageMode = (typeof ASSET_STORAGE_MODES)[number]
