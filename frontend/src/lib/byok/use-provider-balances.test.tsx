import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { SWRConfig, useSWRConfig } from 'swr'
import type { ReactNode } from 'react'
import { CATALOG_BOTH, CATALOG_KIE } from './__fixtures__'
import { SeenJobIds, useProviderBalances } from './use-provider-balances'
import type { ProviderBalance } from './cost'

function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }
  close() {
    this.closed = true
  }
}

const kie = (amount: number): ProviderBalance => ({
  provider: 'kie', label: 'Kie', configured: true, status: 'ok', amount, unit: 'credits',
  usd_equivalent: amount * 0.005, fetched_at: 1,
})
const pi: ProviderBalance = { provider: 'piapi', label: 'PiAPI', configured: false, status: 'not_configured', fetched_at: 1 }

/** fetch mock: the catalog from `catalogs`, balances from `amounts` (one per call). */
function routes(amounts: number[], catalogs: unknown[] = [CATALOG_KIE]) {
  const calls: string[] = []
  let b = 0
  let c = 0
  const fn = vi.fn(async (url: string) => {
    calls.push(url)
    if (url.startsWith('/api/providers/catalog')) return json(catalogs[Math.min(c++, catalogs.length - 1)])
    if (url.startsWith('/api/providers/balances')) {
      const amount = amounts[Math.min(b++, amounts.length - 1)]
      return json({ ok: true, balances: [kie(amount), pi] })
    }
    return json({}, 404)
  })
  return { fn, calls, balanceCalls: () => calls.filter((u) => u.startsWith('/api/providers/balances')) }
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => vi.unstubAllGlobals())

describe('useProviderBalances', () => {
  it('loads balances on mount', async () => {
    const r = routes([100])
    vi.stubGlobal('fetch', r.fn)
    const { result } = renderHook(() => useProviderBalances({ debounceMs: 10 }), { wrapper })
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.balances?.[0].amount).toBe(100))
    expect(result.current.isLoading).toBe(false)
    expect(r.balanceCalls()[0]).toBe('/api/providers/balances')
  })

  it('refresh() bypasses the server cache', async () => {
    const r = routes([100, 90])
    vi.stubGlobal('fetch', r.fn)
    const { result } = renderHook(() => useProviderBalances({ debounceMs: 10 }), { wrapper })
    await waitFor(() => expect(result.current.balances?.[0].amount).toBe(100))
    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(result.current.balances?.[0].amount).toBe(90))
    expect(r.balanceCalls().at(-1)).toBe('/api/providers/balances?refresh=1')
  })

  it('refreshes (debounced, once) after jobs reach a terminal state', async () => {
    const r = routes([100, 80])
    vi.stubGlobal('fetch', r.fn)
    const { result } = renderHook(() => useProviderBalances({ debounceMs: 30 }), { wrapper })
    await waitFor(() => expect(result.current.balances?.[0].amount).toBe(100))
    const es = FakeEventSource.instances[0]
    expect(es.url).toBe('/api/jobs/events')
    const before = r.balanceCalls().length
    act(() => {
      es.emit({ type: 'job', job: { job_id: 'a', status: 'RUNNING' } })
    })
    await new Promise((res) => setTimeout(res, 60))
    expect(r.balanceCalls().length).toBe(before)
    act(() => {
      es.emit({ type: 'job', job: { job_id: 'a', status: 'COMPLETED' } })
      es.emit({ type: 'job', job: { job_id: 'b', status: 'FAILED' } })
      es.emit('not json at all')
    })
    await waitFor(() => expect(result.current.balances?.[0].amount).toBe(80))
    expect(r.balanceCalls().length).toBe(before + 1)
    expect(r.balanceCalls().at(-1)).toBe('/api/providers/balances?refresh=1')
  })

  it('refreshes again a little later after a terminal job, for providers that settle late', async () => {
    const r = routes([100, 90, 70])
    vi.stubGlobal('fetch', r.fn)
    const { result } = renderHook(() => useProviderBalances({ debounceMs: 20, settleMs: 120 }), { wrapper })
    await waitFor(() => expect(result.current.balances?.[0].amount).toBe(100))
    const es = FakeEventSource.instances[0]
    const before = r.balanceCalls().length
    act(() => {
      // A batch of finished jobs: still one quick refresh and one settle refresh.
      es.emit({ type: 'job', job: { job_id: 'a', status: 'COMPLETED' } })
      es.emit({ type: 'job', job: { job_id: 'b', status: 'COMPLETED' } })
      es.emit({ type: 'job', job: { job_id: 'c', status: 'FAILED' } })
    })
    await waitFor(() => expect(result.current.balances?.[0].amount).toBe(90))
    expect(r.balanceCalls().length).toBe(before + 1)
    await waitFor(() => expect(result.current.balances?.[0].amount).toBe(70))
    expect(r.balanceCalls().length).toBe(before + 2)
    expect(r.balanceCalls().slice(before)).toEqual(['/api/providers/balances?refresh=1', '/api/providers/balances?refresh=1'])
    await new Promise((res) => setTimeout(res, 200))
    expect(r.balanceCalls().length).toBe(before + 2)
  })

  it('refreshes once when a job is first submitted (providers may reserve credits), not on progress', async () => {
    const r = routes([100, 95])
    vi.stubGlobal('fetch', r.fn)
    const { result } = renderHook(() => useProviderBalances({ debounceMs: 20, settleMs: 5000 }), { wrapper })
    await waitFor(() => expect(result.current.balances?.[0].amount).toBe(100))
    const es = FakeEventSource.instances[0]
    const before = r.balanceCalls().length
    act(() => {
      es.emit({ type: 'job', job: { job_id: 'n', status: 'QUEUED' } })
      es.emit({ type: 'job', job: { job_id: 'n', status: 'QUEUED' } })
      es.emit({ type: 'job', job: { job_id: 'n', status: 'RUNNING' } })
    })
    await waitFor(() => expect(result.current.balances?.[0].amount).toBe(95))
    await new Promise((res) => setTimeout(res, 80))
    expect(r.balanceCalls().slice(before)).toEqual(['/api/providers/balances?refresh=1'])
  })

  it('refreshes when Settings revalidates the catalog (a key was saved or removed)', async () => {
    const r = routes([100, 55], [CATALOG_KIE, CATALOG_BOTH])
    vi.stubGlobal('fetch', r.fn)
    const { result } = renderHook(() => ({ b: useProviderBalances({ debounceMs: 10 }), config: useSWRConfig() }), { wrapper })
    await waitFor(() => expect(result.current.b.balances?.[0].amount).toBe(100))
    await act(async () => {
      await result.current.config.mutate('/api/providers/catalog')
    })
    await waitFor(() => expect(result.current.b.balances?.[0].amount).toBe(55))
  })

  it('exposes a request failure as an error with a working retry', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/providers/catalog')) return json(CATALOG_KIE)
      n += 1
      return n === 1 ? json({ detail: 'boom' }, 500) : json({ ok: true, balances: [kie(7), pi] })
    }))
    const { result } = renderHook(() => useProviderBalances({ debounceMs: 10 }), { wrapper })
    await waitFor(() => expect(result.current.error?.message).toMatch(/HTTP 500/))
    await act(async () => {
      await result.current.refresh()
    })
    await waitFor(() => expect(result.current.balances?.[0].amount).toBe(7))
    expect(result.current.error).toBeUndefined()
  })

  it('rejects a malformed body', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.startsWith('/api/providers/catalog') ? json(CATALOG_KIE) : json({ ok: true, balances: 'nope' })))
    const { result } = renderHook(() => useProviderBalances({ debounceMs: 10 }), { wrapper })
    await waitFor(() => expect(result.current.error?.message).toMatch(/malformed/i))
  })

  it('closes the event stream on unmount', async () => {
    vi.stubGlobal('fetch', routes([1]).fn)
    const { unmount } = renderHook(() => useProviderBalances({ debounceMs: 10 }), { wrapper })
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1))
    unmount()
    expect(FakeEventSource.instances[0].closed).toBe(true)
  })
})

