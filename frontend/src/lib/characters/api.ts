/**
 * Client for `/api/characters*`. Every route answers `{ok, ...}`; a failure
 * (`{ok:false, error}`, a FastAPI `detail`, or a non-JSON body) becomes an
 * Error with a readable message.
 */
import { directBackendUrl } from '@/lib/backend-url'
import type { Character, CharacterCreate, CharacterMedia, CharacterMediaKind, CharacterMediaMeta, CharacterPatch } from './types'

/** SWR key and URL of the character list. */
export const CHARACTERS_URL = '/api/characters'

function characterUrl(id: string): string {
  return `${CHARACTERS_URL}/${encodeURIComponent(id)}`
}

type Body = Record<string, unknown>

async function request(url: string, init: RequestInit, action: string): Promise<Body> {
  const res = await fetch(url, init)
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    const excerpt = text.slice(0, 160).trim()
    throw new Error(`Could not ${action} (HTTP ${res.status})${excerpt ? `: ${excerpt}` : '.'}`)
  }
  const obj = body && typeof body === 'object' ? (body as Body) : {}
  if (!res.ok || obj.ok === false) {
    const message = typeof obj.error === 'string' && obj.error.trim()
      ? obj.error
      : typeof obj.detail === 'string' && obj.detail.trim()
        ? obj.detail
        : `Could not ${action} (HTTP ${res.status}).`
    throw new Error(message)
  }
  return obj
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

function characterOf(body: Body, action: string): Character {
  const c = body.character as Character | undefined
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !Array.isArray(c.media)) {
    throw new Error(`Could not ${action}: the response was malformed.`)
  }
  return c
}

export async function listCharacters(): Promise<Character[]> {
  const body = await request(CHARACTERS_URL, { method: 'GET' }, 'load characters')
  if (!Array.isArray(body.characters)) throw new Error('Could not load characters: the response was malformed.')
  return body.characters as Character[]
}

/**
 * Raw-bytes request shared by the face and media uploads; the backend decodes
 * `X-Filename`. The body is the File itself, which the browser streams from
 * disk (an explicit Content-Type wins over `file.type`).
 */
function rawUpload(file: File): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name),
      'X-Content-Type': file.type || 'application/octet-stream',
    },
    body: file,
  }
}

function setMeta(params: URLSearchParams, meta: CharacterMediaMeta): void {
  for (const key of ['width', 'height', 'duration_s'] as const) {
    const value = meta[key]
    if (typeof value === 'number' && Number.isFinite(value)) params.set(key, String(value))
  }
}

/**
 * Create a character from its name and face image. The image is the raw body
 * and becomes the first image and the default face. Goes straight to FastAPI,
 * like the media upload.
 */
export async function createCharacter({ name, face, meta = {} }: CharacterCreate): Promise<Character> {
  const params = new URLSearchParams({ name })
  setMeta(params, meta)
  const url = directBackendUrl(`${CHARACTERS_URL}?${params}`)
  return characterOf(await request(url, rawUpload(face), 'create the character'), 'create the character')
}

export async function getCharacter(id: string): Promise<Character> {
  return characterOf(await request(characterUrl(id), { method: 'GET' }, 'load the character'), 'load the character')
}

export async function updateCharacter(id: string, patch: CharacterPatch): Promise<Character> {
  return characterOf(await request(characterUrl(id), json('PATCH', patch), 'save the character'), 'save the character')
}

export async function deleteCharacter(id: string): Promise<void> {
  await request(characterUrl(id), { method: 'DELETE' }, 'delete the character')
}

/**
 * Raw-bytes upload. Goes straight to FastAPI: videos exceed the Next proxy's
 * body limit. The backend decodes `X-Filename`.
 */
export async function uploadCharacterMedia(
  id: string,
  file: File,
  kind: CharacterMediaKind,
  meta: CharacterMediaMeta = {},
): Promise<{ media: CharacterMedia; character: Character }> {
  const params = new URLSearchParams({ kind })
  setMeta(params, meta)
  const url = directBackendUrl(`${characterUrl(id)}/media?${params}`)
  const body = await request(url, rawUpload(file), `add ${file.name}`)
  const character = characterOf(body, `add ${file.name}`)
  return { media: body.media as CharacterMedia, character }
}

export async function deleteCharacterMedia(id: string, mediaId: string): Promise<Character> {
  const url = `${characterUrl(id)}/media/${encodeURIComponent(mediaId)}`
  return characterOf(await request(url, { method: 'DELETE' }, 'remove the file'), 'remove the file')
}

export async function reorderCharacterMedia(id: string, kind: CharacterMediaKind, ids: string[]): Promise<Character> {
  const url = `${characterUrl(id)}/media/order`
  return characterOf(await request(url, json('PUT', { kind, ids }), 'reorder the files'), 'reorder the files')
}
