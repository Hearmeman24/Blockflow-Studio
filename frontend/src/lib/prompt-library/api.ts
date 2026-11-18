/**
 * Client for `/api/prompt-library`. Every route answers `{ok, ...}`; a failure
 * (`{ok:false, kind, error}`, a non-JSON body or no connection) becomes an
 * Error with a readable message.
 */

/** Generation blocks save `generation`; the Prompt Writer saves `system` and `user`. */
export type PromptType = 'generation' | 'system' | 'user'

export interface SavedPrompt {
  id: string
  name: string
  type: PromptType
  content: string
  created_at: string
}

/** SWR key and URL of the library. */
export const PROMPT_LIBRARY_URL = '/api/prompt-library'

/** Matches the backend caps (backend/prompt_library.py). */
export const MAX_PROMPT_NAME_LENGTH = 120
export const MAX_PROMPT_CONTENT_LENGTH = 20_000

/** How each type is named in the UI. */
export const PROMPT_TYPE_LABELS: Record<PromptType, { singular: string; plural: string }> = {
  generation: { singular: 'generation prompt', plural: 'generation prompts' },
  system: { singular: 'system prompt', plural: 'system prompts' },
  user: { singular: 'user prompt', plural: 'user prompts' },
}

type Body = Record<string, unknown>

async function request(url: string, init: RequestInit, action: string): Promise<Body> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new Error(`Could not ${action}: BlockFlow is not reachable. Check that the app is running, then try again.`)
  }
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`Could not ${action} (HTTP ${res.status}).`)
  }
  const obj = body && typeof body === 'object' ? (body as Body) : {}
  if (!res.ok || obj.ok === false) {
    const message = typeof obj.error === 'string' && obj.error.trim() ? obj.error : `Could not ${action} (HTTP ${res.status}).`
    throw new Error(message)
  }
  return obj
}

function isSavedPrompt(value: unknown): value is SavedPrompt {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return typeof p.id === 'string' && typeof p.name === 'string' && typeof p.content === 'string'
    && (p.type === 'generation' || p.type === 'system' || p.type === 'user')
}

export async function listPrompts(): Promise<SavedPrompt[]> {
  const body = await request(PROMPT_LIBRARY_URL, { method: 'GET' }, 'load saved prompts')
  if (!Array.isArray(body.prompts)) throw new Error('Could not load saved prompts: the response was malformed.')
  return body.prompts.filter(isSavedPrompt)
}

export async function createPrompt(name: string, type: PromptType, content: string): Promise<SavedPrompt> {
  const body = await request(
    PROMPT_LIBRARY_URL,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, type, content }) },
    'save the prompt',
  )
  if (!isSavedPrompt(body.prompt)) throw new Error('Could not save the prompt: the response was malformed.')
  return body.prompt
}

export async function deletePrompt(id: string): Promise<void> {
  await request(`${PROMPT_LIBRARY_URL}/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'delete the prompt')
}

/** The saved prompts of one type, in saved order. */
export function promptsOfType(prompts: readonly SavedPrompt[] | undefined, type: PromptType): SavedPrompt[] {
  return (prompts ?? []).filter((p) => p.type === type)
}
