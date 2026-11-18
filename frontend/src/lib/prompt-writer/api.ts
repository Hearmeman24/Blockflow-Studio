import { mutate } from 'swr'
import type { KeyCheckResult } from '@/lib/settings/client'
import {
  WRITER_ERROR_KINDS,
  WRITER_MEDIA_KINDS,
  isWriterMediaKind,
  isWriterProviderId,
  type WriterErrorKind,
  type WriterGenerateRequest,
  type WriterGenerateResult,
  type WriterModel,
  type WriterProviderStatus,
} from './types'

export const WRITER_PROVIDERS_URL = '/api/blocks/prompt_writer/providers'
const GENERATE_URL = '/api/blocks/prompt_writer/generate'
const CHECK_KEY_URL = '/api/blocks/prompt_writer/check-key'

function parseModel(raw: unknown): WriterModel | null {
  if (!raw || typeof raw !== 'object') return null
  const { id, name, accepts } = raw as Record<string, unknown>
  if (typeof id !== 'string' || !id) return null
  // An older backend sends no `accepts`: the model is text-only.
  const kinds = Array.isArray(accepts) ? accepts.filter(isWriterMediaKind) : []
  return {
    id,
    name: typeof name === 'string' && name ? name : id,
    accepts: WRITER_MEDIA_KINDS.filter((k) => kinds.includes(k)),
  }
}

function parseStatus(raw: unknown): WriterProviderStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isWriterProviderId(r.id) || typeof r.available !== 'boolean') return null
  const available = r.available
  return {
    id: r.id,
    label: typeof r.label === 'string' && r.label ? r.label : r.id,
    kind: r.kind === 'hosted' ? 'hosted' : 'local',
    available,
    reason: available ? null : (typeof r.reason === 'string' && r.reason ? r.reason : 'Not available'),
    models: available && Array.isArray(r.models)
      ? r.models.map(parseModel).filter((m): m is WriterModel => m !== null)
      : [],
    models_error: typeof r.models_error === 'string' ? r.models_error : null,
    base_url: typeof r.base_url === 'string' ? r.base_url : null,
  }
}

/** Provider status from the backend. Throws when the answer is unusable. */
export async function fetchWriterProviders(refresh = false): Promise<WriterProviderStatus[]> {
  const res = await fetch(refresh ? `${WRITER_PROVIDERS_URL}?refresh=1` : WRITER_PROVIDERS_URL)
  if (res.status === 404) {
    throw new Error('The running backend does not have the Prompt Writer routes yet (HTTP 404). Restart BlockFlow, then press Retry.')
  }
  if (!res.ok) throw new Error(`BlockFlow answered with HTTP ${res.status}.`)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error('BlockFlow returned an answer that is not JSON.')
  }
  const list = (body as { providers?: unknown } | null)?.providers
  if (!Array.isArray(list)) throw new Error('BlockFlow returned an unexpected answer.')
  const parsed = list.map(parseStatus).filter((s): s is WriterProviderStatus => s !== null)
  if (parsed.length === 0) throw new Error('BlockFlow returned an unexpected answer.')
  return parsed
}

/** Revalidate every open Prompt Writer's provider list (after a key or URL change). */
export function refreshWriterProviders(): void {
  void mutate(WRITER_PROVIDERS_URL)
}

function isErrorKind(value: unknown): value is WriterErrorKind {
  return typeof value === 'string' && (WRITER_ERROR_KINDS as readonly string[]).includes(value)
}

/**
 * One generation. Provider errors come back as `{ok: false, kind, message}`;
 * an aborted signal rejects with the AbortError so the runner sees the cancel.
 */
export async function generateWithWriter(
  request: WriterGenerateRequest,
  signal?: AbortSignal,
): Promise<WriterGenerateResult> {
  let res: Response
  try {
    res = await fetch(GENERATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) throw err
    return { ok: false, kind: 'network', message: 'Could not reach BlockFlow. Make sure it is running, then try again.' }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    if (signal?.aborted) throw err
    // The backend always answers in JSON. A non-JSON error comes from the
    // frontend proxy: the backend is down, restarting or dropped the request.
    if (res.status >= 500) {
      return {
        ok: false,
        kind: 'network',
        message: `BlockFlow's backend did not answer (HTTP ${res.status}). Make sure BlockFlow is running, then press Run Pipeline again.`,
      }
    }
    return { ok: false, kind: 'malformed_response', message: `BlockFlow returned an unexpected answer (HTTP ${res.status}).` }
  }
  const b = (body ?? {}) as Record<string, unknown>
  if (b.ok === true && typeof b.text === 'string' && b.text.trim()) return { ok: true, text: b.text }
  if (b.ok === false && typeof b.message === 'string') {
    return { ok: false, kind: isErrorKind(b.kind) ? b.kind : 'provider_failure', message: b.message }
  }
  return { ok: false, kind: 'malformed_response', message: `BlockFlow returned an unexpected answer (HTTP ${res.status}).` }
}

export async function checkOpenRouterKey(): Promise<KeyCheckResult> {
  const res = await fetch(CHECK_KEY_URL, { method: 'POST' })
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error(`HTTP ${res.status}`)
  }
  const verdict = body as Partial<KeyCheckResult> | null
  if (!verdict || typeof verdict.message !== 'string' || typeof verdict.ok !== 'boolean') {
    throw new Error(`HTTP ${res.status}`)
  }
  return verdict as KeyCheckResult
}
