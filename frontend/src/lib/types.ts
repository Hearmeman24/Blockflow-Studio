// ---- Jobs (provider-neutral job store, /api/jobs) ----

import {
  ACTIVE_JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  type JobPhase,
  type JobStatus,
  type RunStatus,
  type SavedBlockStatus,
} from '@/lib/status'

// The vocabularies live in `@/lib/status`; these names stay for existing imports.
export type { JobStatus, RunStatus, SavedBlockStatus }
export const TERMINAL_STATUSES: readonly JobStatus[] = TERMINAL_JOB_STATUSES
export const ACTIVE_STATUSES: readonly JobStatus[] = ACTIVE_JOB_STATUSES

export type JobSource = 'pipeline' | 'mcp'

export interface JobOutput {
  kind: 'image' | 'video' | 'audio'
  url: string
  local_url?: string | null
}

export interface JobError {
  kind: string
  message: string
}

/** What the provider reports it charged for a finished task. `unit` is the
 * provider's own unit (Kie `credits`, PiAPI `points`); `usd_equivalent` is
 * null when the conversion is not documented. */
export interface JobCost {
  amount: number
  unit: string
  usd_equivalent: number | null
}

/** Actual charge vs the price ledger's prediction (backend/byok/learned_prices.py).
 * Amounts are Kie credits or US dollars. `report_url` is a prefilled new-issue
 * link, set only when the prices differ and a ledger repo is configured. */
export interface PriceCheck {
  expected: { amount: number; unit: string }
  actual: { amount: number; unit: string }
  source: 'ledger' | 'bundled'
  differs: boolean
  checked_at: string
  report_url: string | null
}

/** Snapshot of one job as returned by `/api/jobs` and the `/api/jobs/events` stream.
 * Timestamps are epoch seconds. */
export interface JobSnapshot {
  job_id: string
  source: JobSource
  provider: string
  model: string
  mode: string
  status: JobStatus
  remote_job_id: string | null
  remote_status: string | null
  /** 0..1, or null when the provider reports no progress. */
  progress: number | null
  message: string | null
  error: JobError | null
  outputs: JobOutput[]
  request: Record<string, unknown>
  created_at: number
  updated_at: number
  completed_at: number | null
  cancel_requested: boolean
  /** Provider-reported charge; null until the task finishes or when the
   * provider reports none. Optional: absent from snapshots of older servers. */
  cost?: JobCost | null
  /** Set when the job finished with a cost and the ledger had a price for it. */
  price_check?: PriceCheck | null
  /** What the backend worker is doing while the job is active (in memory
   * only on the server). Absent on terminal jobs and from older servers. */
  phase?: JobPhase | null
}

// ---- Run History ----

export interface BlockResult {
  block_index: number
  block_type: string
  block_label: string
  /** A `SavedBlockStatus` when written by this build; older rows may hold other text. */
  status: string
  outputs: Record<string, { kind: string; value: unknown }>
}

export interface RunEntry {
  id: string
  name: string
  status: RunStatus
  duration_ms: number
  flow_snapshot: Record<string, unknown>
  block_results: BlockResult[]
  created_at: string
  favorited?: boolean
}
