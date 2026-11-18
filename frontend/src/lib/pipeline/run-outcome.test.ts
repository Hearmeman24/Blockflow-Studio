/**
 * How a run's end is saved: the run status, each block's saved status, and
 * whether a cancelled run is saved at all. The values are the ones the runner
 * has always written (see `pipeline-context.run-save.test.tsx`).
 */
import { describe, expect, it } from 'vitest'
import { BLOCK_STATUSES, RUN_STATUSES, SAVED_BLOCK_STATUSES } from '@/lib/status'
import { deriveRunStatus, savedBlockStatus, shouldSaveRun, type RunSummary } from './run-outcome'

const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
  errored: false,
  partialFailure: false,
  completedExecutions: 1,
  cancelled: false,
  ...over,
})

describe('deriveRunStatus', () => {
  it('is completed when nothing went wrong', () => {
    expect(deriveRunStatus(summary())).toBe('completed')
    expect(deriveRunStatus(summary({ completedExecutions: 0 }))).toBe('completed')
  })

  it('is failed when an error occurred and nothing completed', () => {
    expect(deriveRunStatus(summary({ errored: true, completedExecutions: 0 }))).toBe('failed')
  })

  it('is partial when an error occurred after something completed', () => {
    expect(deriveRunStatus(summary({ errored: true, completedExecutions: 1 }))).toBe('partial')
    expect(deriveRunStatus(summary({ errored: true, completedExecutions: 7 }))).toBe('partial')
  })

  it('is partial on a partial failure or a cancel without an error', () => {
    expect(deriveRunStatus(summary({ partialFailure: true }))).toBe('partial')
    expect(deriveRunStatus(summary({ cancelled: true }))).toBe('partial')
    expect(deriveRunStatus(summary({ cancelled: true, completedExecutions: 0 }))).toBe('partial')
    expect(deriveRunStatus(summary({ partialFailure: true, cancelled: true, completedExecutions: 0 }))).toBe('partial')
  })

  it('an error decides before a partial failure or a cancel', () => {
    for (const partialFailure of [false, true]) {
      for (const cancelled of [false, true]) {
        expect(deriveRunStatus(summary({ errored: true, completedExecutions: 0, partialFailure, cancelled }))).toBe('failed')
        expect(deriveRunStatus(summary({ errored: true, completedExecutions: 2, partialFailure, cancelled }))).toBe('partial')
      }
    }
  })

  it('every combination gives a saved run status', () => {
    for (const errored of [false, true]) {
      for (const partialFailure of [false, true]) {
        for (const cancelled of [false, true]) {
          for (const completedExecutions of [0, 1]) {
            expect(RUN_STATUSES).toContain(deriveRunStatus({ errored, partialFailure, cancelled, completedExecutions }))
          }
        }
      }
    }
  })
})

describe('savedBlockStatus', () => {
  it('saves a block a cancel left running as cancelled, and every other status as it is', () => {
    expect(savedBlockStatus(undefined)).toBe('idle')
    expect(savedBlockStatus('running')).toBe('cancelled')
    expect(savedBlockStatus('cancelled')).toBe('cancelled')
    for (const status of ['idle', 'completed', 'error', 'skipped'] as const) {
      expect(savedBlockStatus(status)).toBe(status)
    }
  })

  it('maps every live block status to a saved one', () => {
    for (const status of BLOCK_STATUSES) expect(SAVED_BLOCK_STATUSES).toContain(savedBlockStatus(status))
  })
})

describe('shouldSaveRun', () => {
  it('saves every run that was not cancelled', () => {
    expect(shouldSaveRun({ cancelled: false, generatedThisRun: false })).toBe(true)
    expect(shouldSaveRun({ cancelled: false, generatedThisRun: true })).toBe(true)
  })

  it('saves a cancelled run only when it finished a generation itself', () => {
    expect(shouldSaveRun({ cancelled: true, generatedThisRun: false })).toBe(false)
    expect(shouldSaveRun({ cancelled: true, generatedThisRun: true })).toBe(true)
  })
})
