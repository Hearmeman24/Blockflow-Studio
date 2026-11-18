import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'
import { ARTIFACTS_PAGE_SIZE } from '@/lib/api'
import type { RunEntry } from '@/lib/types'
import { characterRunsUrl, useCharacterRuns } from './use-character-runs'

const run = (id: string): RunEntry => ({ id, name: id, status: 'completed', created_at: '2026-01-01T00:00:00Z', block_results: [] } as unknown as RunEntry)
const runs = (from: number, n: number) => Array.from({ length: n }, (_, i) => run(`r${from + i}`))

let fetchMock: ReturnType<typeof vi.fn>
const urls = () => fetchMock.mock.calls.map(([u]) => String(u))
function page(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>{children}</SWRConfig>
)

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('characterRunsUrl', () => {
  it('asks for the runs of one character, one page at a time, hiding partial runs', () => {
    const url = new URL(characterRunsUrl('c 1/李', 50), 'http://x')
    expect(url.pathname).toBe('/api/runs')
    expect(Object.fromEntries(url.searchParams)).toEqual({ character: 'c 1/李', limit: String(ARTIFACTS_PAGE_SIZE), offset: '50', hide_partial: '1' })
  })
})

describe('useCharacterRuns', () => {
  it('loads the first page with the total, then loads more by offset until all are in', async () => {
    const total = ARTIFACTS_PAGE_SIZE + 3
    fetchMock.mockImplementation(async (u: string) => {
      const offset = Number(new URL(u, 'http://x').searchParams.get('offset'))
      const n = Math.min(ARTIFACTS_PAGE_SIZE, total - offset)
      return page({ ok: true, runs: runs(offset, n), total, limit: ARTIFACTS_PAGE_SIZE, offset })
    })
    const { result } = renderHook(() => useCharacterRuns('c1'), { wrapper })
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.runs).toHaveLength(ARTIFACTS_PAGE_SIZE))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.total).toBe(total)
    expect(result.current.hasMore).toBe(true)
    expect(urls()[0]).toBe(`/api/runs?character=c1&limit=${ARTIFACTS_PAGE_SIZE}&offset=0&hide_partial=1`)

    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.runs).toHaveLength(total))
    expect(result.current.runs.at(-1)?.id).toBe(`r${total - 1}`)
    expect(result.current.hasMore).toBe(false)
    expect(urls()).toContain(`/api/runs?character=c1&limit=${ARTIFACTS_PAGE_SIZE}&offset=${ARTIFACTS_PAGE_SIZE}&hide_partial=1`)
  })

  it('an empty character has no runs and nothing more to load', async () => {
    fetchMock.mockResolvedValue(page({ ok: true, runs: [], total: 0, limit: ARTIFACTS_PAGE_SIZE, offset: 0 }))
    const { result } = renderHook(() => useCharacterRuns('c1'), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.runs).toEqual([])
    expect(result.current.total).toBe(0)
    expect(result.current.hasMore).toBe(false)
    expect(result.current.error).toBeUndefined()
  })

  it('reports {ok:false} and HTTP failures as an error, and retry refetches', async () => {
    fetchMock
      .mockResolvedValueOnce(page({ ok: false, error: 'Run history is unavailable.' }, 500))
      .mockResolvedValueOnce(page({ ok: true, runs: runs(0, 2), total: 2, limit: ARTIFACTS_PAGE_SIZE, offset: 0 }))
    const { result } = renderHook(() => useCharacterRuns('c1'), { wrapper })
    await waitFor(() => expect(result.current.error?.message).toBe('Run history is unavailable.'))
    expect(result.current.isLoading).toBe(false)
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.runs).toHaveLength(2))
    expect(result.current.error).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a non-JSON body becomes a readable error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Bad gateway', { status: 502 }))
    const { result } = renderHook(() => useCharacterRuns('c1'), { wrapper })
    await waitFor(() => expect(result.current.error?.message).toMatch(/HTTP 502/))
  })

  it('fetches nothing without a character', async () => {
    const { result } = renderHook(() => useCharacterRuns(null), { wrapper })
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.runs).toEqual([])
    expect(result.current.hasMore).toBe(false)
  })

  it('switching characters loads the other character from its first page', async () => {
    fetchMock.mockImplementation(async (u: string) => {
      const id = new URL(u, 'http://x').searchParams.get('character')
      return page({ ok: true, runs: [run(`${id}-run`)], total: 1, limit: ARTIFACTS_PAGE_SIZE, offset: 0 })
    })
    const { result, rerender } = renderHook(({ id }) => useCharacterRuns(id), { wrapper, initialProps: { id: 'a' } })
    await waitFor(() => expect(result.current.runs.map((r) => r.id)).toEqual(['a-run']))
    rerender({ id: 'b' })
    await waitFor(() => expect(result.current.runs.map((r) => r.id)).toEqual(['b-run']))
  })
})

