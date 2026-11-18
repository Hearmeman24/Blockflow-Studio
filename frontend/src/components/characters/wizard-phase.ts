/**
 * The character wizard's phase as one state:
 *
 *   editing    composing a new character (with the last create error, if
 *              any), or editing a saved one live
 *   creating   the character is being created from the name and face
 *   uploading  the other staged files, one at a time
 *   partial    created, but some files were not added: they are listed with
 *              Retry; closing asks first, so they are never dropped silently
 *   retrying   those files are being uploaded again
 *   done       created with every file
 *
 * `partial` and `retrying` carry the new character's id, so the wizard keeps
 * working on it while the page's URL hands over from `?new=1` to `?edit=1&id=`.
 */
import type { StagedFile } from './media-source'

export interface WizardFailure {
  item: StagedFile
  error: string
}

export type WizardPhase =
  | { kind: 'editing'; error: string | null }
  | { kind: 'creating' }
  | { kind: 'uploading'; characterId: string; index: number; total: number }
  | { kind: 'partial'; characterId: string; failures: WizardFailure[]; confirmingClose: boolean }
  | { kind: 'retrying'; characterId: string; failures: WizardFailure[] }
  | { kind: 'done'; characterId: string }

export type WizardEvent =
  | { type: 'create_started' }
  | { type: 'create_failed'; message: string }
  | { type: 'created'; characterId: string; total: number }
  | { type: 'upload_started'; index: number }
  | { type: 'uploads_finished'; failures: WizardFailure[] }
  | { type: 'retry_started' }
  | { type: 'retry_finished'; failures: WizardFailure[] }
  | { type: 'close_requested' }
  | { type: 'close_cancelled' }

export const EDITING: WizardPhase = { kind: 'editing', error: null }

export function wizardPhaseReducer(phase: WizardPhase, event: WizardEvent): WizardPhase {
  switch (event.type) {
    case 'create_started':
      return phase.kind === 'editing' ? { kind: 'creating' } : phase
    case 'create_failed':
      return phase.kind === 'creating' ? { kind: 'editing', error: event.message } : phase
    case 'created':
      return phase.kind === 'creating' ? { kind: 'uploading', characterId: event.characterId, index: 0, total: event.total } : phase
    case 'upload_started':
      return phase.kind === 'uploading' ? { ...phase, index: event.index } : phase
    case 'uploads_finished':
      if (phase.kind !== 'uploading') return phase
      return event.failures.length === 0
        ? { kind: 'done', characterId: phase.characterId }
        : { kind: 'partial', characterId: phase.characterId, failures: event.failures, confirmingClose: false }
    case 'retry_started':
      return phase.kind === 'partial' ? { kind: 'retrying', characterId: phase.characterId, failures: phase.failures } : phase
    case 'retry_finished':
      if (phase.kind !== 'retrying') return phase
      return event.failures.length === 0
        ? EDITING
        : { kind: 'partial', characterId: phase.characterId, failures: event.failures, confirmingClose: false }
    case 'close_requested':
      return phase.kind === 'partial' ? { ...phase, confirmingClose: true } : phase
    case 'close_cancelled':
      return phase.kind === 'partial' ? { ...phase, confirmingClose: false } : phase
  }
}

/** Creating or uploading: the dialog cannot be closed and nothing else starts. */
export function isBusy(phase: WizardPhase): boolean {
  return phase.kind === 'creating' || phase.kind === 'uploading'
}

/** The Create button's text while it works. */
export function progressLabel(phase: WizardPhase): string | null {
  if (phase.kind === 'creating') return 'Creating…'
  if (phase.kind === 'uploading') return phase.total === 0 ? 'Creating…' : `Adding ${phase.index + 1} of ${phase.total}…`
  return null
}

/** The new character this wizard is still working on after a partial create. */
export function handedOffId(phase: WizardPhase): string | null {
  return phase.kind === 'partial' || phase.kind === 'retrying' ? phase.characterId : null
}
