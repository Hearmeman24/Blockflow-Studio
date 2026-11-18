import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CATALOG_URL,
  cancelJob,
  fetchProviderCatalog,
  newClientRequestId,
  submitGeneration,
  validateGeneration,
} from './api'
import type { GenerationRequest } from './types'

const request: GenerationRequest = {
  provider: 'kie',
  model: 'seedance-2',
  mode: 'text_to_video',
  params: { prompt: 'a cat', duration: 5, settings: { nsfw_checker: false } },
  references: [],
}

function respond(status: number, body: unknown) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubFetch(...responses: Response[]) {
  const fn = vi.fn()
  for (const r of responses) fn.mockResolvedValueOnce(r)
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchProviderCatalog', () => {
  it('reads the catalog route', async () => {
    const fetchMock = stubFetch(respond(200, { providers: {}, models: [], modes: [] }))
    await expect(fetchProviderCatalog()).resolves.toEqual({ providers: {}, models: [], modes: [] })
    expect(fetchMock).toHaveBeenCalledWith(CATALOG_URL, expect.objectContaining({ method: 'GET' }))
    expect(CATALOG_URL).toBe('/api/providers/catalog')
  })

  it('rejects a malformed catalog instead of crashing the blocks', async () => {
    stubFetch(respond(200, { ok: true }))
    await expect(fetchProviderCatalog()).rejects.toThrow('The provider catalog response was malformed.')
  })

  it('throws a readable error on failure', async () => {
    stubFetch(respond(500, 'boom'))
    await expect(fetchProviderCatalog()).rejects.toThrow('Could not load the provider catalog (HTTP 500)')
  })
})

describe('validateGeneration', () => {
  it('posts the exact request and returns the issues', async () => {
    const issues = [{ code: 'prompt_required', severity: 'error', field: 'prompt', message: 'Needs a prompt' }]
    const fetchMock = stubFetch(respond(200, { ok: false, issues }))
    await expect(validateGeneration(request)).resolves.toEqual({ ok: false, issues })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/generation/validate')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual(request)
  })

  it('returns issues from a 422 body', async () => {
    const issues = [{ code: 'invalid_payload', severity: 'error', field: '', message: 'Bad' }]
    stubFetch(respond(422, { ok: false, error: 'Bad', kind: 'validation', issues }))
    await expect(validateGeneration(request)).resolves.toEqual({ ok: false, issues })
  })

  it('throws on a non-JSON response', async () => {
    stubFetch(new Response('<html>proxy error</html>', { status: 502 }))
    await expect(validateGeneration(request)).rejects.toThrow('Validation failed (HTTP 502)')
  })
})

describe('submitGeneration', () => {
  const body = { ...request, source: 'pipeline' as const, client_request_id: 'cid-1' }

  it('returns the job', async () => {
    const fetchMock = stubFetch(respond(200, { ok: true, job: { job_id: 'j1', status: 'QUEUED' } }))
    await expect(submitGeneration(body)).resolves.toEqual({ ok: true, job: { job_id: 'j1', status: 'QUEUED' } })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/generation/submit')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(body)
  })

  it.each([
    [422, 'validation', [{ code: 'x', severity: 'error', field: 'prompt', message: 'm' }]],
    [400, 'auth', []],
    [409, 'conflict', []],
  ])('returns a typed failure for HTTP %s', async (status, kind, issues) => {
    stubFetch(respond(status, { ok: false, error: `failed ${kind}`, kind, issues }))
    await expect(submitGeneration(body)).resolves.toEqual({ ok: false, error: `failed ${kind}`, kind, issues })
  })

  it('names unknown failures', async () => {
    stubFetch(respond(500, { detail: 'Internal Server Error' }))
    await expect(submitGeneration(body)).resolves.toEqual({
      ok: false,
      error: 'Submitting the generation failed (HTTP 500).',
      kind: 'unknown',
      issues: [],
    })
  })
})

describe('cancelJob', () => {
  it('posts to the job cancel route with an encoded id', async () => {
    const fetchMock = stubFetch(respond(200, { ok: true }))
    await expect(cancelJob('a/b')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/a%2Fb/cancel', { method: 'POST' })
  })

  it('reports failure without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(cancelJob('j1')).resolves.toBe(false)
  })
})

describe('newClientRequestId', () => {
  it('is unique per call', () => {
    const a = newClientRequestId()
    const b = newClientRequestId()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(8)
    expect(a.length).toBeLessThanOrEqual(64)
  })
})
