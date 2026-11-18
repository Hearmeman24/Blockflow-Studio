/**
 * How a pipeline run's end is saved to history: the run's status, each
 * block's saved status, and whether a cancelled run is saved at all.
 *
 * The runner keeps its own `RunSummary` while it runs and calls these once,
 * when the run ends.
 */
import type { BlockStatus, RunStatus, SavedBlockStatus } from '@/lib/status'

export interface RunSummary {
  /** A block failed (an iterator item failing counts too). */
  errored: boolean
  /** A block reported a partial failure, or an iterator item failed. */
  partialFailure: boolean
  /** Blocks that completed in this run, plus those a Continue run carried over. */
  completedExecutions: number
  /** The run was cancelled. */
  cancelled: boolean
}

/**
 * Failed when an error occurred and nothing completed; partial when an error
 * occurred after something completed, or on a partial failure or a cancel;
 * completed otherwise.
 */
export function deriveRunStatus(summary: RunSummary): RunStatus {
  if (summary.errored) return summary.completedExecutions === 0 ? 'failed' : 'partial'
  if (summary.partialFailure || summary.cancelled) return 'partial'
  return 'completed'
}

/**
 * A block's status in the saved run. A block still `running` when its run
 * ends was left there by a cancel, so it is saved as `cancelled`.
 */
export function savedBlockStatus(status: BlockStatus | undefined): SavedBlockStatus {
  switch (status) {
    case undefined: return 'idle'
    case 'running':
    case 'cancelled': return 'cancelled'
    case 'idle':
    case 'completed':
    case 'error':
    case 'skipped': return status
    default: {
      const unknown: never = status
      throw new Error(`Unknown block status: ${String(unknown)}`)
    }
  }
}

/** A cancelled run is kept only for a generation it finished itself: that output was paid for. */
export function shouldSaveRun(end: { cancelled: boolean; generatedThisRun: boolean }): boolean {
  return !end.cancelled || end.generatedThisRun
}
