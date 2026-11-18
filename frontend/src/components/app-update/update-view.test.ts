/**
 * The update dialog's view: one state, changed only by events.
 */
import { describe, expect, test, vi } from 'vitest'
import type { UpdateProgress } from '@/lib/app-update/client'
import {
  CLOSED,
  canCloseProgress,
  progressHeadline,
  readRestart,
  updateViewReducer,
  type UpdateEvent,
  type UpdateView,
} from './update-view'

function progress(state: UpdateProgress['state'], overrides: Partial<UpdateProgress> = {}): UpdateProgress {
  return {
    state, step: null, steps: [], log_tail: [], error: null, message: null, manual: [],
    restart: { automatic: true, required: true, command: 'uv run app.py' },
    tag: 'v0.2.0', from_version: '0.1.15', to_version: '0.2.0', ...overrides,
  }
}

const run = (events: UpdateEvent[], from: UpdateView = CLOSED) => events.reduce(updateViewReducer, from)
const shown = (p: UpdateProgress): UpdateView => ({ kind: 'progress', progress: p, connection: 'ok', closing: { kind: 'idle' } })

describe('confirm', () => {
  test('opens idle, starts, and moves to progress on success', () => {
    expect(run([{ type: 'confirm_opened' }])).toEqual({ kind: 'confirm', phase: { kind: 'idle' } })
    expect(run([{ type: 'confirm_opened' }, { type: 'start_requested' }])).toEqual({ kind: 'confirm', phase: { kind: 'starting', blockers: [] } })
    const p = progress('running')
    expect(run([{ type: 'confirm_opened' }, { type: 'start_requested' }, { type: 'start_succeeded', progress: p }])).toEqual(shown(p))
  })

  test('only active jobs is a choice; any other blocker is not', () => {
    const jobs = [{ code: 'active_jobs', message: '2 jobs' }]
    const dirty = [{ code: 'dirty', message: 'changes' }, ...jobs]
    expect(run([{ type: 'confirm_opened' }, { type: 'start_requested' }, { type: 'start_blocked', blockers: jobs }]))
      .toEqual({ kind: 'confirm', phase: { kind: 'blocked_jobs', blockers: jobs } })
    expect(run([{ type: 'confirm_opened' }, { type: 'start_requested' }, { type: 'start_blocked', blockers: dirty }]))
      .toEqual({ kind: 'confirm', phase: { kind: 'blocked', blockers: dirty } })
    // "Update anyway" keeps the blockers on screen while it starts.
    expect(run([{ type: 'confirm_opened' }, { type: 'start_requested' }, { type: 'start_blocked', blockers: jobs }, { type: 'start_requested' }]))
      .toEqual({ kind: 'confirm', phase: { kind: 'starting', blockers: jobs } })
  })

  test('a failed start keeps the blockers and shows the error', () => {
    const jobs = [{ code: 'active_jobs', message: '2 jobs' }]
    expect(run([{ type: 'confirm_opened' }, { type: 'start_requested' }, { type: 'start_blocked', blockers: jobs },
      { type: 'start_requested' }, { type: 'start_failed', message: 'nope' }]))
      .toEqual({ kind: 'confirm', phase: { kind: 'error', message: 'nope', blockers: jobs } })
  })

  test('cancel closes, except while starting', () => {
    expect(run([{ type: 'confirm_opened' }, { type: 'confirm_cancelled' }])).toEqual(CLOSED)
    const starting = run([{ type: 'confirm_opened' }, { type: 'start_requested' }])
    expect(updateViewReducer(starting, { type: 'confirm_cancelled' })).toBe(starting)
  })

  test('a second start while starting is ignored', () => {
    const starting = run([{ type: 'confirm_opened' }, { type: 'start_requested' }])
    expect(updateViewReducer(starting, { type: 'start_requested' })).toBe(starting)
  })
})

describe('resume on mount', () => {
  test('shows a progress the page lost', () => {
    const p = progress('done')
    expect(run([{ type: 'progress_resumed', progress: p }])).toEqual(shown(p))
  })

  test('idle progress shows nothing', () => {
    expect(run([{ type: 'progress_resumed', progress: progress('idle') }])).toEqual(CLOSED)
  })

  test('never replaces a progress that a start has shown', () => {
    const running = progress('running')
    const started = run([{ type: 'confirm_opened' }, { type: 'start_requested' }, { type: 'start_succeeded', progress: running }])
    expect(updateViewReducer(started, { type: 'progress_resumed', progress: progress('done') })).toBe(started)
  })

  test('does not interrupt a start in flight', () => {
    const starting = run([{ type: 'confirm_opened' }, { type: 'start_requested' }])
    expect(updateViewReducer(starting, { type: 'progress_resumed', progress: progress('done') })).toBe(starting)
  })
})

