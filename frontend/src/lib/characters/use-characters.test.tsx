import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'
import * as api from './api'
import { useCharacters } from './use-characters'
import type { Character } from './types'

vi.mock('./api', async (orig) => {
  const real = await orig<typeof import('./api')>()
  return {
    CHARACTERS_URL: real.CHARACTERS_URL,
    listCharacters: vi.fn(),
    createCharacter: vi.fn(),
    getCharacter: vi.fn(),
    updateCharacter: vi.fn(),
    deleteCharacter: vi.fn(),
    uploadCharacterMedia: vi.fn(),
    deleteCharacterMedia: vi.fn(),
    reorderCharacterMedia: vi.fn(),
  }
})

const character = (id: string, over: Partial<Character> = {}): Character => ({
  id, name: id, description: '', created_at: '', updated_at: '', default_face_id: null, default_audio_id: null, media: [], ...over,
})
const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
)

beforeEach(() => vi.clearAllMocks())

describe('useCharacters', () => {
  it('loads the list and exposes loading then data', async () => {
    vi.mocked(api.listCharacters).mockResolvedValue([character('a')])
    const { result } = renderHook(() => useCharacters(), { wrapper })
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.characters?.map((c) => c.id)).toEqual(['a']))
    expect(result.current.error).toBeUndefined()
  })

  it('reports an error and refetches on retry', async () => {
    vi.mocked(api.listCharacters).mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce([character('a')])
    const { result } = renderHook(() => useCharacters(), { wrapper })
    await waitFor(() => expect(result.current.error?.message).toBe('down'))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.characters).toHaveLength(1))
    expect(api.listCharacters).toHaveBeenCalledTimes(2)
  })

  it('puts created, updated and uploaded characters in the cache, and drops deleted ones', async () => {
    vi.mocked(api.listCharacters).mockResolvedValue([character('a')])
    const { result } = renderHook(() => useCharacters(), { wrapper })
    await waitFor(() => expect(result.current.characters).toHaveLength(1))

    vi.mocked(api.createCharacter).mockResolvedValue(character('b', { name: 'Zoë 李' }))
    const face = new File(['x'], 'face.png', { type: 'image/png' })
    await act(async () => { await result.current.create({ name: 'Zoë 李', face, meta: { width: 2, height: 3 } }) })
    expect(api.createCharacter).toHaveBeenCalledWith({ name: 'Zoë 李', face, meta: { width: 2, height: 3 } })
    expect(result.current.characters?.map((c) => c.id)).toEqual(['a', 'b'])

    vi.mocked(api.updateCharacter).mockResolvedValue(character('a', { name: 'Renamed' }))
    await act(async () => { await result.current.update('a', { name: 'Renamed' }) })
    expect(result.current.characters?.[0].name).toBe('Renamed')
    expect(api.updateCharacter).toHaveBeenCalledWith('a', { name: 'Renamed' })

    const withMedia = character('b', { media: [{ id: 'm', kind: 'image', label: 'x', local: '/x', size_bytes: 1, width: 1, height: 1, duration_s: null, position: 0, created_at: '' }] })
    vi.mocked(api.uploadCharacterMedia).mockResolvedValue({ media: withMedia.media[0], character: withMedia })
    const file = new File(['x'], 'x.png', { type: 'image/png' })
    await act(async () => { await result.current.uploadMedia('b', file, 'image', { width: 1, height: 1 }) })
    expect(api.uploadCharacterMedia).toHaveBeenCalledWith('b', file, 'image', { width: 1, height: 1 })
    expect(result.current.characters?.[1].media).toHaveLength(1)

    vi.mocked(api.deleteCharacterMedia).mockResolvedValue(character('b'))
    await act(async () => { await result.current.removeMedia('b', 'm') })
    expect(result.current.characters?.[1].media).toHaveLength(0)

    vi.mocked(api.reorderCharacterMedia).mockResolvedValue(character('b', { name: 'reordered' }))
    await act(async () => { await result.current.reorderMedia('b', 'image', ['m']) })
    expect(api.reorderCharacterMedia).toHaveBeenCalledWith('b', 'image', ['m'])
    expect(result.current.characters?.[1].name).toBe('reordered')

    vi.mocked(api.deleteCharacter).mockResolvedValue(undefined)
    await act(async () => { await result.current.remove('a') })
    expect(result.current.characters?.map((c) => c.id)).toEqual(['b'])
  })

  it('leaves the cache alone when a mutation fails', async () => {
    vi.mocked(api.listCharacters).mockResolvedValue([character('a')])
    const { result } = renderHook(() => useCharacters(), { wrapper })
    await waitFor(() => expect(result.current.characters).toHaveLength(1))
    vi.mocked(api.updateCharacter).mockRejectedValue(new Error('nope'))
    await act(async () => { await expect(result.current.update('a', { name: 'x' })).rejects.toThrow('nope') })
    expect(result.current.characters?.[0].name).toBe('a')
  })
})