// ---- Staying current without a browser reload ----

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  emit(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent)
  }
  close() {
    this.closed = true
  }
}
const jobEvent = (status: string, job_id = 'j1') => ({ type: 'job', job: { job_id, source: 'pipeline', status } })
const openStreams = () => FakeEventSource.instances.filter((es) => !es.closed)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One cache for every mount, as in the app, where the page is left and opened again. */
function sharedCache() {
  const cache = new Map()
  function SharedCache({ children }: { children: ReactNode }) {
    return <SWRConfig value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}>{children}</SWRConfig>
  }
  return SharedCache
}

/** The server's runs, newest first; `server.ids` can change between requests. */
function serve(server: { ids: string[] }) {
  fetchMock.mockImplementation(async (u: string) => {
    const offset = Number(new URL(u, 'http://x').searchParams.get('offset'))
    const slice = server.ids.slice(offset, offset + ARTIFACTS_PAGE_SIZE)
    return page({ ok: true, runs: slice.map(run), total: server.ids.length, limit: ARTIFACTS_PAGE_SIZE, offset })
  })
}

describe('useCharacterRuns: opening the page again', () => {
  it('refetches the cached runs, so a run made meanwhile shows without a reload', async () => {
    const server = { ids: ['old'] }
    serve(server)
    const wrapper = sharedCache()
    const first = renderHook(() => useCharacterRuns('c1'), { wrapper })
    await waitFor(() => expect(first.result.current.runs.map((r) => r.id)).toEqual(['old']))
    first.unmount()

    server.ids = ['new', 'old']
    const before = fetchMock.mock.calls.length
    const second = renderHook(() => useCharacterRuns('c1'), { wrapper })
    // The cached run shows at once, then the fresh list replaces it.
    expect(second.result.current.runs.map((r) => r.id)).toEqual(['old'])
    expect(second.result.current.isLoading).toBe(false)
    await waitFor(() => expect(second.result.current.runs.map((r) => r.id)).toEqual(['new', 'old']))
    expect(second.result.current.total).toBe(2)
    expect(fetchMock.mock.calls.length).toBe(before + 1)
  })

  it('refetches the cached runs of a character that is selected again', async () => {
    const byCharacter: Record<string, string[]> = { a: ['a1'], b: ['b1'] }
    fetchMock.mockImplementation(async (u: string) => {
      const ids = byCharacter[new URL(u, 'http://x').searchParams.get('character') ?? ''] ?? []
      return page({ ok: true, runs: ids.map(run), total: ids.length, limit: ARTIFACTS_PAGE_SIZE, offset: 0 })
    })
    const { result, rerender } = renderHook(({ id }) => useCharacterRuns(id), { wrapper: sharedCache(), initialProps: { id: 'a' } })
    await waitFor(() => expect(result.current.runs.map((r) => r.id)).toEqual(['a1']))
    rerender({ id: 'b' })
    await waitFor(() => expect(result.current.runs.map((r) => r.id)).toEqual(['b1']))
    byCharacter.a = ['a2', 'a1']
    rerender({ id: 'a' })
    await waitFor(() => expect(result.current.runs.map((r) => r.id)).toEqual(['a2', 'a1']))
  })

  it('a first visit fetches the first page once, not twice', async () => {
    serve({ ids: ['only'] })
    const { result } = renderHook(() => useCharacterRuns('c1'), { wrapper: sharedCache() })
    await waitFor(() => expect(result.current.runs).toHaveLength(1))
    await sleep(30)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('useCharacterRuns: a job finishes while the page is open', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })
  const fast = { debounceMs: 10, settleMs: 60 }

  it('listens on the job events stream and refetches after a job completes', async () => {
    const server = { ids: ['old'] }
    serve(server)
    const { result } = renderHook(() => useCharacterRuns('c1', fast), { wrapper })
    await waitFor(() => expect(result.current.runs.map((r) => r.id)).toEqual(['old']))
    expect(FakeEventSource.instances.map((es) => es.url)).toEqual(['/api/jobs/events'])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    server.ids = ['new', 'old']
    act(() => FakeEventSource.instances[0].emit(jobEvent('COMPLETED')))
    await waitFor(() => expect(result.current.runs.map((r) => r.id)).toEqual(['new', 'old']))
    expect(result.current.total).toBe(2)
  })

  it('refetches once more later, for a run that is saved after its job finished', async () => {
    const server = { ids: ['old'] }
    serve(server)
    const { result } = renderHook(() => useCharacterRuns('c1', fast), { wrapper })
    await waitFor(() => expect(result.current.runs).toHaveLength(1))

    act(() => FakeEventSource.instances[0].emit(jobEvent('COMPLETED')))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(result.current.runs.map((r) => r.id)).toEqual(['old'])
    // The pipeline saves the run only now, after the first refetch.
    server.ids = ['late', 'old']
    await waitFor(() => expect(result.current.runs.map((r) => r.id)).toEqual(['late', 'old']))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await sleep(100)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a burst of finished jobs becomes one refetch and one later refetch', async () => {
    serve({ ids: ['old'] })
    const { result } = renderHook(() => useCharacterRuns('c1', fast), { wrapper })
    await waitFor(() => expect(result.current.runs).toHaveLength(1))
    act(() => {
      for (const id of ['j1', 'j2', 'j3']) FakeEventSource.instances[0].emit(jobEvent('COMPLETED', id))
    })
    await sleep(150)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('refetches every loaded page, not only the first', async () => {
    const server = { ids: Array.from({ length: ARTIFACTS_PAGE_SIZE + 2 }, (_, i) => `r${i}`) }
    serve(server)
    const { result } = renderHook(() => useCharacterRuns('c1', fast), { wrapper })
    await waitFor(() => expect(result.current.runs).toHaveLength(ARTIFACTS_PAGE_SIZE))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.runs).toHaveLength(ARTIFACTS_PAGE_SIZE + 2))

    server.ids = ['new', ...server.ids]
    act(() => FakeEventSource.instances[0].emit(jobEvent('COMPLETED')))
    await waitFor(() => expect(result.current.runs[0].id).toBe('new'))
    const ids = result.current.runs.map((r) => r.id)
    expect(ids).toHaveLength(ARTIFACTS_PAGE_SIZE + 3)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('ignores jobs that are still running or did not complete, and unreadable events', async () => {
    serve({ ids: ['old'] })
    const { result } = renderHook(() => useCharacterRuns('c1', fast), { wrapper })
    await waitFor(() => expect(result.current.runs).toHaveLength(1))
    act(() => {
      const es = FakeEventSource.instances[0]
      for (const status of ['QUEUED', 'RUNNING', 'FAILED', 'CANCELLED', 'TIMED_OUT']) es.emit(jobEvent(status))
      es.emit('not json')
      es.emit({ type: 'ping' })
      es.emit({ type: 'job', job: null })
    })
    await sleep(150)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not listen without a character, and stops listening when the page is left', async () => {
    serve({ ids: ['old'] })
    const none = renderHook(() => useCharacterRuns(null, fast), { wrapper })
    await sleep(20)
    expect(FakeEventSource.instances).toHaveLength(0)
    none.unmount()

    const { result, unmount } = renderHook(() => useCharacterRuns('c1', fast), { wrapper })
    await waitFor(() => expect(result.current.runs).toHaveLength(1))
    const es = FakeEventSource.instances[0]
    act(() => es.emit(jobEvent('COMPLETED')))
    unmount()
    expect(es.closed).toBe(true)
    expect(openStreams()).toHaveLength(0)
    await sleep(150)
    // The pending refetches were dropped with the page.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a finished job refetches the character that is selected now', async () => {
    const byCharacter: Record<string, string[]> = { a: ['a1'], b: ['b1'] }
    fetchMock.mockImplementation(async (u: string) => {
      const ids = byCharacter[new URL(u, 'http://x').searchParams.get('character') ?? ''] ?? []
      return page({ ok: true, runs: ids.map(run), total: ids.length, limit: ARTIFACTS_PAGE_SIZE, offset: 0 })
    })
    const { result, rerender } = renderHook(({ id }) => useCharacterRuns(id, fast), { wrapper, initialProps: { id: 'a' } })
    await waitFor(() => expect(result.current.runs.map((r) => r.id)).toEqual(['a1']))
    rerender({ id: 'b' })
    await waitFor(() => expect(result.current.runs.map((r) => r.id)).toEqual(['b1']))
    expect(openStreams()).toHaveLength(1)

    byCharacter.b = ['b2', 'b1']
    act(() => openStreams()[0].emit(jobEvent('COMPLETED')))
    await waitFor(() => expect(result.current.runs.map((r) => r.id)).toEqual(['b2', 'b1']))
  })

  it('works where EventSource does not exist', async () => {
    vi.stubGlobal('EventSource', undefined)
    serve({ ids: ['old'] })
    const { result } = renderHook(() => useCharacterRuns('c1', fast), { wrapper })
    await waitFor(() => expect(result.current.runs).toHaveLength(1))
  })
})

describe('useCharacterRuns: coming back to the window', () => {
  const focusWrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, focusThrottleInterval: 0, shouldRetryOnError: false }}>{children}</SWRConfig>
  )
  const setVisibility = (state: 'visible' | 'hidden') =>
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  afterEach(() => setVisibility('visible'))

  it('refetches the loaded runs on window focus and when the tab becomes visible', async () => {
    const server = { ids: ['old'] }
    serve(server)
    const { result } = renderHook(() => useCharacterRuns('c1', { focusThrottleMs: 0 }), { wrapper: focusWrapper })
    await waitFor(() => expect(result.current.runs.map((r) => r.id)).toEqual(['old']))

    server.ids = ['new', 'old']
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(result.current.runs.map((r) => r.id)).toEqual(['new', 'old']))

    server.ids = ['newer', 'new', 'old']
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(result.current.runs.map((r) => r.id)).toEqual(['newer', 'new', 'old']))
  })

  it('does not refetch while the tab is hidden, or twice in quick succession', async () => {
    serve({ ids: ['old'] })
    const { result } = renderHook(() => useCharacterRuns('c1', { focusThrottleMs: 60_000 }), { wrapper: focusWrapper })
    await waitFor(() => expect(result.current.runs).toHaveLength(1))

    setVisibility('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await sleep(30)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    setVisibility('visible')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('focus'))
    })
    await sleep(50)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops listening when the page is left', async () => {
    serve({ ids: ['old'] })
    const { result, unmount } = renderHook(() => useCharacterRuns('c1', { focusThrottleMs: 0 }), { wrapper: focusWrapper })
    await waitFor(() => expect(result.current.runs).toHaveLength(1))
    unmount()
    act(() => { window.dispatchEvent(new Event('focus')) })
    await sleep(30)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
