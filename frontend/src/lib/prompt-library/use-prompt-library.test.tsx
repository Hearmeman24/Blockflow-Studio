import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'
import { PROMPT_LIBRARY_URL, promptsOfType, type SavedPrompt } from './api'
import { usePromptLibrary } from './use-prompt-library'

const entry = (id: string, over: Partial<SavedPrompt> = {}): SavedPrompt => ({
  id, name: id, type: 'generation', content: `text ${id}`, created_at: '2026-01-01T00:00:00Z', ...over,
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** A fake backend holding the library in memory; `fail` overrides the next answer. */
function stubLibrary(initial: SavedPrompt[]) {
  let prompts = [...initial]
  const fail: { next: (() => Response | Promise<Response>) | null } = { next: null }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (fail.next) {
      const f = fail.next
      fail.next = null
      return f()
    }
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === PROMPT_LIBRARY_URL && method === 'GET') return json({ ok: true, prompts })
    if (url === PROMPT_LIBRARY_URL && method === 'POST') {
      const body = JSON.parse(String(init?.body))
      const created = entry(`new-${prompts.length}`, { name: body.name.trim(), type: body.type, content: body.content })
      prompts = [...prompts, created]
      return json({ ok: true, prompt: created })
    }
    const id = decodeURIComponent(url.slice(PROMPT_LIBRARY_URL.length + 1))
    prompts = prompts.filter((p) => p.id !== id)
    return json({ ok: true })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, fail }
}

function sharedCache() {
  const cache = new Map()
  return function SharedCache({ children }: { children: ReactNode }) {
    return <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>{children}</SWRConfig>
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('promptsOfType', () => {
  it('keeps only the asked type, in saved order', () => {
    const list = [entry('a'), entry('b', { type: 'system' }), entry('c'), entry('d', { type: 'user' })]
    expect(promptsOfType(list, 'generation').map((p) => p.id)).toEqual(['a', 'c'])
    expect(promptsOfType(list, 'system').map((p) => p.id)).toEqual(['b'])
    expect(promptsOfType(undefined, 'user')).toEqual([])
  })
})

describe('usePromptLibrary', () => {
  it('loads the list once and shares it between every box on the page', async () => {
    const { fetchMock } = stubLibrary([entry('a')])
    const wrapper = sharedCache()
    const { result } = renderHook(() => ({ one: usePromptLibrary(), two: usePromptLibrary() }), { wrapper })
    expect(result.current.one.isLoading).toBe(true)
    await waitFor(() => expect(result.current.two.prompts?.map((p) => p.id)).toEqual(['a']))
    expect(fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === 'GET')).toHaveLength(1)
  })

  it('a save in one consumer appears in the others without a reload', async () => {
    const { fetchMock } = stubLibrary([])
    const wrapper = sharedCache()
    const one = renderHook(() => usePromptLibrary(), { wrapper })
    const two = renderHook(() => usePromptLibrary(), { wrapper })
    await waitFor(() => expect(two.result.current.prompts).toEqual([]))

    let saved: SavedPrompt | undefined
    await act(async () => { saved = await one.result.current.save('  Fox 🦊 ', 'generation', 'a fox in the snow 🦊') })
    expect(saved?.name).toBe('Fox 🦊')
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(JSON.parse(String(post[1]?.body))).toEqual({ name: '  Fox 🦊 ', type: 'generation', content: 'a fox in the snow 🦊' })
    expect(two.result.current.prompts?.map((p) => p.content)).toEqual(['a fox in the snow 🦊'])

    await act(async () => { await two.result.current.remove(saved!.id) })
    expect(one.result.current.prompts).toEqual([])
    const del = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')!
    expect(String(del[0])).toBe(`${PROMPT_LIBRARY_URL}/${encodeURIComponent(saved!.id)}`)
  })

  it('a refused save (4xx) throws the server message and leaves the list as it was', async () => {
    const { fail } = stubLibrary([entry('a')])
    const { result } = renderHook(() => usePromptLibrary(), { wrapper: sharedCache() })
    await waitFor(() => expect(result.current.prompts).toHaveLength(1))
    fail.next = () => json({ ok: false, kind: 'duplicate', error: 'A saved generation prompt named "a" already exists.' }, 409)
    await expect(act(() => result.current.save('a', 'generation', 'x'))).rejects.toThrow('A saved generation prompt named "a" already exists.')
    expect(result.current.prompts?.map((p) => p.id)).toEqual(['a'])
  })

  it('a network failure on save or delete throws a readable message and keeps the list', async () => {
    const { fail } = stubLibrary([entry('a')])
    const { result } = renderHook(() => usePromptLibrary(), { wrapper: sharedCache() })
    await waitFor(() => expect(result.current.prompts).toHaveLength(1))
    fail.next = () => { throw new TypeError('Failed to fetch') }
    await expect(act(() => result.current.save('b', 'generation', 'x'))).rejects.toThrow(/Could not save the prompt: BlockFlow is not reachable/)
    fail.next = () => { throw new TypeError('Failed to fetch') }
    await expect(act(() => result.current.remove('a'))).rejects.toThrow(/Could not delete the prompt/)
    fail.next = () => json({ ok: false, kind: 'not_found', error: 'That saved prompt no longer exists.' }, 404)
    await expect(act(() => result.current.remove('a'))).rejects.toThrow('That saved prompt no longer exists.')
    expect(result.current.prompts?.map((p) => p.id)).toEqual(['a'])
  })

  it('a failed load is an error, not an empty list, and Retry loads again', async () => {
    const { fail, fetchMock } = stubLibrary([entry('a')])
    fail.next = () => json({ ok: false, kind: 'corrupt', error: 'The prompt library file (prompt_library.json) is not a valid list.' }, 500)
    const { result } = renderHook(() => usePromptLibrary(), { wrapper: sharedCache() })
    await waitFor(() => expect(result.current.error?.message).toMatch(/not a valid list/))
    expect(result.current.prompts).toBeUndefined()
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.prompts).toHaveLength(1))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a non-JSON answer becomes a readable error', async () => {
    const { fail } = stubLibrary([])
    fail.next = () => new Response('<html>Internal Server Error</html>', { status: 502 })
    const { result } = renderHook(() => usePromptLibrary(), { wrapper: sharedCache() })
    await waitFor(() => expect(result.current.error?.message).toMatch(/^Could not load saved prompts \(HTTP 502\)/))
  })
})
