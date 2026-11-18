import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { JobSnapshot } from '@/lib/types'
import { getPendingJobRunKey, loadPendingJobRun, savePendingJobRun, type PendingJobRun } from './job-pending'
import {
  JOB_SNAPSHOT_POLLING,
  abortPoll,
  fetchJobStatus,
  hasActivePoll,
  resumePollingRun,
  startNewPollingRun,
  subscribePolls,
} from './job-poller'

function snapshot(over: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    job_id: 'job-a',
    source: 'pipeline',
    provider: 'kie',
    model: 'seedream',
    mode: 'text_to_image',
    status: 'RUNNING',
    remote_job_id: null,
    remote_status: null,
    progress: null,
    message: null,
    error: null,
    outputs: [],
    request: {},
    created_at: 1,
    updated_at: 1,
    completed_at: null,
    cancel_requested: false,
    ...over,
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const pending: PendingJobRun = {
  kind: 'image',
  total: 1,
  submissionFailures: 0,
  submitted: [{ idx: 0, jobId: 'job-a' }],
  startedAt: Date.now(),
}

const getArtifact = (job: JobSnapshot) => job.outputs[0]?.url ?? null

describe('fetchJobStatus', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('GETs /api/jobs/{id} and returns the snapshot', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, job: snapshot({ status: 'COMPLETED' }) }))
    vi.stubGlobal('fetch', fetchMock)

    const job = await fetchJobStatus('job/a b')

    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job%2Fa%20b', expect.anything())
    expect(job.status).toBe('COMPLETED')
  })

  test('maps a 404 for an unknown id to a FAILED not_found snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { ok: false, error: 'Job not found' })))

    const job = await fetchJobStatus('gone')

    expect(job.job_id).toBe('gone')
    expect(job.status).toBe('FAILED')
    expect(job.error).toEqual({ kind: 'not_found', message: 'Job not found' })
  })

  test('throws on other HTTP errors so the poller retries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { ok: false })))
    await expect(fetchJobStatus('x')).rejects.toThrow('HTTP 500')
  })
})

describe('job polling', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('a new run persists its pending state, polls to completion, then clears it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, job: snapshot({ status: 'QUEUED' }) }))
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        job: snapshot({ status: 'COMPLETED', outputs: [{ kind: 'image', url: 'https://x/a.png' }] }),
      }))
    vi.stubGlobal('fetch', fetchMock)
    const onProgress = vi.fn()

    const promise = startNewPollingRun({
      blockId: 'b1',
      pending,
      pollIntervalMs: 1,
      ...JOB_SNAPSHOT_POLLING,
      getArtifact,
      onProgress,
    })
    expect(loadPendingJobRun('b1')).toEqual(pending)

    const result = await promise

    expect(result.artifacts).toEqual(['https://x/a.png'])
    expect(result.stats).toEqual({ total: 1, completed: 1, failed: 0, active: 0 })
    expect(result.errors).toEqual([])
    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-a', expect.anything())
    expect(sessionStorage.getItem(getPendingJobRunKey('b1'))).toBeNull()
  })

  test('resume after reload picks up the stored run and polls the job store', async () => {
    savePendingJobRun('b2', { ...pending, submitted: [{ idx: 0, jobId: 'job-r' }] })
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {
      ok: true,
      job: snapshot({ job_id: 'job-r', status: 'COMPLETED', outputs: [{ kind: 'video', url: 'https://x/r.mp4' }] }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await resumePollingRun({ blockId: 'b2', pollIntervalMs: 1, ...JOB_SNAPSHOT_POLLING, getArtifact })

    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-r', expect.anything())
    expect(result?.artifacts).toEqual(['https://x/r.mp4'])
    expect(loadPendingJobRun('b2')).toBeNull()
  })

  test('resume returns null when nothing is pending', () => {
    expect(resumePollingRun({ blockId: 'none', ...JOB_SNAPSHOT_POLLING, getArtifact })).toBeNull()
  })

  test('a job the store no longer knows ends the run as failed with its error', async () => {
    savePendingJobRun('b3', pending)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { ok: false, error: 'Job not found' })))

    const result = await resumePollingRun({ blockId: 'b3', pollIntervalMs: 1, ...JOB_SNAPSHOT_POLLING, getArtifact })

    expect(result?.stats).toEqual({ total: 1, completed: 0, failed: 1, active: 0 })
    expect(result?.errors).toEqual(['Job not found'])
    expect(result?.artifacts).toEqual([])
  })

  test('failed jobs report their error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {
      ok: true,
      job: snapshot({ status: 'FAILED', error: { kind: 'provider', message: 'Content policy' } }),
    })))

    const result = await startNewPollingRun({ blockId: 'b4', pending, pollIntervalMs: 1, ...JOB_SNAPSHOT_POLLING, getArtifact })

    expect(result.errors).toEqual(['Content policy'])
    expect(result.stats.failed).toBe(1)
  })

  test('abortPoll cancels an in-flight poll with an AbortError and clears pending state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => (
      jsonResponse(200, { ok: true, job: snapshot({ status: 'RUNNING' }) })
    )))

    const promise = startNewPollingRun({ blockId: 'b5', pending, pollIntervalMs: 50, ...JOB_SNAPSHOT_POLLING, getArtifact })
    await new Promise((r) => setTimeout(r, 5))
    abortPoll('b5')

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(loadPendingJobRun('b5')).toBeNull()
  })
})

