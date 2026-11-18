/**
 * Building and recovering a block's runtime state (`BlockState`).
 *
 *   status \ written by   runner                  the block itself (setExecutionStatus)
 *   idle                  run start, item reset   resume ended without a job
 *   running               block started           resume rejoined a job
 *   completed             execute resolved        resumed job completed
 *   error                 execute threw           resumed job failed
 *   skipped               disabled, chain ended   -
 *   cancelled             a cancel interrupted    resumed job stopped by the user
 *
 * Nothing leaves a block `running` once its run or resume is over: the runner
 * marks the block a cancel interrupts `cancelled`, and a block still running
 * when a resume ends (or found running after a reload with no job to rejoin)
 * goes through `interruptRunningBlocks`.
 */
import { isBlockStatus } from '@/lib/status'
import type { BlockState, BlockStatus } from './types'

export const INTERRUPTED_RUN_MESSAGE = 'Run tracking was interrupted. Check Artifacts for completed outputs.'

/**
 * The state for `status`, carrying `error` only when the status is `error`
 * (error text passed with another status is dropped).
 */
export function blockStateWith(
  status: BlockStatus,
  outputs: Record<string, unknown>,
  error?: string,
  statusMessage?: string,
): BlockState {
  const base = statusMessage === undefined ? { outputs } : { outputs, statusMessage }
  return status === 'error' ? { ...base, status, error } : { ...base, status }
}

/**
 * A block state read from sessionStorage, written by this build or another
 * one. A status this build does not know loads as `idle`; anything that is not
 * a state (no `outputs` object) is null.
 */
export function sanitizeBlockState(raw: unknown): BlockState | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const outputs = value.outputs
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return null
  const status = isBlockStatus(value.status) ? value.status : 'idle'
  return blockStateWith(
    status,
    outputs as Record<string, unknown>,
    typeof value.error === 'string' ? value.error : undefined,
    typeof value.statusMessage === 'string' ? value.statusMessage : undefined,
  )
}

/**
 * How a block still `running` ends when nothing will finish it:
 * `interrupted` (a reload or a resume lost track of it) goes idle with
 * `INTERRUPTED_RUN_MESSAGE`; `cancelled` (the user stopped a resume) is cancelled.
 */
export type RunningBlockEnd = 'interrupted' | 'cancelled'

function endRunning(state: BlockState, end: RunningBlockEnd): BlockState {
  return end === 'cancelled'
    ? blockStateWith('cancelled', state.outputs)
    : blockStateWith('idle', state.outputs, undefined, INTERRUPTED_RUN_MESSAGE)
}

/** `states` with every running block ended as `end`; the same map when none was running. */
export function interruptRunningBlocks(states: ReadonlyMap<string, BlockState>, end: RunningBlockEnd): Map<string, BlockState> {
  if (![...states.values()].some((s) => s.status === 'running')) return states as Map<string, BlockState>
  return new Map([...states].map(([id, state]) => [id, state.status === 'running' ? endRunning(state, end) : state]))
}
