import { describe, expect, test } from 'vitest'
import { LOOP_OFF, loopIteration, needsRestart, transitionLoop, type LoopEvent, type LoopState } from './loop-mode'

const looping = (iteration: number, awaiting: 'run' | 'restart'): LoopState => ({ kind: 'looping', iteration, awaiting })

describe('transitionLoop', () => {
  test('start turns the loop on at iteration 1, waiting for its run', () => {
    expect(transitionLoop(LOOP_OFF, { type: 'start' })).toEqual(looping(1, 'run'))
  })

  test('start while looping changes nothing', () => {
    const s = looping(3, 'run')
    expect(transitionLoop(s, { type: 'start' })).toBe(s)
  })

  test('a run that ends without an error waits for the restart; with an error the loop stops', () => {
    expect(transitionLoop(looping(2, 'run'), { type: 'runEnded', hadError: false })).toEqual(looping(2, 'restart'))
    expect(transitionLoop(looping(2, 'run'), { type: 'runEnded', hadError: true })).toEqual(LOOP_OFF)
  })

  test('restart counts the next iteration, only when a restart is due', () => {
    expect(transitionLoop(looping(2, 'restart'), { type: 'restart' })).toEqual(looping(3, 'run'))
    const s = looping(2, 'run')
    expect(transitionLoop(s, { type: 'restart' })).toBe(s)
  })

  test('a late runEnded while a restart is already due changes nothing', () => {
    const s = looping(2, 'restart')
    expect(transitionLoop(s, { type: 'runEnded', hadError: true })).toBe(s)
  })

  test('stop and a cancelled run turn the loop off from any looping state', () => {
    for (const s of [looping(1, 'run'), looping(4, 'restart')]) {
      expect(transitionLoop(s, { type: 'stop' })).toEqual(LOOP_OFF)
      expect(transitionLoop(s, { type: 'runCancelled' })).toEqual(LOOP_OFF)
    }
  })

  test('off ignores everything but start', () => {
    const events: LoopEvent[] = [{ type: 'runEnded', hadError: false }, { type: 'restart' }, { type: 'stop' }, { type: 'runCancelled' }]
    for (const e of events) expect(transitionLoop(LOOP_OFF, e)).toBe(LOOP_OFF)
  })
})

describe('loop views', () => {
  test('needsRestart only when a looping tab waits for its restart', () => {
    expect(needsRestart(LOOP_OFF)).toBe(false)
    expect(needsRestart(looping(1, 'run'))).toBe(false)
    expect(needsRestart(looping(1, 'restart'))).toBe(true)
  })

  test('loopIteration is the current iteration, or null when off', () => {
    expect(loopIteration(LOOP_OFF)).toBeNull()
    expect(loopIteration(looping(5, 'restart'))).toBe(5)
  })
})
