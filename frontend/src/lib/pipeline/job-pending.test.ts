import { beforeEach, describe, expect, test } from 'vitest'
import {
  JOB_PENDING_SUFFIX,
  clearPendingJobRun,
  getPendingJobRunKey,
  hasAnyPendingJobRuns,
  hasPendingJobRunForBlock,
  isPendingJobRun,
  loadPendingJobRun,
  savePendingJobRun,
  type PendingJobRun,
} from './job-pending'

const pending: PendingJobRun = {
  kind: 'image',
  total: 2,
  submissionFailures: 0,
  submitted: [{ idx: 0, jobId: 'job-a' }, { idx: 1, jobId: 'job-b' }],
  startedAt: 1_700_000_000_000,
}

describe('job-pending', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  test('keys are block-scoped and use the generic job suffix', () => {
    expect(getPendingJobRunKey('b1')).toBe(`block_b1${JOB_PENDING_SUFFIX}`)
    expect(JOB_PENDING_SUFFIX).toBe('_pending_jobs_v1')
  })

  test('save then load round-trips the pending run', () => {
    savePendingJobRun('b1', pending)

    expect(JSON.parse(sessionStorage.getItem(getPendingJobRunKey('b1'))!)).toEqual(pending)
    expect(loadPendingJobRun('b1')).toEqual(pending)
    expect(hasPendingJobRunForBlock('b1')).toBe(true)
    expect(hasPendingJobRunForBlock('other')).toBe(false)
    expect(hasAnyPendingJobRuns()).toBe(true)
  })

  test('clear removes the stored run', () => {
    savePendingJobRun('b1', pending)
    clearPendingJobRun('b1')

    expect(sessionStorage.getItem(getPendingJobRunKey('b1'))).toBeNull()
    expect(loadPendingJobRun('b1')).toBeNull()
    expect(hasAnyPendingJobRuns()).toBe(false)
  })

  test('malformed or empty stored values are ignored', () => {
    sessionStorage.setItem(getPendingJobRunKey('bad'), '{not json')
    sessionStorage.setItem(getPendingJobRunKey('empty'), JSON.stringify({ ...pending, submitted: [] }))

    expect(loadPendingJobRun('bad')).toBeNull()
    expect(loadPendingJobRun('empty')).toBeNull()
    expect(loadPendingJobRun('missing')).toBeNull()
    expect(hasAnyPendingJobRuns()).toBe(false)
  })

  test('isPendingJobRun validates the shape', () => {
    expect(isPendingJobRun(pending)).toBe(true)
    expect(isPendingJobRun(null)).toBe(false)
    expect(isPendingJobRun({ ...pending, kind: ' ' })).toBe(false)
    expect(isPendingJobRun({ ...pending, submitted: [{ idx: 0, jobId: '' }] })).toBe(false)
    expect(isPendingJobRun({ ...pending, total: 'x' })).toBe(false)
  })
})
