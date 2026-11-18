import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPendingJobRunKey, savePendingJobRun } from '@/lib/pipeline/job-pending'
import type { JobSnapshot } from '@/lib/types'
import {
  GenerationRunError,
  jobOutputValue,
  resumeGeneration,
  runGeneration,
  type RunUpdate,
} from './run-generation'
import type { GenerationRequest } from './types'

const request: GenerationRequest = {
  provider: 'kie',
  model: 'seedance-2',
  mode: 'text_to_video',
  params: { prompt: 'a cat', settings: {} },
  references: [],
}

function job(over: Partial<JobSnapshot>): JobSnapshot {
  return {
    job_id: 'job-1', source: 'pipeline', provider: 'kie', model: 'seedance-2', mode: 'text_to_video',
    status: 'QUEUED', remote_job_id: null, remote_status: null, progress: null, message: null, error: null,
    outputs: [], request: {}, created_at: 0, updated_at: 0, completed_at: null, cancel_requested: false, ...over,
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

interface Routes {
  validate?: () => Response
  submit?: () => Response
  jobs?: JobSnapshot[]
}

function stubRoutes(routes: Routes) {
  const statuses = [...(routes.jobs ?? [])]
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/generation/validate') return routes.validate?.() ?? json({ ok: true, issues: [] })
    if (url === '/api/generation/submit') return routes.submit?.() ?? json({ ok: true, job: job({}) })
    if (url.endsWith('/cancel') && init?.method === 'POST') return json({ ok: true, job: job({ cancel_requested: true }) })
    if (url.startsWith('/api/jobs/')) {
      const next = statuses.length > 1 ? statuses.shift()! : statuses[0]
      return json({ ok: true, job: next })
    }
    return json({ ok: false }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const calls = (fetchMock: ReturnType<typeof stubRoutes>, url: string) =>
  fetchMock.mock.calls.filter(([u]) => String(u) === url)

beforeEach(() => sessionStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('runGeneration', () => {
  it('validates, submits once with a fresh client request id, and polls to completion', async () => {
    const done = job({ status: 'COMPLETED', outputs: [{ kind: 'video', url: 'https://cdn/x.mp4', local_url: '/outputs/x.mp4' }] })
    const fetchMock = stubRoutes({ jobs: [job({ status: 'RUNNING', progress: 0.4, message: 'Rendering' }), done] })
    const updates: RunUpdate[] = []
    const result = await runGeneration({
      blockId: 'b1', request, signal: new AbortController().signal, pollIntervalMs: 1, onUpdate: (u) => updates.push(u),
    })
    expect(result.status).toBe('COMPLETED')
    expect(JSON.parse(calls(fetchMock, '/api/generation/validate')[0][1]!.body as string)).toEqual(request)
    const submitted = JSON.parse(calls(fetchMock, '/api/generation/submit')[0][1]!.body as string)
    expect(submitted).toEqual({ ...request, source: 'pipeline', client_request_id: expect.stringMatching(/^blk-/) })
    expect(updates.map((u) => u.status)).toEqual(['validating', 'submitting', 'queued', 'running', 'completed'])
    expect(updates[3]).toMatchObject({ progress: 0.4, message: 'Rendering', jobId: 'job-1' })
    expect(sessionStorage.getItem(getPendingJobRunKey('b1'))).toBeNull()
  })

  it('uses a new client request id for every run', async () => {
    const fetchMock = stubRoutes({ jobs: [job({ status: 'COMPLETED' })] })
    const signal = new AbortController().signal
    await runGeneration({ blockId: 'b1', request, signal, pollIntervalMs: 1 })
    await runGeneration({ blockId: 'b1', request, signal, pollIntervalMs: 1 })
    const ids = calls(fetchMock, '/api/generation/submit').map(([, init]) => JSON.parse(init!.body as string).client_request_id)
    expect(new Set(ids).size).toBe(2)
  })

  it('stops before submitting when validation has errors', async () => {
    const issues = [{ code: 'prompt_required', severity: 'error', field: 'prompt', message: 'Seedance 2 on Kie needs a prompt.' }]
    const fetchMock = stubRoutes({ validate: () => json({ ok: false, issues }) })
    const error = await runGeneration({ blockId: 'b1', request, signal: new AbortController().signal }).catch((e) => e)
    expect(error).toBeInstanceOf(GenerationRunError)
    expect(error.issues).toEqual(issues)
    expect(error.message).toBe('Seedance 2 on Kie needs a prompt.')
    expect(calls(fetchMock, '/api/generation/submit')).toHaveLength(0)
  })

  it('passes warnings through and still submits', async () => {
    const issues = [{ code: 'unverified_behaviour', severity: 'warning', field: 'settings.real_people', message: 'May be rejected.' }]
    const fetchMock = stubRoutes({ validate: () => json({ ok: true, issues }), jobs: [job({ status: 'COMPLETED' })] })
    const updates: RunUpdate[] = []
    await runGeneration({ blockId: 'b1', request, signal: new AbortController().signal, pollIntervalMs: 1, onUpdate: (u) => updates.push(u) })
    expect(calls(fetchMock, '/api/generation/submit')).toHaveLength(1)
    expect(updates.find((u) => u.status === 'submitting')?.issues).toEqual(issues)
  })

  it('surfaces a missing key from submit as an auth error', async () => {
    stubRoutes({ submit: () => json({ ok: false, error: 'Add your Kie API key in Settings.', kind: 'auth' }, 400) })
    const error = await runGeneration({ blockId: 'b1', request, signal: new AbortController().signal }).catch((e) => e)
    expect(error).toBeInstanceOf(GenerationRunError)
    expect(error.kind).toBe('auth')
    expect(error.message).toBe('Add your Kie API key in Settings.')
  })

  it('returns submit-time validation issues', async () => {
    const issues = [{ code: 'too_many_references', severity: 'error', field: 'references.image', message: 'Too many.' }]
    stubRoutes({ submit: () => json({ ok: false, error: 'Fix the request.', kind: 'validation', issues }, 422) })
    const error = await runGeneration({ blockId: 'b1', request, signal: new AbortController().signal }).catch((e) => e)
    expect(error.issues).toEqual(issues)
  })

  it('cancels the job when the run is aborted', async () => {
    const fetchMock = stubRoutes({ jobs: [job({ status: 'RUNNING' })] })
    const controller = new AbortController()
    const updates: RunUpdate[] = []
    const promise = runGeneration({ blockId: 'b1', request, signal: controller.signal, pollIntervalMs: 5, onUpdate: (u) => updates.push(u) })
    await vi.waitFor(() => expect(updates.some((u) => u.status === 'running')).toBe(true))
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(calls(fetchMock, '/api/jobs/job-1/cancel')).toHaveLength(1))
  })

  it('cancels a job whose submit returns after the abort', async () => {
    const controller = new AbortController()
    const fetchMock = stubRoutes({
      submit: () => {
        controller.abort()
        return json({ ok: true, job: job({}) })
      },
      jobs: [job({ status: 'RUNNING' })],
    })
    await expect(runGeneration({ blockId: 'b1', request, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls(fetchMock, '/api/jobs/job-1/cancel')).toHaveLength(1)
  })
})

describe('resumeGeneration', () => {
  it('resumes polling a job saved before a reload', async () => {
    savePendingJobRun('b2', { kind: 'generation', total: 1, submissionFailures: 0, submitted: [{ idx: 0, jobId: 'job-9' }], startedAt: Date.now() })
    const fetchMock = stubRoutes({ jobs: [job({ job_id: 'job-9', status: 'COMPLETED' })] })
    const resumed = resumeGeneration({ blockId: 'b2', pollIntervalMs: 1 })
    expect(resumed).not.toBeNull()
    await expect(resumed!.promise).resolves.toMatchObject({ job_id: 'job-9', status: 'COMPLETED' })
    expect(resumed!.jobId).toBe('job-9')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/jobs/job-9')
  })

  it('returns null when nothing is pending', () => {
    expect(resumeGeneration({ blockId: 'none' })).toBeNull()
  })
})

describe('jobOutputValue', () => {
  it('builds a video ref from the local copy, keeping the remote URL', () => {
    const done = job({ status: 'COMPLETED', outputs: [{ kind: 'video', url: 'https://cdn/x.mp4', local_url: '/outputs/x.mp4' }] })
    expect(jobOutputValue(done, 'video')).toEqual({
      kind: 'video-ref', local: '/outputs/x.mp4', url: 'https://cdn/x.mp4',
      meta: { job_id: done.job_id, provider: done.provider, model: done.model, cost: null },
    })
  })

  it('falls back to the remote URL and returns an array for several images', () => {
    const done = job({
      status: 'COMPLETED',
      outputs: [{ kind: 'image', url: 'https://cdn/a.png' }, { kind: 'image', url: 'https://cdn/b.png', local_url: '/outputs/b.png' }],
      cost: { amount: 8, unit: 'credits', usd_equivalent: 0.04 },
    })
    const meta = { job_id: done.job_id, provider: done.provider, model: done.model, cost: { amount: 8, unit: 'credits', usd_equivalent: 0.04 } }
    expect(jobOutputValue(done, 'image')).toEqual([
      { kind: 'image-ref', local: 'https://cdn/a.png', url: 'https://cdn/a.png', meta },
      { kind: 'image-ref', local: '/outputs/b.png', url: 'https://cdn/b.png', meta },
    ])
  })

  it('carries the price check with the cost, for the viewers', () => {
    const price_check = {
      expected: { amount: 41, unit: 'credits' }, actual: { amount: 50, unit: 'credits' }, source: 'ledger' as const,
      differs: true, checked_at: '2026-11-15T10:00:00Z', report_url: null,
    }
    const done = job({
      status: 'COMPLETED', outputs: [{ kind: 'image', url: 'https://cdn/a.png' }],
      cost: { amount: 50, unit: 'credits', usd_equivalent: 0.25 }, price_check,
    })
    expect((jobOutputValue(done, 'image') as { meta: unknown }).meta).toEqual({
      job_id: done.job_id, provider: done.provider, model: done.model,
      cost: { amount: 50, unit: 'credits', usd_equivalent: 0.25 }, price_check,
    })
  })

  it('shows the job error as-is', () => {
    expect(() => jobOutputValue(job({ status: 'FAILED', error: { kind: 'content_policy', message: 'Kie rejected the prompt.' } }), 'video'))
      .toThrow('Kie rejected the prompt.')
    expect(() => jobOutputValue(job({ status: 'TIMED_OUT' }), 'video')).toThrow('The provider did not finish in time.')
    expect(() => jobOutputValue(job({ status: 'FAILED' }), 'video')).toThrow('The generation failed. Try again, or check the provider status.')
    expect(() => jobOutputValue(job({ status: 'CANCELLED' }), 'video')).toThrow('The generation was cancelled.')
  })

  it('fails when a completed job has no output of the kind', () => {
    expect(() => jobOutputValue(job({ status: 'COMPLETED', outputs: [] }), 'image')).toThrow('The job finished without an image.')
  })
})
