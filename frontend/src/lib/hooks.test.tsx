import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { parseJobEvent, useMcpStream } from './hooks'
import { fetchMcpJobs, fetchRuns } from './api'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  onmessage: ((event: { data: unknown }) => void) | null = null
  closed = false
  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  close() { this.closed = true }
  emit(data: unknown) { this.onmessage?.({ data }) }
}

const jobEvent = (source: string, id = 'j1') =>
  JSON.stringify({ type: 'job', job: { job_id: id, source, status: 'RUNNING' } })

describe('parseJobEvent', () => {
  test('returns the job for a job event', () => {
    expect(parseJobEvent(jobEvent('mcp'))).toMatchObject({ job_id: 'j1', source: 'mcp' })
  })
  test('ignores malformed, non-job and non-string payloads', () => {
    expect(parseJobEvent('not json')).toBeNull()
    expect(parseJobEvent(JSON.stringify({ type: 'ping' }))).toBeNull()
    expect(parseJobEvent(JSON.stringify({ type: 'job', job: null }))).toBeNull()
    expect(parseJobEvent(undefined)).toBeNull()
  })
})

describe('useMcpStream', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })
  afterEach(() => vi.unstubAllGlobals())

  test('subscribes to /api/jobs/events and fires only for MCP jobs', () => {
    const onEvent = vi.fn()
    renderHook(() => useMcpStream(true, onEvent))

    const es = FakeEventSource.instances[0]
    expect(es.url).toBe('/api/jobs/events')

    es.emit(jobEvent('pipeline', 'p1'))
    es.emit('garbage')
    es.emit(jobEvent('mcp', 'm1'))

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent.mock.calls[0][0]).toMatchObject({ job_id: 'm1', source: 'mcp' })
  })

  test('does not subscribe when disabled and closes the stream on unmount', () => {
    const { rerender, unmount } = renderHook(({ enabled }) => useMcpStream(enabled, () => {}), {
      initialProps: { enabled: false },
    })
    expect(FakeEventSource.instances).toHaveLength(0)

    rerender({ enabled: true })
    expect(FakeEventSource.instances).toHaveLength(1)

    unmount()
    expect(FakeEventSource.instances[0].closed).toBe(true)
  })
})

describe('fetchMcpJobs', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('reads MCP-sourced jobs from the job store', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, jobs: [{ job_id: 'a' }] })))
    vi.stubGlobal('fetch', fetchMock)

    const body = await fetchMcpJobs(20)

    expect(fetchMock).toHaveBeenCalledWith('/api/jobs?source=mcp&limit=20')
    expect(body.jobs).toEqual([{ job_id: 'a' }])
  })
})

describe('fetchRuns', () => {
  const urlOf = async (...args: Parameters<typeof fetchRuns>) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, runs: [], total: 0 })))
    vi.stubGlobal('fetch', fetchMock)
    await fetchRuns(...args)
    vi.unstubAllGlobals()
    return new URL(String(fetchMock.mock.calls[0][0]), 'http://x')
  }
  const A = `char_${'a'.repeat(32)}`
  const B = `char_${'b'.repeat(32)}`

  test('sends the character ids as one comma list, with the other filters unchanged', async () => {
    const url = await urlOf(25, 50, false, 'image', 'fox', true, 'mcp', `${A},${B}`)
    expect(url.searchParams.get('character')).toBe(`${A},${B}`)
    expect(url.searchParams.get('source')).toBe('mcp')
    expect(url.searchParams.get('media_kind')).toBe('image')
    expect(url.searchParams.get('q')).toBe('fox')
    expect(url.searchParams.get('offset')).toBe('50')
  })

  test('leaves the param out when there is no character filter', async () => {
    expect((await urlOf()).searchParams.has('character')).toBe(false)
    expect((await urlOf(25, 0, false, null, '', true, null, null)).searchParams.has('character')).toBe(false)
  })
})
