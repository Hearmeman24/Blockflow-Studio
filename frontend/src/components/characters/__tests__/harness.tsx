/**
 * Shared fixtures for the Characters page and wizard tests: an in-memory
 * characters server behind the mocked `@/lib/characters/api`, a fetch stub
 * for `/api/runs?character=` and the provider catalog, and object-URL stubs.
 * Each test file still declares its own `vi.mock` calls (they are hoisted).
 */
import { vi } from 'vitest'
import { render } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'
import * as api from '@/lib/characters/api'
import type { Character, CharacterMedia, CharacterMediaKind } from '@/lib/characters/types'
import type { RunEntry } from '@/lib/types'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'

const EXT: Record<CharacterMediaKind, string> = { image: 'png', video: 'mp4', audio: 'mp3' }

export function media(id: string, kind: CharacterMediaKind, position: number, label = `${id}.${EXT[kind]}`, cid = 'c1'): CharacterMedia {
  return { id, kind, label, local: `/outputs/characters/${cid}/${id}.${EXT[kind]}`, size_bytes: 10, width: null, height: null, duration_s: null, position, created_at: '' }
}

export function character(id: string, over: Partial<Character> = {}): Character {
  return { id, name: id, description: '', created_at: '', updated_at: '', default_face_id: null, default_audio_id: null, media: [], ...over }
}

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

/** Mia: two images (face i2), a video and two audio clips (a voice sample `vo1.wav`, the default, and `au1.mp3`). */
export const mia = () => character('c1', {
  name: 'Mia',
  media: [media('i1', 'image', 0), media('i2', 'image', 1), media('vid1', 'video', 0), media('vo1', 'audio', 0, 'vo1.wav'), media('au1', 'audio', 1)],
  default_face_id: 'i2',
  default_audio_id: 'vo1',
})

/** A character made before a face was required: no files at all. */
export const faceless = () => character('c2', { name: 'Zoë "Ångström" 李' })

export const server = {
  db: [] as Character[],
  nextId: 0,
  find(id: string) {
    const c = server.db.find((x) => x.id === id)
    if (!c) throw new Error('Character not found')
    return c
  },
}

export function installServer(initial: Character[]) {
  server.db = initial
  server.nextId = 0
  vi.mocked(api.listCharacters).mockImplementation(async () => clone(server.db))
  vi.mocked(api.createCharacter).mockImplementation(async ({ name, face }) => {
    const id = `new${++server.nextId}`
    const m = media(`up${++server.nextId}`, 'image', 0, face.name, id)
    const c = character(id, { name, media: [m], default_face_id: m.id })
    server.db.push(c)
    return clone(c)
  })
  vi.mocked(api.updateCharacter).mockImplementation(async (id, patch) => {
    Object.assign(server.find(id), patch)
    return clone(server.find(id))
  })
  vi.mocked(api.deleteCharacter).mockImplementation(async (id) => { server.db = server.db.filter((c) => c.id !== id) })
  vi.mocked(api.uploadCharacterMedia).mockImplementation(async (id, file, kind) => {
    const c = server.find(id)
    const m = media(`up${++server.nextId}`, kind, c.media.filter((x) => x.kind === kind).length, file.name, id)
    c.media.push(m)
    // Like the backend: the first image or audio clip of a character without one becomes its default.
    if (kind === 'image' && !c.default_face_id) c.default_face_id = m.id
    if (kind === 'audio' && !c.default_audio_id) c.default_audio_id = m.id
    return { media: clone(m), character: clone(c) }
  })
  vi.mocked(api.deleteCharacterMedia).mockImplementation(async (id, mediaId) => {
    const c = server.find(id)
    c.media = c.media.filter((m) => m.id !== mediaId)
    return clone(c)
  })
  vi.mocked(api.reorderCharacterMedia).mockImplementation(async (id, kind, ids) => {
    const c = server.find(id)
    for (const m of c.media) if (m.kind === kind) m.position = ids.indexOf(m.id)
    return clone(c)
  })
}

/** The calls that change something on the backend. */
export function writeCalls(): number {
  return [api.createCharacter, api.updateCharacter, api.deleteCharacter, api.uploadCharacterMedia, api.deleteCharacterMedia, api.reorderCharacterMedia]
    .reduce((n, fn) => n + vi.mocked(fn).mock.calls.length, 0)
}

// ---- runs made with a character ----

export function makeRun(id: string, over: Partial<RunEntry> = {}): RunEntry {
  const ref = { kind: 'image-ref', local: `/outputs/byok/${id}.png`, meta: { job_id: id, provider: 'kie', model: 'seedream-5-flash' } }
  return {
    id,
    name: `Run ${id}`,
    status: 'completed',
    duration_ms: 1000,
    flow_snapshot: { name: 'Pipeline Run', blocks: [] },
    block_results: [{ block_index: 0, block_type: 'imageToImage', block_label: 'Image to Image', status: 'completed', outputs: { image: { kind: 'image', value: ref } } }],
    created_at: new Date(Date.now() - 60_000).toISOString(),
    favorited: false,
    ...over,
  } as RunEntry
}

export type RunsResponder = (characterId: string, offset: number, limit: number) => Response | Promise<Response>

export const runsJson = (runs: RunEntry[], total = runs.length, offset = 0) =>
  new Response(JSON.stringify({ ok: true, runs, total, limit: 25, offset }))

/** Stub `fetch`: the runs route answers through `responder`, the catalog with a fixture. */
export function stubFetch(responder: RunsResponder) {
  const fetchMock = vi.fn(async (input: string) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/runs') {
      return responder(url.searchParams.get('character') ?? '', Number(url.searchParams.get('offset') ?? 0), Number(url.searchParams.get('limit') ?? 25))
    }
    if (url.pathname.startsWith('/api/providers/catalog')) return new Response(JSON.stringify(CATALOG_BOTH))
    return new Response(JSON.stringify({ ok: true }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

export function runFetches(fetchMock: ReturnType<typeof stubFetch>): string[] {
  return fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/api/runs'))
}

// ---- object URLs ----

export function stubObjectUrls() {
  let seq = 0
  const created: string[] = []
  const revoked: string[] = []
  const create = vi.fn((file: Blob) => {
    const url = `blob:test/${++seq}-${(file as File).name ?? 'blob'}`
    created.push(url)
    return url
  })
  const revoke = vi.fn((url: string) => { revoked.push(url) })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revoke })
  return { created, revoked, create, revoke }
}

export const png = (name: string) => new File([new Uint8Array(4)], name, { type: 'image/png' })
export const mp4 = (name: string) => new File([new Uint8Array(4)], name, { type: 'video/mp4' })
export const wav = (name: string) => new File([new Uint8Array(4)], name, { type: 'audio/wav' })
export const txt = (name: string) => new File(['x'], name, { type: 'text/plain' })

export function renderWithSWR(ui: ReactNode) {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>{ui}</SWRConfig>)
}
