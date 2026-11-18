/**
 * The update dialogs' view as one state. The provider's effects and actions
 * only dispatch events; what the dialogs show is derived from this state.
 *
 *   closed
 *   confirm   idle | starting | blocked_jobs | blocked | error
 *   progress  the backend's progress, plus the connection while BlockFlow
 *             restarts (ok | reconnecting | gave_up) and the close request
 *             (idle | pending | error: the acknowledge failed)
 */
import type { Blocker, UpdateProgress } from '@/lib/app-update/client'
import { ACTIVE_UPDATE_STATES, type UpdateState } from '@/lib/status'

export type ConfirmPhase =
  | { kind: 'idle' }
  | { kind: 'starting'; blockers: Blocker[] }
  /** Only running generation jobs block: the user may choose "Update anyway". */
  | { kind: 'blocked_jobs'; blockers: Blocker[] }
  /** Something else blocks: the update cannot start. */
  | { kind: 'blocked'; blockers: Blocker[] }
  | { kind: 'error'; message: string; blockers: Blocker[] }

export type Connection = 'ok' | 'reconnecting' | 'gave_up'

/** What a successful acknowledge does next. */
export type CloseThen = 'close' | 'reload'
export type Closing =
  | { kind: 'idle' }
  | { kind: 'pending'; then: CloseThen }
  | { kind: 'error'; message: string; then: CloseThen }

export type UpdateView =
  | { kind: 'closed' }
  | { kind: 'confirm'; phase: ConfirmPhase }
  | { kind: 'progress'; progress: UpdateProgress; connection: Connection; closing: Closing }

export type UpdateEvent =
  | { type: 'confirm_opened' }
  | { type: 'confirm_cancelled' }
  | { type: 'start_requested' }
  | { type: 'start_succeeded'; progress: UpdateProgress }
  | { type: 'start_blocked'; blockers: Blocker[] }
  | { type: 'start_failed'; message: string }
  /** The progress read on page load (a reload mid-update, or a finished update to report). */
  | { type: 'progress_resumed'; progress: UpdateProgress }
  /** A poll of the progress while the dialog is open. */
  | { type: 'progress_read'; progress: UpdateProgress }
  | { type: 'backend_unreachable' }
  | { type: 'backend_answered' }
  | { type: 'restart_timed_out' }
  | { type: 'close_requested'; then: CloseThen }
  | { type: 'close_failed'; message: string }
  | { type: 'close_done' }

export const CLOSED: UpdateView = { kind: 'closed' }

const ACTIVE: ReadonlySet<UpdateState> = new Set(ACTIVE_UPDATE_STATES)

export function isActiveProgress(progress: UpdateProgress): boolean {
  return ACTIVE.has(progress.state)
}

function showProgress(progress: UpdateProgress): UpdateView {
  return { kind: 'progress', progress, connection: 'ok', closing: { kind: 'idle' } }
}

function blockersOf(phase: ConfirmPhase): Blocker[] {
  return phase.kind === 'idle' ? [] : phase.blockers
}

/** The progress view may be closed: the update is over, or BlockFlow did not come back. */
export function canCloseProgress(view: UpdateView): boolean {
  if (view.kind !== 'progress' || view.closing.kind === 'pending') return false
  return !isActiveProgress(view.progress) || view.connection === 'gave_up'
}

export function updateViewReducer(view: UpdateView, event: UpdateEvent): UpdateView {
  switch (event.type) {
    case 'confirm_opened':
      return view.kind === 'progress' ? view : { kind: 'confirm', phase: { kind: 'idle' } }
    case 'confirm_cancelled':
      return view.kind === 'confirm' && view.phase.kind !== 'starting' ? CLOSED : view
    case 'start_requested':
      if (view.kind !== 'confirm' || view.phase.kind === 'starting' || view.phase.kind === 'blocked') return view
      return { kind: 'confirm', phase: { kind: 'starting', blockers: blockersOf(view.phase) } }
    case 'start_succeeded':
      return showProgress(event.progress)
    case 'start_blocked': {
      if (view.kind !== 'confirm') return view
      const onlyJobs = event.blockers.every((b) => b.code === 'active_jobs')
      return { kind: 'confirm', phase: { kind: onlyJobs ? 'blocked_jobs' : 'blocked', blockers: event.blockers } }
    }
    case 'start_failed':
      if (view.kind !== 'confirm') return view
      return { kind: 'confirm', phase: { kind: 'error', message: event.message, blockers: blockersOf(view.phase) } }
    case 'progress_resumed':
      // A start in flight or a progress already shown is newer than the page-load read.
      if (event.progress.state === 'idle') return view
      if (view.kind === 'progress' || (view.kind === 'confirm' && view.phase.kind === 'starting')) return view
      return showProgress(event.progress)
    case 'progress_read': {
      if (view.kind !== 'progress') return view
      const stillRestarting = event.progress.state === 'restarting'
      return { ...view, progress: event.progress, connection: stillRestarting ? view.connection : 'ok' }
    }
    case 'backend_unreachable':
      if (view.kind !== 'progress' || view.connection !== 'ok') return view
      return { ...view, connection: 'reconnecting' }
    case 'backend_answered':
      if (view.kind !== 'progress' || view.connection !== 'reconnecting') return view
      return { ...view, connection: 'ok' }
    case 'restart_timed_out':
      if (view.kind !== 'progress' || view.progress.state !== 'restarting') return view
      return { ...view, connection: 'gave_up' }
    case 'close_requested':
      if (!canCloseProgress(view) || view.kind !== 'progress') return view
      return { ...view, closing: { kind: 'pending', then: event.then } }
    case 'close_failed':
      if (view.kind !== 'progress' || view.closing.kind !== 'pending') return view
      return { ...view, closing: { kind: 'error', message: event.message, then: view.closing.then } }
    case 'close_done':
      return view.kind === 'progress' ? CLOSED : view
  }
}

export function needsManualRestart(progress: UpdateProgress): boolean {
  return progress.state === 'done' && !!progress.restart?.required && !progress.restart.automatic
}

export function progressHeadline(view: Extract<UpdateView, { kind: 'progress' }>): string {
  const p = view.progress
  switch (p.state) {
    case 'running': return `Updating to ${p.tag ?? 'the new version'}…`
    case 'restarting':
      return view.connection === 'gave_up' ? 'BlockFlow has not come back yet'
        : view.connection === 'reconnecting' ? 'Restarting BlockFlow…' : 'Restarting…'
    case 'done': return needsManualRestart(p) ? 'Updated, restart needed' : `Updated to ${p.tag}`
    case 'rolled_back': return 'Update undone'
    case 'failed': return 'Update failed'
    case 'idle': return 'Update'
  }
}

interface RestartClient {
  fetchVersion: () => Promise<unknown>
  fetchProgress: () => Promise<UpdateProgress>
}

/**
 * One poll while BlockFlow restarts. Any answer from the version route means
 * the backend is up, whichever version it runs: the progress then says what
 * really happened (done on the new version, or failed / rolled back on the
 * old one). A failed progress read after that is not a lost connection.
 */
export async function readRestart(client: RestartClient): Promise<UpdateEvent[]> {
  try {
    await client.fetchVersion()
  } catch {
    return [{ type: 'backend_unreachable' }]
  }
  const events: UpdateEvent[] = [{ type: 'backend_answered' }]
  try {
    events.push({ type: 'progress_read', progress: await client.fetchProgress() })
  } catch { /* busy; the next poll reads it */ }
  return events
}
