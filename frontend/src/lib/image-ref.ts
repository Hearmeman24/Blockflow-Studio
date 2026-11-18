/**
 * Polymorphic image reference passed between pipeline blocks.
 *
 * Upload Image emits objects carrying *both* a local /outputs path and a
 * public tmpfiles URL so downstream consumers can pick whichever form they
 * need (HTTP-fetchable for remote providers, local bytes for vision models running
 * inside this app, etc.) without forcing the user to pre-decide.
 *
 * Legacy producers may still emit bare strings (a /outputs path, an http(s)
 * URL, or a blob: URL). Every helper here accepts bare strings as a
 * back-compat input.
 */

import { readPriceCheck } from '@/lib/byok/cost'
import type { PriceCheck } from '@/lib/types'

export type ImageRef = {
  kind: 'image-ref'
  /** /outputs/... served by FastAPI, or a transient blob: preview URL. */
  local: string
  /** Remote, externally-fetchable URL, when one exists. Loaders keep files
   *  local; the generation service uploads `local` to the provider at run time. */
  url?: string
  /** Optional metadata from the loader, used to check ledger limits upstream. */
  /** File name shown to the user. */
  label?: string
  size_bytes?: number
  width?: number
  height?: number
  duration_s?: number
  /** Set on outputs of a generation block: which job made it and what it cost. */
  meta?: GenerationMeta
}

/** Where a generated output came from. `cost` is the provider's charge, or null when not (yet) reported. */
export interface GenerationMeta {
  job_id: string
  provider: string
  model: string
  cost: { amount: number; unit: string; usd_equivalent: number | null } | null
  /** The provider's charge compared with the price list; absent when there was none to compare. */
  price_check?: PriceCheck
}

/** The generation metadata on a ref, or null for plain refs (loaders, older outputs, bare strings). */
export function readGenerationMeta(value: unknown): GenerationMeta | null {
  if (!value || typeof value !== 'object') return null
  const meta = (value as { meta?: unknown }).meta
  if (!meta || typeof meta !== 'object') return null
  const m = meta as Record<string, unknown>
  if (typeof m.job_id !== 'string' || !m.job_id) return null
  const c = m.cost as Record<string, unknown> | null | undefined
  const cost = c && typeof c === 'object' && typeof c.amount === 'number' && Number.isFinite(c.amount) && typeof c.unit === 'string' && c.unit
    ? { amount: c.amount, unit: c.unit, usd_equivalent: typeof c.usd_equivalent === 'number' ? c.usd_equivalent : null }
    : null
  const price_check = readPriceCheck(m.price_check)
  return {
    job_id: m.job_id,
    provider: typeof m.provider === 'string' ? m.provider : '',
    model: typeof m.model === 'string' ? m.model : '',
    cost,
    ...(price_check ? { price_check } : {}),
  }
}

/** Display URL → generation metadata, for every ref in a port value that carries some. */
export function generationMetaByUrl(input: unknown): Map<string, GenerationMeta> {
  const out = new Map<string, GenerationMeta>()
  const items = Array.isArray(input) ? input.flat(Infinity as 1) : [input]
  for (const item of items) {
    const meta = readGenerationMeta(item)
    if (!meta) continue
    const ref = item as { local?: string; url?: string }
    const url = ref.local || ref.url
    if (url) out.set(url, meta)
  }
  return out
}

export type ImageRefInput = unknown

export function isImageRef(v: unknown): v is ImageRef {
  return !!v && typeof v === 'object' && (v as ImageRef).kind === 'image-ref'
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s)
}

function normalize(input: unknown): Array<string | ImageRef> {
  if (input == null) return []
  if (Array.isArray(input)) return input.flatMap(normalize)
  if (isImageRef(input)) return [input]
  if (typeof input === 'string') {
    const t = input.trim()
    return t ? [t] : []
  }
  return []
}

/**
 * URLs suitable for external HTTP fetch (remote providers).
 * Skips entries that resolve only to a non-http local path — remote
 * services can't reach `/outputs/...`. Order is preserved.
 */
export function toPublicUrls(input: unknown): string[] {
  const out: string[] = []
  for (const item of normalize(input)) {
    if (typeof item === 'string') {
      if (isHttpUrl(item)) out.push(item)
      // bare local paths intentionally dropped — not fetchable externally
      continue
    }
    if (item.url && isHttpUrl(item.url)) {
      out.push(item.url)
      continue
    }
    if (isHttpUrl(item.local)) out.push(item.local)
  }
  return out
}

export function toPublicUrl(input: unknown): string | undefined {
  return toPublicUrls(input)[0]
}

/**
 * URLs suitable for provider submission when a backend can resolve local
 * `/outputs/...` paths before calling the remote provider. Per item, prefer
 * the local side when present so expired or forbidden public mirrors do not
 * win over files already available to the backend.
 */
export function toBackendResolvableUrls(input: unknown): string[] {
  const out: string[] = []
  for (const item of normalize(input)) {
    if (typeof item === 'string') {
      out.push(item)
      continue
    }
    if (item.local) {
      out.push(item.local)
      continue
    }
    if (item.url && isHttpUrl(item.url)) {
      out.push(item.url)
    }
  }
  return out.filter((s) => s.length > 0)
}

export const toPublicOrDisplayUrls = toBackendResolvableUrls

/**
 * URLs/paths preferring the local form — for use inside this app (browser
 * display via FastAPI's /outputs route, or backend disk reads). Falls back
 * to the public URL when no local form exists.
 */
export function toDisplayUrls(input: unknown): string[] {
  const out: string[] = []
  for (const item of normalize(input)) {
    if (typeof item === 'string') {
      out.push(item)
      continue
    }
    out.push(item.local || item.url || '')
  }
  return out.filter((s) => s.length > 0)
}

export function toDisplayUrl(input: unknown): string | undefined {
  return toDisplayUrls(input)[0]
}
