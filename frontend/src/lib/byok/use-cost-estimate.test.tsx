import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useCostEstimate } from './use-cost-estimate'
import type { GenerationRequest } from './types'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const ESTIMATE = {
  amount: 205, unit: 'credits', usd_equivalent: 1.025, basis: '5 s × 41 credits/s at 720p',
  source: 'provider-specs/kie/seedance-2-0.txt', as_of: '2026-11-15', confidence: 'listed',
}

function request(duration: number): GenerationRequest {
  return {
    provider: 'kie', model: 'seedance-2', mode: 'text_to_video',
    params: { prompt: 'a fox', duration, resolution: '720p' }, references: [],
  } as unknown as GenerationRequest
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterEach(() => vi.unstubAllGlobals())

describe('useCostEstimate', () => {
  it('posts the request to /api/generation/estimate and returns the estimate', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: true, estimate: ESTIMATE }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useCostEstimate(request(5), { debounceMs: 10 }))
    await waitFor(() => expect(result.current.estimate?.amount).toBe(205))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/generation/estimate')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual(request(5))
  })

  it('debounces rapid changes into one call for the latest request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: true, estimate: ESTIMATE }))
    vi.stubGlobal('fetch', fetchMock)
    const { rerender, result } = renderHook(({ d }) => useCostEstimate(request(d), { debounceMs: 40 }), {
      initialProps: { d: 4 },
    })
    rerender({ d: 5 })
    rerender({ d: 6 })
    await waitFor(() => expect(result.current.estimate).not.toBeNull())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).params.duration).toBe(6)
  })

  it('does not refetch when an equal request object is passed again', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: true, estimate: ESTIMATE }))
    vi.stubGlobal('fetch', fetchMock)
    const { rerender, result } = renderHook(({ d }) => useCostEstimate(request(d), { debounceMs: 10 }), {
      initialProps: { d: 5 },
    })
    await waitFor(() => expect(result.current.estimate).not.toBeNull())
    rerender({ d: 5 })
    await sleep(40)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('makes no call while the block is invalid or unconfigured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: true, estimate: ESTIMATE }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, rerender } = renderHook(
      ({ enabled, req }) => useCostEstimate(req, { enabled, debounceMs: 10 }),
      { initialProps: { enabled: false, req: request(5) as GenerationRequest | null } },
    )
    await sleep(40)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.estimate).toBeNull()
    rerender({ enabled: true, req: null })
    await sleep(40)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('clears the estimate as soon as the block becomes invalid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ok: true, estimate: ESTIMATE })))
    const { result, rerender } = renderHook(({ enabled }) => useCostEstimate(request(5), { enabled, debounceMs: 10 }), {
      initialProps: { enabled: true },
    })
    await waitFor(() => expect(result.current.estimate).not.toBeNull())
    rerender({ enabled: false })
    expect(result.current.estimate).toBeNull()
  })

  it('returns null for an unpriceable request and an error for a failed call', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ ok: true, estimate: null }))
      .mockResolvedValueOnce(json({ ok: false }, 500)))
    const { result, rerender } = renderHook(({ d }) => useCostEstimate(request(d), { debounceMs: 10 }), {
      initialProps: { d: 5 },
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.estimate).toBeNull()
    expect(result.current.error).toBeUndefined()
    rerender({ d: 6 })
    await waitFor(() => expect(result.current.error?.message).toMatch(/HTTP 500/))
    expect(result.current.estimate).toBeNull()
  })

  it('aborts the in-flight call when the request changes', async () => {
    const signals: AbortSignal[] = []
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal)
      return new Promise<Response>(() => {})
    }))
    const { rerender } = renderHook(({ d }) => useCostEstimate(request(d), { debounceMs: 5 }), {
      initialProps: { d: 5 },
    })
    await waitFor(() => expect(signals.length).toBe(1))
    rerender({ d: 6 })
    await waitFor(() => expect(signals.length).toBe(2))
    expect(signals[0].aborted).toBe(true)
  })

  it('returns the reason when there is no estimate, and clears it when disabled', async () => {
    const unavailable = { code: 'auto_duration', message: 'The length is set to auto. The actual charge will be shown after the run.' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ok: true, estimate: null, unavailable })))
    const { result, rerender } = renderHook(({ enabled }) => useCostEstimate(request(-1), { enabled, debounceMs: 10 }), {
      initialProps: { enabled: true },
    })
    await waitFor(() => expect(result.current.unavailable).toEqual(unavailable))
    expect(result.current.estimate).toBeNull()
    rerender({ enabled: false })
    expect(result.current.unavailable).toBeNull()
  })

  it('result is one state: disabled, loading, ready, unavailable or error', async () => {
    const unavailable = { code: 'auto_duration', message: 'Auto length.' }
    let respond: (r: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { respond = resolve })))
    const { result, rerender } = renderHook(({ enabled, d }) => useCostEstimate(request(d), { enabled, debounceMs: 5 }), {
      initialProps: { enabled: false, d: 5 },
    })
    expect(result.current.result).toEqual({ status: 'disabled' })
    rerender({ enabled: true, d: 5 })
    expect(result.current.result).toEqual({ status: 'loading', previous: null })
    await sleep(20)
    respond(json({ ok: true, estimate: ESTIMATE }))
    await waitFor(() => expect(result.current.result).toEqual({ status: 'ready', estimate: ESTIMATE }))
    rerender({ enabled: true, d: 6 })
    expect(result.current.result).toEqual({ status: 'loading', previous: { status: 'ready', estimate: ESTIMATE } })
    await sleep(20)
    respond(json({ ok: true, estimate: null, unavailable }))
    await waitFor(() => expect(result.current.result).toEqual({ status: 'unavailable', reason: unavailable }))
    rerender({ enabled: true, d: 7 })
    await sleep(20)
    respond(json({ ok: false }, 500))
    await waitFor(() => expect(result.current.result).toMatchObject({ status: 'error', error: expect.any(Error) }))
    // After an error nothing stale is offered while loading.
    rerender({ enabled: true, d: 8 })
    expect(result.current.result).toEqual({ status: 'loading', previous: null })
  })

  it('keeps the previous answer while loading only for the same provider, model and mode', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as GenerationRequest
      return Promise.resolve(json({ ok: true, estimate: { ...ESTIMATE, amount: body.model === 'seedance-2' ? 205 : 99 } }))
    }))
    const other = (model: string, provider = 'kie') => ({ ...request(5), model, provider }) as GenerationRequest
    const { result, rerender } = renderHook(({ req, enabled }) => useCostEstimate(req, { enabled, debounceMs: 30 }), {
      initialProps: { req: request(5), enabled: true },
    })
    await waitFor(() => expect(result.current.estimate?.amount).toBe(205))
    // Same model, another setting: the old price stays until the new one arrives.
    rerender({ req: request(6), enabled: true })
    expect(result.current.estimate?.amount).toBe(205)
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    // Another model: no price until its own arrives.
    rerender({ req: other('kling-4.0'), enabled: true })
    expect(result.current.estimate).toBeNull()
    expect(result.current.result).toEqual({ status: 'loading', previous: null })
    await waitFor(() => expect(result.current.estimate?.amount).toBe(99))
    // Another provider for the same model: also a different configuration.
    rerender({ req: other('kling-4.0', 'piapi'), enabled: true })
    expect(result.current.estimate).toBeNull()
  })

  it('after disabled -> enabled with another model, the previous model\'s price is not shown while loading', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as GenerationRequest
      return Promise.resolve(json({ ok: true, estimate: { ...ESTIMATE, amount: body.model === 'seedance-2' ? 205 : 99 } }))
    }))
    const { result, rerender } = renderHook(({ req, enabled }) => useCostEstimate(req, { enabled, debounceMs: 30 }), {
      initialProps: { req: request(5), enabled: true },
    })
    await waitFor(() => expect(result.current.estimate?.amount).toBe(205))
    rerender({ req: request(5), enabled: false })
    expect(result.current.estimate).toBeNull()
    rerender({ req: { ...request(5), model: 'kling-4.0' } as GenerationRequest, enabled: true })
    expect(result.current.estimate).toBeNull()
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.estimate?.amount).toBe(99))
  })

  it('ignores a malformed reason and never pairs a reason with an estimate', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ ok: true, estimate: null, unavailable: { code: 7 } }))
      .mockResolvedValueOnce(json({ ok: true, estimate: ESTIMATE, unavailable: { code: 'x', message: 'y' } })))
    const { result, rerender } = renderHook(({ d }) => useCostEstimate(request(d), { debounceMs: 10 }), {
      initialProps: { d: 5 },
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.unavailable).toBeNull()
    rerender({ d: 6 })
    await waitFor(() => expect(result.current.estimate?.amount).toBe(205))
    expect(result.current.unavailable).toBeNull()
  })
})
