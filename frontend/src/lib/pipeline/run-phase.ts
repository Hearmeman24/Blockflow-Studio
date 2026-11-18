/**
 * The run lifecycle of one pipeline tab, as one declared phase.
 *
 * The provider holds a single `RunPhase` and changes it only through
 * `transitionRun`. Everything else is derived from it: `isRunning` and
 * `runningBlockId` for the blocks, the persisted runtime, and the tab bar's
 * run state (`tabRunOf`), so the tab bar and the blocks cannot disagree.
 *
 * Every run carries a `runId`. Events from a run name it, and an event from a
 * run that is no longer the current one changes nothing: a cancelled run that
 * unwinds late cannot end, unlock or relabel the run that replaced it.
 *
 *   phase \ event   start      blockStarted(id)  cancel        finished(id)        resumeSettled
 *   idle            running    -                 -             -                   -
 *   running(r)      -          running (id==r)   cancelling(r) idle(outcome) id==r -
 *   cancelling(r)   running    -                 -             idle(cancelled) id==r -
 *   resuming        -          -                 idle(cancelled) -                 idle(resumed)
 *
 * `resuming` is the phase after a page reload that found jobs still in flight
 * for this tab's blocks: the tab shows as running until the last resumed poll
 * ends, and Stop cancels them.
 */

/** What the tab bar shows for a tab: kept as the three values it has always had. */
export type TabRunState = 'idle' | 'running' | 'done'

/** How the last run of a tab ended; `resumed` is a resume after a reload that ran to its end. */
export type RunOutcome = 'completed' | 'failed' | 'cancelled' | 'resumed'

export type RunPhase =
  | { kind: 'idle'; lastOutcome: RunOutcome | null }
  | { kind: 'running'; runId: number; controller: AbortController; blockId: string | null }
  | { kind: 'cancelling'; runId: number }
  | { kind: 'resuming'; blockIds: readonly string[]; blockId: string | null }

export type RunEvent =
  | { type: 'start'; runId: number; controller: AbortController }
  | { type: 'blockStarted'; runId: number; blockId: string }
  | { type: 'cancel' }
  | { type: 'finished'; runId: number; outcome: 'completed' | 'failed' }
  | { type: 'resumeSettled' }

export const IDLE_PHASE: RunPhase = { kind: 'idle', lastOutcome: null }

function unreachable(value: never): never {
  throw new Error(`Unknown run phase or event: ${JSON.stringify(value)}`)
}

/** The next phase; returns `phase` itself when the event does not apply. */
export function transitionRun(phase: RunPhase, event: RunEvent): RunPhase {
  switch (event.type) {
    case 'start':
      return canStartRun(phase)
        ? { kind: 'running', runId: event.runId, controller: event.controller, blockId: null }
        : phase
    case 'blockStarted':
      return phase.kind === 'running' && phase.runId === event.runId && phase.blockId !== event.blockId
        ? { ...phase, blockId: event.blockId }
        : phase
    case 'cancel':
      switch (phase.kind) {
        case 'running': return { kind: 'cancelling', runId: phase.runId }
        case 'resuming': return { kind: 'idle', lastOutcome: 'cancelled' }
        case 'idle':
        case 'cancelling': return phase
        default: return unreachable(phase)
      }
    case 'finished':
      if (!isCurrentRun(phase, event.runId)) return phase
      return { kind: 'idle', lastOutcome: phase.kind === 'cancelling' ? 'cancelled' : event.outcome }
    case 'resumeSettled':
      return phase.kind === 'resuming' ? { kind: 'idle', lastOutcome: 'resumed' } : phase
    default:
      return unreachable(event)
  }
}

/** A run may start when nothing runs, or while a cancelled run is still unwinding. */
export function canStartRun(phase: RunPhase): boolean {
  return phase.kind === 'idle' || phase.kind === 'cancelling'
}

/** Whether `runId` is the run this phase belongs to (running, or cancelled and unwinding). */
export function isCurrentRun(phase: RunPhase, runId: number): boolean {
  return (phase.kind === 'running' || phase.kind === 'cancelling') && phase.runId === runId
}

/** The runtime fields persisted per tab (`pipeline_runtime_v2_<tab>`) and read by the blocks. */
export function runtimeOf(phase: RunPhase): { isRunning: boolean; runningBlockId: string | null } {
  switch (phase.kind) {
    case 'running':
    case 'resuming':
      return { isRunning: true, runningBlockId: phase.blockId }
    case 'idle':
    case 'cancelling':
      return { isRunning: false, runningBlockId: null }
    default:
      return unreachable(phase)
  }
}

export interface PublishedTabRun {
  state: TabRunState
  /** How the last run ended, or `cancelled` while a cancelled run unwinds. */
  outcome: RunOutcome | null
}

/**
 * What the tab bar shows. A cancelled run that is still unwinding shows as idle
 * (Run is offered again at once, as before); once it has unwound it is `done`,
 * like a finished or failed run, with Continue offered.
 */
export function tabRunOf(phase: RunPhase): PublishedTabRun {
  switch (phase.kind) {
    case 'idle': return { state: phase.lastOutcome ? 'done' : 'idle', outcome: phase.lastOutcome }
    case 'running':
    case 'resuming': return { state: 'running', outcome: null }
    case 'cancelling': return { state: 'idle', outcome: 'cancelled' }
    default: return unreachable(phase)
  }
}

/**
 * The phase a tab starts in. A recovered runtime that is still running (see
 * `normalizeRecoveredRuntime`) means jobs were in flight at the reload: resume
 * them, tracking the blocks that hold a pending job record.
 */
export function initialRunPhase(
  runtime: { isRunning: boolean; runningBlockId: string | null },
  pendingBlockIds: readonly string[],
): RunPhase {
  if (!runtime.isRunning) return IDLE_PHASE
  return { kind: 'resuming', blockIds: [...pendingBlockIds], blockId: runtime.runningBlockId }
}