describe('restart connection', () => {
  const restarting = shown(progress('restarting'))

  test('unreachable, then answering, then gave up', () => {
    expect(run([{ type: 'backend_unreachable' }], restarting)).toMatchObject({ connection: 'reconnecting' })
    expect(run([{ type: 'backend_unreachable' }, { type: 'backend_answered' }], restarting)).toMatchObject({ connection: 'ok' })
    expect(run([{ type: 'restart_timed_out' }], restarting)).toMatchObject({ connection: 'gave_up' })
  })

  test('giving up stays until the progress leaves restarting', () => {
    const gaveUp = run([{ type: 'restart_timed_out' }], restarting)
    expect(run([{ type: 'backend_answered' }], gaveUp)).toMatchObject({ connection: 'gave_up' })
    expect(run([{ type: 'progress_read', progress: progress('restarting') }], gaveUp)).toMatchObject({ connection: 'gave_up' })
    expect(run([{ type: 'progress_read', progress: progress('done') }], gaveUp)).toMatchObject({ connection: 'ok' })
  })

  test('a timeout outside restarting is ignored', () => {
    const running = shown(progress('running'))
    expect(updateViewReducer(running, { type: 'restart_timed_out' })).toBe(running)
  })

  test('progress reads only change an open progress view', () => {
    expect(updateViewReducer(CLOSED, { type: 'progress_read', progress: progress('running') })).toBe(CLOSED)
  })
})

describe('closing', () => {
  test('an active update cannot be closed until BlockFlow gave up', () => {
    const running = shown(progress('running'))
    expect(canCloseProgress(running)).toBe(false)
    expect(updateViewReducer(running, { type: 'close_requested', then: 'close' })).toBe(running)
    const gaveUp = run([{ type: 'restart_timed_out' }], shown(progress('restarting')))
    expect(canCloseProgress(gaveUp)).toBe(true)
  })

  test('closing waits for the acknowledgement; a failure stays open and can be retried', () => {
    const done = shown(progress('done'))
    const pending = run([{ type: 'close_requested', then: 'close' }], done)
    expect(pending).toMatchObject({ kind: 'progress', closing: { kind: 'pending', then: 'close' } })
    expect(canCloseProgress(pending)).toBe(false)
    const failed = run([{ type: 'close_failed', message: 'x' }], pending)
    expect(failed).toMatchObject({ kind: 'progress', closing: { kind: 'error', message: 'x', then: 'close' } })
    expect(canCloseProgress(failed)).toBe(true)
    expect(run([{ type: 'close_requested', then: 'reload' }, { type: 'close_done' }], failed)).toEqual(CLOSED)
  })
})

describe('progressHeadline', () => {
  const manual = { automatic: false, required: true, command: 'uv run app.py' }
  test.each([
    ['running', progress('running'), 'ok', 'Updating to v0.2.0…'],
    ['running, no tag', progress('running', { tag: null }), 'ok', 'Updating to the new version…'],
    ['restarting', progress('restarting'), 'ok', 'Restarting…'],
    ['restarting, unreachable', progress('restarting'), 'reconnecting', 'Restarting BlockFlow…'],
    ['restarting, gave up', progress('restarting'), 'gave_up', 'BlockFlow has not come back yet'],
    ['done, automatic restart', progress('done'), 'ok', 'Updated to v0.2.0'],
    ['done, manual restart', progress('done', { restart: manual }), 'ok', 'Updated, restart needed'],
    ['rolled back', progress('rolled_back'), 'ok', 'Update undone'],
    ['failed', progress('failed'), 'ok', 'Update failed'],
    ['idle', progress('idle'), 'ok', 'Update'],
  ] as const)('%s', (_name, p, connection, text) => {
    expect(progressHeadline({ kind: 'progress', progress: p, connection, closing: { kind: 'idle' } })).toBe(text)
  })
})

describe('readRestart', () => {
  test('no answer: unreachable, and progress is not read', async () => {
    const fetchProgress = vi.fn()
    expect(await readRestart({ fetchVersion: () => Promise.reject(new Error('down')), fetchProgress })).toEqual([{ type: 'backend_unreachable' }])
    expect(fetchProgress).not.toHaveBeenCalled()
  })

  test('the new version answers but the progress read fails: answered, not reconnecting', async () => {
    const events = await readRestart({
      fetchVersion: async () => ({ version: '0.2.0' }),
      fetchProgress: () => Promise.reject(new Error('busy')),
    })
    expect(events).toEqual([{ type: 'backend_answered' }])
  })

  test('the old version answers: the real progress is read', async () => {
    const p = progress('rolled_back')
    const events = await readRestart({ fetchVersion: async () => ({ version: '0.1.15' }), fetchProgress: async () => p })
    expect(events).toEqual([{ type: 'backend_answered' }, { type: 'progress_read', progress: p }])
  })
})
