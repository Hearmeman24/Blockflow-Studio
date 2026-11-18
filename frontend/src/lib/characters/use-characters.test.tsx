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
