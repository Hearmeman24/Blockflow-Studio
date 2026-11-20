import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHARACTERS_URL,
  createCharacter,
  deleteCharacter,
  deleteCharacterMedia,
  getCharacter,
  listCharacters,
  reorderCharacterMedia,
  updateCharacter,
  uploadCharacterMedia,
} from './api'
import type { Character } from './types'

const character = (over: Partial<Character> = {}): Character => ({
  id: 'c1',
  name: 'Mia',
  description: '',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  default_face_id: null,
  default_audio_id: null,
  media: [],
  ...over,
})

let fetchMock: ReturnType<typeof vi.fn>
function respond(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }))
}
const call = (i = 0) => fetchMock.mock.calls[i] as [string, RequestInit]

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('characters api', () => {
  it('exports the SWR key', () => {
    expect(CHARACTERS_URL).toBe('/api/characters')
  })

  it('lists characters', async () => {
    respond({ ok: true, characters: [character()] })
    const list = await listCharacters()
    expect(list.map((c) => c.id)).toEqual(['c1'])
    expect(call()[0]).toBe('/api/characters')
    expect(call()[1]?.method ?? 'GET').toBe('GET')
  })

  it('creates a character from a name and a face image: raw bytes to the direct backend URL', async () => {
    const created = character({ name: 'Zoë "Ångström" 李 & co', default_face_id: 'm1' })
    respond({ ok: true, character: created })
    const face = new File([new Uint8Array([9, 8, 7])], 'Zoë 李 face #1.png', { type: 'image/png' })
    const c = await createCharacter({ name: 'Zoë "Ångström" 李 & co', face, meta: { width: 640, height: 800 } })
    expect(c.default_face_id).toBe('m1')
    const [url, init] = call()
    const parsed = new URL(url)
    expect(parsed.origin).toBe(`${window.location.protocol}//${window.location.hostname}:47301`)
    expect(parsed.pathname).toBe('/api/characters')
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ name: 'Zoë "Ångström" 李 & co', width: '640', height: '800' })
    // The name is URL-encoded in the query, never sent raw.
    expect(url).not.toContain(' ')
    expect(url).toContain('name=Zo%C3%AB')
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('Content-Type')).toBe('application/octet-stream')
    expect(headers.get('X-Filename')).toBe(encodeURIComponent('Zoë 李 face #1.png'))
    expect(headers.get('X-Content-Type')).toBe('image/png')
    // The File itself (streamed by the browser), not a copy read into memory.
    expect(init.body).toBeInstanceOf(Blob)
    expect(new Uint8Array(await (init.body as Blob).arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]))
  })

  it('creates without metadata when the probe found none', async () => {
    respond({ ok: true, character: character() })
    await createCharacter({ name: 'Mia', face: new File([new Uint8Array(1)], 'f.png', { type: 'image/png' }) })
    expect(Object.fromEntries(new URL(call()[0]).searchParams)).toEqual({ name: 'Mia' })
  })

  it('surfaces the backend message when the create is refused', async () => {
    respond({ ok: false, error: 'A character needs a name and a face image.' }, 422)
    const face = new File([new Uint8Array(1)], 'notes.txt', { type: 'text/plain' })
    await expect(createCharacter({ name: 'Mia', face })).rejects.toThrow('A character needs a name and a face image.')
    respond({ ok: false, error: 'The upload was empty.' }, 400)
    await expect(createCharacter({ name: 'Mia', face: new File([], 'e.png', { type: 'image/png' }) })).rejects.toThrow('The upload was empty.')
  })

  it('gets one character, encoding the id', async () => {
    respond({ ok: true, character: character({ id: 'a b' }) })
    await getCharacter('a b')
    expect(call()[0]).toBe('/api/characters/a%20b')
  })

  it('patches only the given fields', async () => {
    respond({ ok: true, character: character({ default_face_id: 'm1' }) })
    const c = await updateCharacter('c1', { default_face_id: 'm1' })
    expect(c.default_face_id).toBe('m1')
    const [url, init] = call()
    expect(url).toBe('/api/characters/c1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ default_face_id: 'm1' })
  })

  it('sets the default audio clip with default_audio_id', async () => {
    respond({ ok: true, character: character({ default_audio_id: 'a2' }) })
    const c = await updateCharacter('c1', { default_audio_id: 'a2' })
    expect(c.default_audio_id).toBe('a2')
    expect(JSON.parse(call()[1].body as string)).toEqual({ default_audio_id: 'a2' })
  })

  it('round-trips Unicode names', async () => {
    respond({ ok: true, character: character({ name: 'Zoë "Ångström" 李' }) })
    const c = await updateCharacter('c1', { name: 'Zoë "Ångström" 李' })
    expect(JSON.parse(call()[1].body as string)).toEqual({ name: 'Zoë "Ångström" 李' })
    expect(c.name).toBe('Zoë "Ångström" 李')
  })

  it('deletes a character', async () => {
    respond({ ok: true })
    await deleteCharacter('c1')
    expect(call()[0]).toBe('/api/characters/c1')
    expect(call()[1].method).toBe('DELETE')
  })

  it('uploads raw bytes to the direct backend URL with the encoded file name and probed metadata', async () => {
    const media = { id: 'm1', kind: 'image', label: 'é 1.png', local: '/outputs/characters/c1/m1.png' }
    respond({ ok: true, media, character: character({ media: [media as never] }) })
    const file = new File([new Uint8Array([1, 2, 3])], 'é 1.png', { type: 'image/png' })
    const result = await uploadCharacterMedia('c1', file, 'image', { width: 640, height: 480 })
    expect(result.media.id).toBe('m1')
    expect(result.character.media).toHaveLength(1)
    const [url, init] = call()
    const parsed = new URL(url)
    expect(parsed.origin).toBe(`${window.location.protocol}//${window.location.hostname}:47301`)
    expect(parsed.pathname).toBe('/api/characters/c1/media')
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ kind: 'image', width: '640', height: '480' })
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('Content-Type')).toBe('application/octet-stream')
    expect(headers.get('X-Filename')).toBe(encodeURIComponent('é 1.png'))
    expect(headers.get('X-Content-Type')).toBe('image/png')
    // The File itself (streamed by the browser), not a copy read into memory.
    expect(init.body).toBeInstanceOf(Blob)
    expect(new Uint8Array(await (init.body as Blob).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('sends the duration for audio and omits missing metadata', async () => {
    respond({ ok: true, media: { id: 'm2' }, character: character() })
    const file = new File([new Uint8Array(1)], 'v.wav', { type: '' })
    await uploadCharacterMedia('c1', file, 'audio', { duration_s: 3.25 })
    const parsed = new URL(call()[0])
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ kind: 'audio', duration_s: '3.25' })
    expect(new Headers(call()[1].headers).get('X-Content-Type')).toBe('application/octet-stream')
  })

  it('removes one media file', async () => {
    respond({ ok: true, character: character() })
    await deleteCharacterMedia('c1', 'm1')
    expect(call()[0]).toBe('/api/characters/c1/media/m1')
    expect(call()[1].method).toBe('DELETE')
  })

  it('reorders the media of one kind', async () => {
    respond({ ok: true, character: character() })
    await reorderCharacterMedia('c1', 'image', ['m2', 'm1'])
    const [url, init] = call()
    expect(url).toBe('/api/characters/c1/media/order')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'image', ids: ['m2', 'm1'] })
  })

  it('turns {ok:false, error} into an Error with that message', async () => {
    respond({ ok: false, error: 'Name is required.' }, 400)
    await expect(updateCharacter('c1', { name: ' ' })).rejects.toThrow('Name is required.')
  })

  it('turns a non-JSON response into a readable Error', async () => {
    respond('Internal Server Error', 500)
    await expect(listCharacters()).rejects.toThrow(/HTTP 500/)
  })

  it('reads a FastAPI detail error', async () => {
    respond({ detail: 'Character not found' }, 404)
    await expect(getCharacter('gone')).rejects.toThrow('Character not found')
  })

  it('treats a malformed success body as an error', async () => {
    respond({ ok: true })
    await expect(listCharacters()).rejects.toThrow(/malformed|Could not/i)
  })

  it('surfaces network failures', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(deleteCharacter('c1')).rejects.toThrow('Failed to fetch')
  })
})