describe('useCharacters: opening a page again', () => {
  it('refetches the cached list, so a change made elsewhere shows without a reload', async () => {
    const cache = new Map()
    const shared = ({ children }: { children: ReactNode }) => (
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>{children}</SWRConfig>
    )
    vi.mocked(api.listCharacters).mockResolvedValue([character('a')])
    const first = renderHook(() => useCharacters(), { wrapper: shared })
    await waitFor(() => expect(first.result.current.characters?.map((c) => c.id)).toEqual(['a']))
    first.unmount()

    vi.mocked(api.listCharacters).mockResolvedValue([character('a'), character('b')])
    const second = renderHook(() => useCharacters(), { wrapper: shared })
    expect(second.result.current.characters?.map((c) => c.id)).toEqual(['a'])
    await waitFor(() => expect(second.result.current.characters?.map((c) => c.id)).toEqual(['a', 'b']))
    expect(api.listCharacters).toHaveBeenCalledTimes(2)
  })
})

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const img = (id: string, position: number) =>
  ({ id, kind: 'image' as const, label: id, local: `/${id}`, size_bytes: 1, width: 1, height: 1, duration_s: null, position, created_at: '' })

describe('useCharacters: one character\'s changes apply in the order made', () => {
  async function ready(list: Character[]) {
    vi.mocked(api.listCharacters).mockResolvedValue(list)
    const hook = renderHook(() => useCharacters(), { wrapper })
    await waitFor(() => expect(hook.result.current.characters).toHaveLength(list.length))
    return hook
  }

  it('the second change waits for the first; the cache ends on the last request', async () => {
    const { result } = await ready([character('a')])
    const answers: ReturnType<typeof deferred<Character>>[] = []
    vi.mocked(api.updateCharacter).mockImplementation(() => {
      const d = deferred<Character>()
      answers.push(d)
      return d.promise
    })
    let first!: Promise<Character>
    let second!: Promise<Character>
    act(() => {
      first = result.current.update('a', { name: 'Ann' })
      second = result.current.update('a', { name: 'Anna' })
    })
    await act(async () => { await Promise.resolve() })
    expect(api.updateCharacter).toHaveBeenCalledTimes(1)
    await act(async () => { answers[0].resolve(character('a', { name: 'Ann' })); await first })
    await waitFor(() => expect(api.updateCharacter).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.updateCharacter).mock.calls[1]).toEqual(['a', { name: 'Anna' }])
    await act(async () => { answers[1].resolve(character('a', { name: 'Anna' })); await second })
    expect(result.current.characters?.[0].name).toBe('Anna')
  })

  it('a failed change does not stop the next one', async () => {
    const { result } = await ready([character('a')])
    vi.mocked(api.updateCharacter)
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(character('a', { name: 'Anna' }))
    let first!: Promise<Character>
    let second!: Promise<Character>
    act(() => {
      first = result.current.update('a', { name: 'Ann' })
      second = result.current.update('a', { name: 'Anna' })
    })
    await act(async () => { await expect(first).rejects.toThrow('nope'); await second })
    expect(result.current.characters?.[0].name).toBe('Anna')
  })

  it('different characters do not wait for each other', async () => {
    const { result } = await ready([character('a'), character('b')])
    const hang = deferred<Character>()
    vi.mocked(api.updateCharacter).mockImplementation((id) => (id === 'a' ? hang.promise : Promise.resolve(character('b', { name: 'B2' }))))
    act(() => { void result.current.update('a', { name: 'A2' }) })
    await act(async () => { await result.current.update('b', { name: 'B2' }) })
    expect(result.current.characters?.[1].name).toBe('B2')
    hang.resolve(character('a'))
  })

  it('moveMedia builds each order from the result of the move before it', async () => {
    const start = character('b', { media: [img('m1', 0), img('m2', 1), img('m3', 2)] })
    const { result } = await ready([start])
    const answers: ReturnType<typeof deferred<Character>>[] = []
    vi.mocked(api.reorderCharacterMedia).mockImplementation(() => {
      const d = deferred<Character>()
      answers.push(d)
      return d.promise
    })
    let first!: Promise<unknown>
    let second!: Promise<unknown>
    act(() => {
      // Two quick clicks on "Move m1 later" before the first answer.
      first = result.current.moveMedia('b', 'm1', 1)
      second = result.current.moveMedia('b', 'm1', 1)
    })
    await waitFor(() => expect(api.reorderCharacterMedia).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.reorderCharacterMedia).mock.calls[0]).toEqual(['b', 'image', ['m2', 'm1', 'm3']])
    await act(async () => {
      answers[0].resolve(character('b', { media: [img('m2', 0), img('m1', 1), img('m3', 2)] }))
      await first
    })
    await waitFor(() => expect(api.reorderCharacterMedia).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.reorderCharacterMedia).mock.calls[1]).toEqual(['b', 'image', ['m2', 'm3', 'm1']])
    await act(async () => {
      answers[1].resolve(character('b', { media: [img('m2', 0), img('m3', 1), img('m1', 2)] }))
      await second
    })
    expect(result.current.characters?.[0].media.map((m) => m.id)).toEqual(['m2', 'm3', 'm1'])
  })

  it('moveMedia at the end, or past a locked item, sends nothing', async () => {
    const start = character('b', { media: [img('m1', 0), img('m2', 1)] })
    const { result } = await ready([start])
    await act(async () => { await result.current.moveMedia('b', 'm2', 1) })
    await act(async () => { await result.current.moveMedia('b', 'm2', -1, ['m1']) })
    expect(api.reorderCharacterMedia).not.toHaveBeenCalled()
  })
})

