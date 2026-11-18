import { describe, expect, it } from 'vitest'
import { EDITING, isBusy, progressLabel, wizardPhaseReducer, type WizardEvent, type WizardFailure, type WizardPhase } from './wizard-phase'

const failure = (label: string): WizardFailure => ({ item: { id: label, label } as WizardFailure['item'], error: 'too large' })
const run = (events: WizardEvent[], from: WizardPhase = EDITING) => events.reduce(wizardPhaseReducer, from)

describe('wizardPhaseReducer', () => {
  it('create, upload each file, then done', () => {
    expect(run([{ type: 'create_started' }])).toEqual({ kind: 'creating' })
    const uploading = run([{ type: 'create_started' }, { type: 'created', characterId: 'c', total: 2 }])
    expect(uploading).toEqual({ kind: 'uploading', characterId: 'c', index: 0, total: 2 })
    expect(run([{ type: 'upload_started', index: 1 }], uploading)).toEqual({ kind: 'uploading', characterId: 'c', index: 1, total: 2 })
    expect(run([{ type: 'uploads_finished', failures: [] }], uploading)).toEqual({ kind: 'done', characterId: 'c' })
  })

  it('a failed create goes back to editing with the message', () => {
    expect(run([{ type: 'create_started' }, { type: 'create_failed', message: 'nope' }])).toEqual({ kind: 'editing', error: 'nope' })
    // A new attempt clears it.
    expect(run([{ type: 'create_started' }], { kind: 'editing', error: 'nope' })).toEqual({ kind: 'creating' })
  })

  it('some failed files: partial, then retry keeps the ones still failing', () => {
    const a = failure('a.mp4')
    const b = failure('b.png')
    const partial = run([{ type: 'create_started' }, { type: 'created', characterId: 'c', total: 3 }, { type: 'uploads_finished', failures: [a, b] }])
    expect(partial).toEqual({ kind: 'partial', characterId: 'c', failures: [a, b], confirmingClose: false })
    const retrying = run([{ type: 'retry_started' }], partial)
    expect(retrying).toEqual({ kind: 'retrying', characterId: 'c', failures: [a, b] })
    expect(run([{ type: 'retry_finished', failures: [b] }], retrying)).toEqual({ kind: 'partial', characterId: 'c', failures: [b], confirmingClose: false })
    expect(run([{ type: 'retry_finished', failures: [] }], retrying)).toEqual(EDITING)
  })

  it('closing with failures asks first; keeping or confirming', () => {
    const partial: WizardPhase = { kind: 'partial', characterId: 'c', failures: [failure('a')], confirmingClose: false }
    const asking = run([{ type: 'close_requested' }], partial)
    expect(asking).toMatchObject({ kind: 'partial', confirmingClose: true })
    expect(run([{ type: 'close_cancelled' }], asking)).toEqual(partial)
  })

  it('nothing starts while busy', () => {
    const creating: WizardPhase = { kind: 'creating' }
    expect(wizardPhaseReducer(creating, { type: 'create_started' })).toBe(creating)
    const retrying: WizardPhase = { kind: 'retrying', characterId: 'c', failures: [] }
    expect(wizardPhaseReducer(retrying, { type: 'retry_started' })).toBe(retrying)
    expect(wizardPhaseReducer(retrying, { type: 'close_requested' })).toBe(retrying)
  })

  it('labels and busy', () => {
    expect(progressLabel({ kind: 'creating' })).toBe('Creating…')
    expect(progressLabel({ kind: 'uploading', characterId: 'c', index: 1, total: 3 })).toBe('Adding 2 of 3…')
    expect(progressLabel(EDITING)).toBeNull()
    expect(isBusy({ kind: 'creating' })).toBe(true)
    expect(isBusy({ kind: 'uploading', characterId: 'c', index: 0, total: 1 })).toBe(true)
    expect(isBusy(EDITING)).toBe(false)
  })
})
