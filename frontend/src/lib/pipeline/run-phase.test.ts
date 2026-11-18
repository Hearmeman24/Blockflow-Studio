import { describe, expect, test } from 'vitest'
import {
  IDLE_PHASE,
  canStartRun,
  initialRunPhase,
  isCurrentRun,
  runtimeOf,
  tabRunOf,
  transitionRun,
  type RunEvent,
  type RunPhase,
} from './run-phase'

const controller = new AbortController()
const running = (runId = 1, blockId: string | null = null): RunPhase => ({ kind: 'running', runId, controller, blockId })
const cancelling = (runId = 1): RunPhase => ({ kind: 'cancelling', runId })
const resuming = (blockIds: string[] = ['gen'], blockId: string | null = 'gen'): RunPhase => ({ kind: 'resuming', blockIds, blockId })
const idle = (lastOutcome: Extract<RunPhase, { kind: 'idle' }>['lastOutcome'] = null): RunPhase => ({ kind: 'idle', lastOutcome })

const start = (runId: number): RunEvent => ({ type: 'start', runId, controller })

describe('transitionRun', () => {
  test('idle starts a run with no running block yet', () => {
    expect(transitionRun(idle('completed'), start(7))).toEqual(running(7, null))
  })

  test('a run in progress or a resume refuses a second start', () => {
    const r = running(1, 'a')
    expect(transitionRun(r, start(2))).toBe(r)
    const s = resuming()
    expect(transitionRun(s, start(2))).toBe(s)
  })

  test('a new run may start while a cancelled run is still unwinding', () => {
    expect(transitionRun(cancelling(1), start(2))).toEqual(running(2, null))
  })

  test('blockStarted moves the running block, only for the current run', () => {
    expect(transitionRun(running(1), { type: 'blockStarted', runId: 1, blockId: 'b' })).toEqual(running(1, 'b'))
    const r = running(2, 'x')
    expect(transitionRun(r, { type: 'blockStarted', runId: 1, blockId: 'b' })).toBe(r)
    const c = cancelling(1)
    expect(transitionRun(c, { type: 'blockStarted', runId: 1, blockId: 'b' })).toBe(c)
  })

  test('cancel: a run goes to cancelling, a resume ends cancelled, idle and cancelling stay', () => {
    expect(transitionRun(running(3, 'a'), { type: 'cancel' })).toEqual(cancelling(3))
    expect(transitionRun(resuming(), { type: 'cancel' })).toEqual(idle('cancelled'))
    const i = idle('completed')
    expect(transitionRun(i, { type: 'cancel' })).toBe(i)
    const c = cancelling(3)
    expect(transitionRun(c, { type: 'cancel' })).toBe(c)
  })

  test('finished ends the current run with its outcome', () => {
    expect(transitionRun(running(4), { type: 'finished', runId: 4, outcome: 'completed' })).toEqual(idle('completed'))
    expect(transitionRun(running(4), { type: 'finished', runId: 4, outcome: 'failed' })).toEqual(idle('failed'))
  })

  test('a cancelled run that finishes unwinding ends cancelled whatever it reports', () => {
    expect(transitionRun(cancelling(4), { type: 'finished', runId: 4, outcome: 'completed' })).toEqual(idle('cancelled'))
  })

  test('an older run finishing never touches a newer run, a resume or idle', () => {
    for (const phase of [running(5, 'a'), cancelling(5), resuming(), idle('failed')]) {
      expect(transitionRun(phase, { type: 'finished', runId: 4, outcome: 'completed' })).toBe(phase)
    }
  })

  test('resumeSettled ends a resume only', () => {
    expect(transitionRun(resuming(), { type: 'resumeSettled' })).toEqual(idle('resumed'))
    for (const phase of [running(1), cancelling(1), idle()]) {
      expect(transitionRun(phase, { type: 'resumeSettled' })).toBe(phase)
    }
  })
})

describe('derived views', () => {
  test('canStartRun is true only when idle or a cancelled run is unwinding', () => {
    expect([idle(), running(), cancelling(), resuming()].map(canStartRun)).toEqual([true, false, true, false])
  })

  test('isCurrentRun matches a running or cancelling run by id', () => {
    expect(isCurrentRun(running(2), 2)).toBe(true)
    expect(isCurrentRun(cancelling(2), 2)).toBe(true)
    expect(isCurrentRun(running(3), 2)).toBe(false)
    expect(isCurrentRun(idle(), 2)).toBe(false)
    expect(isCurrentRun(resuming(), 2)).toBe(false)
  })

  test('runtimeOf keeps the persisted runtime shape', () => {
    expect(runtimeOf(idle('completed'))).toEqual({ isRunning: false, runningBlockId: null })
    expect(runtimeOf(running(1, 'b'))).toEqual({ isRunning: true, runningBlockId: 'b' })
    expect(runtimeOf(cancelling())).toEqual({ isRunning: false, runningBlockId: null })
    expect(runtimeOf(resuming(['g'], 'g'))).toEqual({ isRunning: true, runningBlockId: 'g' })
  })

  test('tabRunOf: running and resuming show running, a finished run shows done, cancelling shows idle', () => {
    expect(tabRunOf(idle())).toEqual({ state: 'idle', outcome: null })
    expect(tabRunOf(idle('completed'))).toEqual({ state: 'done', outcome: 'completed' })
    expect(tabRunOf(idle('failed'))).toEqual({ state: 'done', outcome: 'failed' })
    expect(tabRunOf(idle('cancelled'))).toEqual({ state: 'done', outcome: 'cancelled' })
    expect(tabRunOf(idle('resumed'))).toEqual({ state: 'done', outcome: 'resumed' })
    expect(tabRunOf(running())).toEqual({ state: 'running', outcome: null })
    expect(tabRunOf(resuming())).toEqual({ state: 'running', outcome: null })
    expect(tabRunOf(cancelling())).toEqual({ state: 'idle', outcome: 'cancelled' })
  })

  test('initialRunPhase: a recovered running runtime resumes the blocks with pending jobs', () => {
    expect(initialRunPhase({ isRunning: false, runningBlockId: null }, [])).toEqual(IDLE_PHASE)
    expect(initialRunPhase({ isRunning: true, runningBlockId: 'g1' }, ['g1', 'g2'])).toEqual(resuming(['g1', 'g2'], 'g1'))
    expect(initialRunPhase({ isRunning: true, runningBlockId: null }, [])).toEqual(resuming([], null))
  })
})
