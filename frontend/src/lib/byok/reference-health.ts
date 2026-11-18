/**
 * Client for `POST /api/generation/check-references` and the wording for its
 * statuses. A reference is broken when its local file is gone and no working
 * URL remains, when its link expired or cannot be reached, or when it is
 * malformed. `unchecked` (a provider `asset://` reference) is not broken: it
 * cannot be probed and is shown as "not verified".
 */
import type { MediaKind } from './types'

export const CHECK_REFERENCES_URL = '/api/generation/check-references'

export type ReferenceHealthStatus = 'ok' | 'missing_local' | 'unreachable' | 'expired' | 'malformed' | 'unchecked'

export interface ReferenceHealth {
  status: ReferenceHealthStatus
  detail: string
}

export interface HealthTarget {
  kind: MediaKind
  local?: string
  url?: string
}

const STATUSES: ReadonlySet<string> = new Set(['ok', 'missing_local', 'unreachable', 'expired', 'malformed', 'unchecked'])
const BROKEN: ReadonlySet<ReferenceHealthStatus> = new Set(['missing_local', 'unreachable', 'expired', 'malformed'])

export function isBrokenStatus(status: ReferenceHealthStatus | undefined | null): boolean {
  return Boolean(status && BROKEN.has(status))
}

/** Short label for the status badge. Always shown as text, next to an icon. */
export const HEALTH_LABEL: Record<ReferenceHealthStatus, string> = {
  ok: 'Found',
  missing_local: 'File not found',
  unreachable: 'Unreachable',
  expired: 'Link expired',
  malformed: 'Invalid reference',
  unchecked: 'Not verified',
}

/** The identity of a reference for the check: two items with the same file share a result. */
export function healthSignature(target: { local?: string; url?: string }): string {
  return `${target.local ?? ''}\u0000${target.url ?? ''}`
}

export function hasSource(target: { local?: string; url?: string }): boolean {
  return Boolean(target.local?.trim() || target.url?.trim())
}

/**
 * Check a batch of references. Resolves with one result per input, in order.
 * Throws when the route fails or answers in an unexpected shape, so callers
 * can say "could not verify" instead of marking everything broken.
 */
export async function checkReferenceHealth(targets: readonly HealthTarget[], signal?: AbortSignal): Promise<ReferenceHealth[]> {
  if (targets.length === 0) return []
  const res = await fetch(CHECK_REFERENCES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      references: targets.map((t) => ({
        kind: t.kind,
        ...(t.local ? { local: t.local } : {}),
        ...(t.url ? { url: t.url } : {}),
      })),
    }),
    signal,
  })
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  const results = (body as { ok?: boolean; results?: unknown })?.results
  if (!res.ok || !Array.isArray(results)) {
    throw new Error(`The reference check failed (HTTP ${res.status}).`)
  }
  const out: ReferenceHealth[] = targets.map(() => ({ status: 'unchecked', detail: '' }))
  const seen = new Set<number>()
  for (const raw of results as Array<Record<string, unknown>>) {
    const index = typeof raw?.index === 'number' ? raw.index : -1
    if (index < 0 || index >= targets.length || !STATUSES.has(String(raw.status))) {
      throw new Error('The reference check answered in an unexpected shape.')
    }
    seen.add(index)
    out[index] = { status: raw.status as ReferenceHealthStatus, detail: typeof raw.detail === 'string' ? raw.detail : '' }
  }
  if (seen.size !== targets.length) throw new Error('The reference check did not answer for every reference.')
  return out
}