describe('SeenJobIds', () => {
  it('says a job id is new once, and forgets it when asked', () => {
    const seen = new SeenJobIds(10)
    expect(seen.add('a')).toBe(true)
    expect(seen.add('a')).toBe(false)
    seen.forget('a')
    expect(seen.size).toBe(0)
    expect(seen.add('a')).toBe(true)
  })

  it('never holds more than its cap, dropping the oldest first', () => {
    const seen = new SeenJobIds(3)
    for (const id of ['a', 'b', 'c', 'd', 'e']) seen.add(id)
    expect(seen.size).toBe(3)
    expect(seen.add('e')).toBe(false)
    expect(seen.add('c')).toBe(false)
    expect(seen.add('a')).toBe(true)
  })
})

it('forgets a submitted job once it finishes, so the memory does not grow', async () => {
  const r = routes([100, 95, 90, 85])
  vi.stubGlobal('fetch', r.fn)
  const { result } = renderHook(() => useProviderBalances({ debounceMs: 5, settleMs: 5 }), { wrapper })
  await waitFor(() => expect(result.current.balances?.[0].amount).toBe(100))
  const es = FakeEventSource.instances[0]
  const add = vi.spyOn(SeenJobIds.prototype, 'add')
  const forget = vi.spyOn(SeenJobIds.prototype, 'forget')
  act(() => {
    es.emit({ type: 'job', job: { job_id: 'n', status: 'QUEUED' } })
    es.emit({ type: 'job', job: { job_id: 'n', status: 'COMPLETED' } })
  })
  expect(add).toHaveBeenCalledWith('n')
  expect(forget).toHaveBeenCalledWith('n')
  add.mockRestore()
  forget.mockRestore()
})