describe('poll registry', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const record = (jobId: string): PendingJobRun => ({ ...pending, submitted: [{ idx: 0, jobId }] })
  const params = (jobId: string, pollIntervalMs = 1) => ({
    blockId: 'blk', pending: record(jobId), pollIntervalMs, ...JOB_SNAPSHOT_POLLING, getArtifact,
  })
  /** Answers by job id: each job completes with its own output after `pollsBefore` RUNNING answers. */
  function jobsAnswer(pollsBefore: Record<string, number>) {
    const seen = new Map<string, number>()
    return vi.fn(async (url: string) => {
      const jobId = decodeURIComponent(String(url).split('/').pop()!)
      const n = (seen.get(jobId) ?? 0) + 1
      seen.set(jobId, n)
      if (n <= (pollsBefore[jobId] ?? 0)) return jsonResponse(200, { ok: true, job: snapshot({ job_id: jobId, status: 'RUNNING' }) })
      return jsonResponse(200, {
        ok: true,
        job: snapshot({ job_id: jobId, status: 'COMPLETED', outputs: [{ kind: 'image', url: `https://x/${jobId}.png` }] }),
      })
    })
  }

  test('a different job for the same block replaces the poll instead of joining the old job', async () => {
    vi.stubGlobal('fetch', jobsAnswer({ 'job-old': 3, 'job-new': 0 }))

    const first = startNewPollingRun(params('job-old', 5))
    const firstOutcome = first.then(() => 'resolved', (e: unknown) => (e as Error).name)
    const second = startNewPollingRun(params('job-new'))

    expect(second).not.toBe(first)
    expect((await second).artifacts).toEqual(['https://x/job-new.png'])
    expect(await firstOutcome).toBe('AbortError')
    expect(hasActivePoll('blk')).toBe(false)
  })

  test('the same job joins the poll already in flight', async () => {
    const fetchMock = jobsAnswer({ 'job-a': 1 })
    vi.stubGlobal('fetch', fetchMock)
    savePendingJobRun('blk', record('job-a'))

    const first = resumePollingRun({ blockId: 'blk', pollIntervalMs: 1, ...JOB_SNAPSHOT_POLLING, getArtifact })
    const second = resumePollingRun({ blockId: 'blk', pollIntervalMs: 1, ...JOB_SNAPSHOT_POLLING, getArtifact })

    expect(second).toBe(first)
    expect((await first)?.artifacts).toEqual(['https://x/job-a.png'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('an aborted poll that settles late leaves a newer job\'s entry and pending record alone', async () => {
    let answerOld!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).endsWith('/job-old')) return new Promise<Response>((resolve) => { answerOld = resolve })
      return Promise.resolve(jsonResponse(200, { ok: true, job: snapshot({ job_id: 'job-new', status: 'RUNNING' }) }))
    }))

    const old = startNewPollingRun(params('job-old'))
    const oldOutcome = old.then(() => 'resolved', (e: unknown) => (e as Error).name)
    await new Promise((r) => setTimeout(r, 0))
    abortPoll('blk')
    const fresh = startNewPollingRun(params('job-new', 20))
    const freshOutcome = fresh.then(() => 'resolved', (e: unknown) => (e as Error).name)

    // The old poll's status request was in flight; it answers only now.
    answerOld(jsonResponse(200, { ok: true, job: snapshot({ job_id: 'job-old', status: 'RUNNING' }) }))
    expect(await oldOutcome).toBe('AbortError')

    expect(loadPendingJobRun('blk')).toEqual(record('job-new'))
    expect(hasActivePoll('blk')).toBe(true)
    // A resume after this joins the new job's poll, not a fresh one.
    expect(resumePollingRun({ blockId: 'blk', ...JOB_SNAPSHOT_POLLING, getArtifact })).toBe(fresh)

    abortPoll('blk')
    expect(await freshOutcome).toBe('AbortError')
    expect(loadPendingJobRun('blk')).toBeNull()
  })

  test('subscribers hear when a poll starts and when it ends', async () => {
    vi.stubGlobal('fetch', jobsAnswer({ 'job-a': 0 }))
    const seen: boolean[] = []
    const unsubscribe = subscribePolls(() => seen.push(hasActivePoll('blk')))

    await startNewPollingRun(params('job-a'))
    unsubscribe()
    await startNewPollingRun(params('job-b'))

    expect(seen).toEqual([true, false])
  })
})
