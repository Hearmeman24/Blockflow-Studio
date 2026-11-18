import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { checkReferenceHealth, isBrokenStatus, type HealthTarget } from './reference-health'
import { useReferenceHealth } from './use-reference-health'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let fetchMock: ReturnType<typeof vi.fn>
const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)))

function answer(statusFor: (ref: { local?: string; url?: string }) => string) {
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const refs = JSON.parse(String(init.body)).references as Array<{ local?: string; url?: string }>
    return json({ ok: true, results: refs.map((r, index) => ({ index, status: statusFor(r), detail: `detail ${index}` })) })
  })
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('checkReferenceHealth', () => {
  it('posts the references and maps results by index', async () => {
    answer((r) => (r.local === '/outputs/gone.png' ? 'missing_local' : 'ok'))
    const out = await checkReferenceHealth([
      { kind: 'image', local: '/outputs/a.png' },
      { kind: 'video', local: '/outputs/gone.png', url: 'https://x/y.mp4' },
    ])
    expect(fetchMock).toHaveBeenCalledWith('/api/generation/check-references', expect.objectContaining({ method: 'POST' }))
    expect(bodies()[0]).toEqual({ references: [
      { kind: 'image', local: '/outputs/a.png' },
      { kind: 'video', local: '/outputs/gone.png', url: 'https://x/y.mp4' },
    ] })
    expect(out.map((r) => r.status)).toEqual(['ok', 'missing_local'])
  })

  it('throws when the route fails or the answer is malformed', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'boom' }, 500))
    await expect(checkReferenceHealth([{ kind: 'image', local: '/outputs/a.png' }])).rejects.toThrow(/failed/)
    fetchMock.mockResolvedValueOnce(json({ ok: true, results: [{ index: 3, status: 'ok' }] }))
    await expect(checkReferenceHealth([{ kind: 'image', local: '/outputs/a.png' }])).rejects.toThrow()
  })

  it('treats the four failure statuses as broken, and unchecked as not broken', () => {
    expect(['missing_local', 'expired', 'unreachable', 'malformed'].every((s) => isBrokenStatus(s as never))).toBe(true)
    expect(isBrokenStatus('unchecked')).toBe(false)
    expect(isBrokenStatus('ok')).toBe(false)
  })
})

describe('useReferenceHealth', () => {
  it('does not fetch while there are no references', async () => {
    const { result } = renderHook(() => useReferenceHealth([], 0))
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
  })

  it('checks once in one batch, then only new references', async () => {
    answer(() => 'ok')
    const a: HealthTarget = { kind: 'image', local: '/outputs/a.png' }
    const b: HealthTarget = { kind: 'image', local: '/outputs/b.png' }
    const { result, rerender } = renderHook(({ targets }) => useReferenceHealth(targets, 0), { initialProps: { targets: [a, b] } })
    await waitFor(() => expect(result.current.status).toBe('checked'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.current.get(a)?.status).toBe('ok')

    const c: HealthTarget = { kind: 'image', local: '/outputs/c.png' }
    rerender({ targets: [a, b, c] })
    await waitFor(() => expect(result.current.get(c)?.status).toBe('ok'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodies()[1].references).toEqual([{ kind: 'image', local: '/outputs/c.png' }])
  })

  it('debounces rapid changes into one request', async () => {
    answer(() => 'ok')
    const t = (n: number): HealthTarget => ({ kind: 'image', local: `/outputs/${n}.png` })
    const { result, rerender } = renderHook(({ targets }) => useReferenceHealth(targets, 30), { initialProps: { targets: [t(1)] } })
    rerender({ targets: [t(1), t(2)] })
    rerender({ targets: [t(1), t(2), t(3)] })
    await waitFor(() => expect(result.current.status).toBe('checked'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(bodies()[0].references).toHaveLength(3)
  })

  it('reports failed without results when the route is down, and re-check retries', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network'))
    const a: HealthTarget = { kind: 'image', local: '/outputs/a.png' }
    const { result } = renderHook(() => useReferenceHealth([a], 0))
    await waitFor(() => expect(result.current.status).toBe('failed'))
    expect(result.current.get(a)).toBeUndefined()

    answer(() => 'expired')
    act(() => result.current.recheck())
    await waitFor(() => expect(result.current.get(a)?.status).toBe('expired'))
    expect(result.current.status).toBe('checked')
  })
})
