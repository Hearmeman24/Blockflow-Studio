/**
 * The generation block's run as one state: every transition of the reducer,
 * the job outcome -> run end mapping shared by a normal run and a resumed one,
 * and the run status -> pipeline block status table.
 */
import { describe, expect, it } from 'vitest'
import { BLOCK_STATUSES, GENERATION_RUN_STATUSES } from '@/lib/status'
import { GenerationRunError, type JobOutcome, type RunUpdate } from './run-generation'
import {
  EXECUTION_STATUS_BY_RUN,
  IDLE_RUN,
  RUN_END_PANEL,
  reduceRun,
  runEndOfError,
  runEndOfJob,
  runError,
  runHeaderText,
  type GenerationRunState,
  type RunEvent,
} from './generation-run-state'
import type { GenerationIssue } from './types'

const WARN: GenerationIssue = { code: 'unverified_behaviour', severity: 'warning', field: 'settings.x', message: 'May be rejected.' }
const ERR: GenerationIssue = { code: 'prompt_required', severity: 'error', field: 'prompt', message: 'Needs a prompt.' }

const run = (...events: RunEvent[]): GenerationRunState => events.reduce(reduceRun, IDLE_RUN)
const up = (update: RunUpdate): RunEvent => ({ type: 'update', update })

describe('reduceRun', () => {
  it('starts idle', () => {
    expect(IDLE_RUN).toEqual({ status: 'idle' })
  })

  it('validating starts a fresh run: no job id, no warnings, no error from the previous run', () => {
    const previous = run(
      up({ status: 'validating' }),
      up({ status: 'submitting', issues: [WARN] }),
      up({ status: 'queued', jobId: 'job-1' }),
      { type: 'end', end: { status: 'failed', error: 'Boom.' } },
    )
    expect(previous).toMatchObject({ status: 'failed', jobId: 'job-1', warnings: [WARN], error: 'Boom.' })
    expect(reduceRun(previous, up({ status: 'validating' }))).toEqual({
      status: 'validating', jobId: null, progress: null, message: null, warnings: [],
    })
  })

  it('start goes back to idle from any state', () => {
    for (const state of [
      run(up({ status: 'validating' })),
      run(up({ status: 'validating' }), { type: 'end', end: { status: 'completed' } }),
      run({ type: 'end', end: { status: 'failed', error: 'x' } }),
    ]) {
      expect(reduceRun(state, { type: 'start' })).toEqual(IDLE_RUN)
    }
  })

  it('active updates keep the job id and warnings, and take progress and message as sent', () => {
    const state = run(
      up({ status: 'validating' }),
      up({ status: 'submitting', issues: [WARN, ERR] }),
      up({ status: 'queued', jobId: 'job-1', progress: 0, message: 'Queued at Kie' }),
      up({ status: 'running', progress: 0.4 }),
    )
    // Only warnings are kept (errors stop the run instead).
    expect(state).toEqual({ status: 'running', jobId: 'job-1', progress: 0.4, message: null, warnings: [WARN] })
  })

  it('a resumed job starts from idle with its first poll update', () => {
    expect(run(up({ status: 'running', jobId: 'job-7', progress: 0.5, message: 'Rendering' })))
      .toEqual({ status: 'running', jobId: 'job-7', progress: 0.5, message: 'Rendering', warnings: [] })
  })

  it('ignores terminal statuses in updates: only the run end sets the outcome, with its error', () => {
    const active = run(up({ status: 'validating' }), up({ status: 'running', jobId: 'job-1' }))
    for (const status of ['completed', 'failed', 'cancelled', 'timed_out'] as const) {
      expect(reduceRun(active, up({ status, jobId: 'job-1' }))).toBe(active)
    }
  })

  it('ignores a late active update once the run has ended', () => {
    const ended = run(up({ status: 'validating' }), { type: 'end', end: { status: 'cancelled', error: null } })
    expect(reduceRun(ended, up({ status: 'running', progress: 0.9 }))).toBe(ended)
  })

  it.each([
    [{ status: 'completed' } as const, { status: 'completed', jobId: 'job-1', warnings: [WARN] }],
    [{ status: 'failed', error: 'Kie rejected it.' } as const, { status: 'failed', jobId: 'job-1', warnings: [WARN], error: 'Kie rejected it.' }],
    [{ status: 'timed_out', error: 'Too slow.' } as const, { status: 'timed_out', jobId: 'job-1', warnings: [WARN], error: 'Too slow.' }],
    [{ status: 'cancelled', error: null } as const, { status: 'cancelled', jobId: 'job-1', warnings: [WARN], error: null }],
    [{ status: 'cancelled', error: 'Cancelled in Artifacts.' } as const, { status: 'cancelled', jobId: 'job-1', warnings: [WARN], error: 'Cancelled in Artifacts.' }],
  ])('end %o keeps the job id and warnings; a completed run carries no error', (end, expected) => {
    const active = run(up({ status: 'validating' }), up({ status: 'submitting', issues: [WARN] }), up({ status: 'queued', jobId: 'job-1' }))
    const state = reduceRun(active, { type: 'end', end })
    expect(state).toEqual(expected)
    if (state.status === 'completed') expect(state).not.toHaveProperty('error')
  })

  it('an end before any update (validation refused, resume aborted at once) has no job id or warnings', () => {
    expect(run({ type: 'end', end: { status: 'failed', error: 'Needs a prompt.' } }))
      .toEqual({ status: 'failed', jobId: null, warnings: [], error: 'Needs a prompt.' })
  })
})

