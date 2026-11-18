import { beforeEach, describe, expect, test } from 'vitest'
import { savePendingJobRun } from './job-pending'
import { normalizeRecoveredRuntime, type PersistedPipelineRuntime } from './pipeline-context'

const runningRuntime = (isRunning: boolean): PersistedPipelineRuntime => ({
  blockStates: [
    ['gen', { status: 'running', outputs: {} }],
    ['viewer', { status: 'idle', outputs: {} }],
  ],
  isRunning,
  runningBlockId: null,
})

describe('normalizeRecoveredRuntime after a reload', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  test('keeps the tab running when one of its blocks has pending jobs', () => {
    savePendingJobRun('gen', {
      kind: 'image',
      total: 1,
      submissionFailures: 0,
      submitted: [{ idx: 0, jobId: 'job-1' }],
      startedAt: Date.now(),
    })

    const recovered = normalizeRecoveredRuntime(runningRuntime(false), false)

    expect(recovered.isRunning).toBe(true)
    expect(recovered.runningBlockId).toBe('gen')
    expect(recovered.blockStates[0][1].status).toBe('running')
  })

  test('marks interrupted blocks idle when no jobs are pending', () => {
    const recovered = normalizeRecoveredRuntime(runningRuntime(true), false)

    expect(recovered.isRunning).toBe(false)
    expect(recovered.runningBlockId).toBeNull()
    expect(recovered.blockStates[0][1].status).toBe('idle')
    expect(recovered.blockStates[0][1].statusMessage).toMatch(/interrupted/i)
  })

  test('ignores pending jobs that belong to another tab\'s blocks', () => {
    savePendingJobRun('elsewhere', {
      kind: 'image',
      total: 1,
      submissionFailures: 0,
      submitted: [{ idx: 0, jobId: 'job-2' }],
      startedAt: Date.now(),
    })

    const recovered = normalizeRecoveredRuntime(runningRuntime(true), false)

    expect(recovered.isRunning).toBe(false)
  })
})
