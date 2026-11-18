/**
 * Client for the provider catalog and the generation routes. The frontend
 * never sees or sends a provider key; the backend reads keys from Settings.
 */
import type { JobSnapshot } from '@/lib/types'
import type { GenerationIssue, GenerationRequest, ProviderCatalog, SubmitRequest } from './types'

/** SWR key and URL. Settings calls `mutate(CATALOG_URL)` after a key changes. */
export const CATALOG_URL = '/api/providers/catalog'
export const VALIDATE_URL = '/api/generation/validate'
export const SUBMIT_URL = '/api/generation/submit'

export function cancelUrl(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/cancel`
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export async function fetchProviderCatalog(): Promise<ProviderCatalog> {
  const res = await fetch(CATALOG_URL, { method: 'GET' })
  const body = await readJson(res)
  if (!res.ok || !body || typeof body !== 'object') {
    throw new Error(`Could not load the provider catalog (HTTP ${res.status}).`)
  }
  const catalog = body as Partial<ProviderCatalog>
  if (!catalog.providers || typeof catalog.providers !== 'object' || !Array.isArray(catalog.models) || !Array.isArray(catalog.modes)) {
    throw new Error('The provider catalog response was malformed.')
  }
  return catalog as ProviderCatalog
}

export interface ValidationResponse {
  ok: boolean
  issues: GenerationIssue[]
}

function jsonPost(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

export async function validateGeneration(request: GenerationRequest, signal?: AbortSignal): Promise<ValidationResponse> {
  const res = await jsonPost(VALIDATE_URL, request, signal)
  const body = (await readJson(res)) as { ok?: boolean; issues?: GenerationIssue[] } | undefined
  if (!body || !Array.isArray(body.issues)) {
    throw new Error(`Validation failed (HTTP ${res.status}). Try again.`)
  }
  return { ok: Boolean(body.ok) && !body.issues.some((i) => i.severity === 'error'), issues: body.issues }
}

export type SubmitFailureKind = 'validation' | 'auth' | 'conflict' | 'unknown' | (string & {})

export type SubmitResponse =
  | { ok: true; job: JobSnapshot }
  | { ok: false; error: string; kind: SubmitFailureKind; issues: GenerationIssue[] }

export async function submitGeneration(request: SubmitRequest, signal?: AbortSignal): Promise<SubmitResponse> {
  const res = await jsonPost(SUBMIT_URL, request, signal)
  const body = (await readJson(res)) as
    | { ok?: boolean; job?: JobSnapshot; error?: string; kind?: string; issues?: GenerationIssue[] }
    | undefined
  if (res.ok && body?.ok && body.job) return { ok: true, job: body.job }
  return {
    ok: false,
    error: typeof body?.error === 'string' && body.error ? body.error : `Submitting the generation failed (HTTP ${res.status}).`,
    kind: typeof body?.kind === 'string' ? body.kind : 'unknown',
    issues: Array.isArray(body?.issues) ? body.issues : [],
  }
}

/** Ask the backend to cancel a job. Never throws; returns whether the request was accepted. */
export async function cancelJob(jobId: string): Promise<boolean> {
  try {
    const res = await fetch(cancelUrl(jobId), { method: 'POST' })
    return res.ok
  } catch {
    return false
  }
}

export function newClientRequestId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  return `blk-${random}`
}