describe('runEndOfJob: one outcome mapping for a normal and a resumed run', () => {
  it.each<[Exclude<JobOutcome, { kind: 'output' }>, unknown]>([
    [{ kind: 'no_output', error: 'The job finished without a video.' }, { status: 'failed', error: 'The job finished without a video.' }],
    [{ kind: 'failed', error: 'Kie rejected it.', errorKind: 'content_rejected' }, { status: 'failed', error: 'Kie rejected it.' }],
    // A failed job whose error kind is a timeout reads as timed out, as it always did.
    [{ kind: 'failed', error: 'No answer in time.', errorKind: 'timeout' }, { status: 'timed_out', error: 'No answer in time.' }],
    [{ kind: 'cancelled', error: 'The generation was cancelled.' }, { status: 'cancelled', error: 'The generation was cancelled.' }],
    [{ kind: 'timed_out', error: 'The provider did not finish in time.', errorKind: 'timeout' }, { status: 'timed_out', error: 'The provider did not finish in time.' }],
    // TIMED_OUT is timed out whatever kind the error carries.
    [{ kind: 'timed_out', error: 'Late.', errorKind: 'provider_failure' }, { status: 'timed_out', error: 'Late.' }],
  ])('%o -> %o', (outcome, expected) => {
    expect(runEndOfJob(outcome)).toEqual(expected)
  })
})

describe('runEndOfError', () => {
  it('an AbortError is a cancel with no error text', () => {
    expect(runEndOfError(new DOMException('Generation cancelled', 'AbortError'))).toEqual({ status: 'cancelled', error: null })
  })

  it('a timeout from the server reads as timed out; anything else failed', () => {
    expect(runEndOfError(new GenerationRunError('Kie did not answer.', 'timeout'))).toEqual({ status: 'timed_out', error: 'Kie did not answer.' })
    expect(runEndOfError(new GenerationRunError('Add your Kie API key in Settings.', 'auth'))).toEqual({ status: 'failed', error: 'Add your Kie API key in Settings.' })
    expect(runEndOfError(new Error('Network down'))).toEqual({ status: 'failed', error: 'Network down' })
  })

  it('a throw with no message gets the generic text', () => {
    expect(runEndOfError(new Error(''))).toEqual({ status: 'failed', error: 'The generation failed. Try again.' })
    expect(runEndOfError('weird')).toEqual({ status: 'failed', error: 'The generation failed. Try again.' })
  })
})

describe('EXECUTION_STATUS_BY_RUN', () => {
  it('maps every run status to a pipeline block status', () => {
    expect(Object.keys(EXECUTION_STATUS_BY_RUN).sort()).toEqual(['idle', ...GENERATION_RUN_STATUSES].sort())
    for (const status of Object.values(EXECUTION_STATUS_BY_RUN)) expect(BLOCK_STATUSES).toContain(status)
    expect(EXECUTION_STATUS_BY_RUN).toEqual({
      idle: 'idle',
      validating: 'running', submitting: 'running', queued: 'running', running: 'running',
      completed: 'completed', failed: 'error', timed_out: 'error', cancelled: 'cancelled',
    })
  })
})

describe('display', () => {
  it('the header text is the status label, or the percentage while running with progress', () => {
    expect(runHeaderText({ status: 'running', progress: 0.456 })).toBe('Running 46%')
    expect(runHeaderText({ status: 'running', progress: null })).toBe('Running…')
    expect(runHeaderText({ status: 'queued', progress: 0.5 })).toBe('Queued')
    expect(runHeaderText({ status: 'validating' })).toBe('Checking the request…')
    expect(runHeaderText({ status: 'timed_out' })).toBe('Timed out')
  })

  it('the error panel keeps its exact titles and variants', () => {
    expect(RUN_END_PANEL).toEqual({
      failed: { title: 'The generation did not finish', variant: 'error' },
      timed_out: { title: 'The generation timed out', variant: 'error' },
      cancelled: { title: 'The generation was cancelled', variant: 'warning' },
    })
  })

  it('runError returns the ended run with an error text, else null', () => {
    expect(runError(IDLE_RUN)).toBeNull()
    expect(runError(run(up({ status: 'validating' })))).toBeNull()
    expect(runError(run({ type: 'end', end: { status: 'completed' } }))).toBeNull()
    expect(runError(run({ type: 'end', end: { status: 'cancelled', error: null } }))).toBeNull()
    expect(runError(run({ type: 'end', end: { status: 'timed_out', error: 'Late.' } }))).toEqual({ status: 'timed_out', error: 'Late.' })
  })
})
