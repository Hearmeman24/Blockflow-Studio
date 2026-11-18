/**
 * A generation block's run, as one state and one pure reducer.
 *
 *   state \ event   start   update(validating)   update(other active)   update(terminal)   end(e)
 *   idle            idle    validating (fresh)   that status            ignored            e
 *   active          idle    validating (fresh)   that status            ignored            e
 *   ended           idle    validating (fresh)   ignored (late)         ignored            e
 *
 * "active" is validating, submitting, queued or running; "ended" is completed,
 * failed, cancelled or timed_out. `start` is a new run attempt (the execute
 * call), so nothing of the previous run shows while the next one is checked;
 * `validating` is where the submission begins, with no job id and no warnings.
 * Only `end` sets an outcome, so a failed run always carries its error and a
 * completed one never does. The outcome of a job comes from `runEndOfJob`
 * whether the run is a normal one or was resumed after a reload.
 */
import {
  ACTIVE_GENERATION_RUN_STATUSES,
  GENERATION_RUN_STATUS_LABEL,
  type BlockStatus,
  type GenerationRunStatus,
} from '@/lib/status'
import { GenerationRunError, type JobOutcome, type RunUpdate } from './run-generation'
import type { GenerationIssue } from './types'

export type EndedRunStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out'
export type ActiveRunStatus = Exclude<GenerationRunStatus, EndedRunStatus>

interface RunBase {
  jobId: string | null
  /** Warnings from validation (errors stop the run instead); kept after the run ends. */
  warnings: GenerationIssue[]
}

export type ActiveRun = RunBase & {
  status: ActiveRunStatus
  progress: number | null
  message: string | null
}

export type GenerationRunState =
  | { status: 'idle' }
  | ActiveRun
  | (RunBase & { status: 'completed' })
  | (RunBase & { status: 'failed' | 'timed_out'; error: string })
  /** `error` is null when the user cancelled the run, the job's text when it was cancelled elsewhere. */
  | (RunBase & { status: 'cancelled'; error: string | null })

/** How a run ended. */
export type RunEnd =
  | { status: 'completed' }
  | { status: 'failed' | 'timed_out'; error: string }
  | { status: 'cancelled'; error: string | null }

export type RunEvent =
  | { type: 'start' }
  | { type: 'update'; update: RunUpdate }
  | { type: 'end'; end: RunEnd }

export const IDLE_RUN: GenerationRunState = Object.freeze({ status: 'idle' })

const ACTIVE: ReadonlySet<GenerationRunStatus> = new Set(ACTIVE_GENERATION_RUN_STATUSES)

function isActiveStatus(status: GenerationRunStatus): status is ActiveRunStatus {
  return ACTIVE.has(status)
}

export function isActiveRun(state: GenerationRunState): state is ActiveRun {
  return state.status !== 'idle' && isActiveStatus(state.status)
}

function warningsOf(issues: GenerationIssue[] | undefined): GenerationIssue[] | undefined {
  return issues?.filter((i) => i.severity === 'warning')
}

export function reduceRun(state: GenerationRunState, event: RunEvent): GenerationRunState {
  switch (event.type) {
    case 'start':
      return IDLE_RUN
    case 'update': {
      const { update } = event
      // The run's end decides a terminal status, together with its error.
      if (!isActiveStatus(update.status)) return state
      if (update.status === 'validating') {
        return { status: 'validating', jobId: null, progress: null, message: null, warnings: warningsOf(update.issues) ?? [] }
      }
      // A late poll update after the run ended does not bring it back.
      if (state.status !== 'idle' && !isActiveRun(state)) return state
      const prev = isActiveRun(state) ? state : null
      return {
        status: update.status,
        jobId: update.jobId ?? prev?.jobId ?? null,
        progress: update.progress ?? null,
        message: update.message ?? null,
        warnings: warningsOf(update.issues) ?? prev?.warnings ?? [],
      }
    }
    case 'end': {
      const base: RunBase = state.status === 'idle'
        ? { jobId: null, warnings: [] }
        : { jobId: state.jobId, warnings: state.warnings }
      const { end } = event
      switch (end.status) {
        case 'completed':
          return { ...base, status: 'completed' }
        case 'failed':
        case 'timed_out':
          return { ...base, status: end.status, error: end.error }
        case 'cancelled':
          return { ...base, status: 'cancelled', error: end.error }
      }
    }
  }
}

const GENERIC_ERROR = 'The generation failed. Try again.'

/** A failure by its error kind: a server timeout reads as timed out (as it always has). */
function endOfFailure(errorKind: string, error: string): RunEnd {
  if (errorKind === 'timeout') return { status: 'timed_out', error }
  if (errorKind === 'cancelled') return { status: 'cancelled', error }
  return { status: 'failed', error }
}

/** How a job that produced no output ended, for a normal and a resumed run alike. */
export function runEndOfJob(outcome: Exclude<JobOutcome, { kind: 'output' }>): RunEnd {
  switch (outcome.kind) {
    case 'no_output':
      return { status: 'failed', error: outcome.error }
    case 'failed':
      return endOfFailure(outcome.errorKind, outcome.error)
    case 'cancelled':
      return { status: 'cancelled', error: outcome.error }
    case 'timed_out':
      return { status: 'timed_out', error: outcome.error }
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/** How a run ended that threw before it had a terminal job (validation, submit, poll, cancel). */
export function runEndOfError(err: unknown): RunEnd {
  if (isAbortError(err)) return { status: 'cancelled', error: null }
  const message = err instanceof Error && err.message ? err.message : GENERIC_ERROR
  return err instanceof GenerationRunError ? endOfFailure(err.kind, message) : { status: 'failed', error: message }
}

/**
 * The pipeline block status a run status reports through `setExecutionStatus`
 * (a resumed run; in a normal run the runner sets it from execute's result).
 */
export const EXECUTION_STATUS_BY_RUN: Readonly<Record<GenerationRunState['status'], BlockStatus>> = Object.freeze({
  idle: 'idle',
  validating: 'running',
  submitting: 'running',
  queued: 'running',
  running: 'running',
  completed: 'completed',
  failed: 'error',
  timed_out: 'error',
  cancelled: 'cancelled',
})

/** The block header's status text for an update: the percentage while running with progress. */
export function runHeaderText(update: Pick<RunUpdate, 'status' | 'progress'>): string {
  return update.status === 'running' && update.progress != null
    ? `Running ${Math.round(update.progress * 100)}%`
    : GENERATION_RUN_STATUS_LABEL[update.status]
}

/** The body's panel for a run that ended with an error text. */
export const RUN_END_PANEL: Readonly<Record<Exclude<EndedRunStatus, 'completed'>, { title: string; variant: 'error' | 'warning' }>> = Object.freeze({
  failed: { title: 'The generation did not finish', variant: 'error' },
  timed_out: { title: 'The generation timed out', variant: 'error' },
  cancelled: { title: 'The generation was cancelled', variant: 'warning' },
})

/** The ended run with an error text to show, or null. */
export function runError(state: GenerationRunState): { status: Exclude<EndedRunStatus, 'completed'>; error: string } | null {
  switch (state.status) {
    case 'failed':
    case 'timed_out':
    case 'cancelled':
      return state.error ? { status: state.status, error: state.error } : null
    default:
      return null
  }
}
