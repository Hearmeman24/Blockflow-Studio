/**
 * The ordered item list of the Image Loader and Video Loader blocks: the
 * persisted shape, migration from the old config keys, add-time checks and
 * per-item flags against the limits of the downstream generation blocks.
 *
 * Every limit comes from a `DownstreamLimit`, which is read from the catalog.
 * Nothing here names a model.
 */
import type { ImageRef } from '@/lib/image-ref'
import type { VideoRef } from '@/lib/video-ref'
import { kindPlural, referenceFormat } from './check-references'
import { limitSource, strictestLimit, type DownstreamLimit } from './downstream-limits'
import { fileLabel } from './references'
import { restoreTransferStatus } from './transfer-status'
import type { MediaLimit } from './types'

export type LoaderKind = 'image' | 'video' | 'audio'
/**
 * The save of one item (stored as is in session storage and saved flows): see
 * `transfer-status.ts`. What the item shows also depends on its reference check
 * and limit flag; `itemDisplayState` (`loader-item-display.ts`) combines them.
 */
export type LoaderItemStatus = 'saving' | 'ready' | 'error'

/** One loaded file. Persisted under the loader's `items` config key, in order. */
export interface LoaderItem {
  id: string
  /** File name shown in the list. */
  label: string
  /** `/outputs/...` path of the local copy: the durable reference. */
  local?: string
  /** Remote link, kept only for items migrated from older flows. */
  url?: string
  size_bytes?: number
  width?: number
  height?: number
  duration_s?: number
  format?: string
  /** The character the file belongs to (Load Character block), shown on the generation block's badge. */
  character?: string
  /**
   * `ready` with neither `local` nor `url` can be stored (a hand-edited or
   * damaged flow); such an item is listed but sends nothing (`itemsToOutput`).
   */
  status: LoaderItemStatus
  error?: string
}

export const LOADER_CONFIG_KEY = 'items'

/** Config keys of the Omni Reference Loader's three lists. */
export const OMNI_LOADER_KEYS = { video: 'video_items', image: 'image_items', audio: 'audio_items' } as const

/**
 * Legacy: the Omni Reference Loader's voice list, saved by versions before
 * voice became audio. Read only to fold it into `audio_items` (flow schema 6
 * and open tabs restored from session storage).
 */
export const LEGACY_OMNI_VOICE_KEY = 'voice_items'

const KIND_EXTS: Record<LoaderKind, ReadonlySet<string>> = {
  image: new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'tif', 'gif', 'heic', 'heif']),
  video: new Set(['mp4', 'mov', 'mkv', 'webm', 'm4v']),
  audio: new Set(['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a']),
}

const SINGULAR: Record<LoaderKind, string> = { image: 'image', video: 'video', audio: 'audio clip' }
const ARTICLE: Record<LoaderKind, string> = { image: 'an image', video: 'a video', audio: 'an audio' }
const MIME_PREFIX: Record<LoaderKind, string> = { image: 'image/', video: 'video/', audio: 'audio/' }

/** "image" / "audio clip", singular. */
export function kindSingular(kind: LoaderKind): string {
  return SINGULAR[kind]
}

const NUMBER_FIELDS = ['size_bytes', 'width', 'height', 'duration_s'] as const
const STRING_FIELDS = ['local', 'url', 'format', 'error'] as const

function isOutputsPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().startsWith('/outputs/')
}

function isHttp(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim())
}

/** Sanitise items read back from session storage or a saved flow. Order is kept; a voice's old speaker `name` is dropped. */
export function restoreLoaderItems(raw: unknown): LoaderItem[] {
  if (!Array.isArray(raw)) return []
  const out: LoaderItem[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    if (typeof r.id !== 'string' || !r.id) continue
    // A missing or unknown status reads as ready.
    const status = restoreTransferStatus(r.status, 'saving') ?? 'ready'
    const item: LoaderItem = {
      id: r.id,
      label: typeof r.label === 'string' && r.label ? r.label : fileLabel(String(r.local ?? r.url ?? '')) ?? r.id,
      status: status === 'interrupted' ? 'error' : status,
    }
    for (const key of STRING_FIELDS) if (typeof r[key] === 'string' && r[key]) item[key] = r[key] as string
    for (const key of NUMBER_FIELDS) if (typeof r[key] === 'number' && Number.isFinite(r[key])) item[key] = r[key] as number
    if (status === 'interrupted') item.error = 'Saving this file was interrupted. Replace it or add it again.'
    out.push(item)
  }
  return out
}

function legacyItem(prefix: string, index: number, local: unknown, url: unknown): LoaderItem | null {
  const localPath = isOutputsPath(local) ? local.trim() : undefined
  const remote = isHttp(url) ? url.trim() : isHttp(local) ? local.trim() : undefined
  if (!localPath && !remote) return null
  return {
    id: `${prefix}-${index}`,
    label: fileLabel(localPath ?? remote) ?? `${prefix}-${index}`,
    ...(localPath ? { local: localPath } : {}),
    ...(remote ? { url: remote } : {}),
    status: 'ready',
  }
}

/** Video Loader before multi-video: `local_url` / `remote_url` (and the older `uploaded_video_url`). */
export function legacyVideoItems(config: Record<string, unknown>): LoaderItem[] {
  const local = config.local_url || (isOutputsPath(config.uploaded_video_url) ? config.uploaded_video_url : undefined)
  const remote = config.remote_url || (isHttp(config.uploaded_video_url) ? config.uploaded_video_url : undefined)
  const item = legacyItem('legacy-video', 0, local, remote)
  return item ? [item] : []
}

/** Upload Image before the item list: `uploads_v2`, a map of fingerprint to `{local, url}` in add order. */
export function legacyImageItems(uploads: unknown): LoaderItem[] {
  if (!uploads || typeof uploads !== 'object' || Array.isArray(uploads)) return []
  const out: LoaderItem[] = []
  for (const value of Object.values(uploads as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const v = value as { local?: unknown; url?: unknown }
    const item = legacyItem('legacy-image', out.length, v.local, v.url)
    if (item) out.push(item)
  }
  return out
}

// ---- Checks ----

export interface LoaderCandidate {
  name: string
  /** MIME type from the browser, may be empty. */
  type: string
  size_bytes?: number
  duration_s?: number
  width?: number
  height?: number
}

function mb(n: number): string {
  return `${(n / 1_000_000).toFixed(1)} MB`
}

function seconds(n: number): string {
  return `${Number(n.toPrecision(4))} s`
}

function noun(kind: LoaderKind, count: number): string {
  return count === 1 ? SINGULAR[kind] : kindPlural(kind)
}

function formatOf(name: string, kind: LoaderKind): string | null {
  return referenceFormat({ kind, local: name })
}

export function isKindFile(kind: LoaderKind, candidate: Pick<LoaderCandidate, 'name' | 'type'>): boolean {
  if (candidate.type && candidate.type.startsWith(MIME_PREFIX[kind])) return true
  const ext = /\.([A-Za-z0-9]+)$/.exec(candidate.name)?.[1]?.toLowerCase()
  return Boolean(ext && KIND_EXTS[kind].has(ext))
}

/** The first ledger rule this file breaks for one consumer, worded for the add message. */
function candidateIssue(kind: LoaderKind, c: LoaderCandidate, limit: MediaLimit, source: string): string | null {
  const fmt = formatOf(c.name, kind)
  if (limit.formats.length > 0 && (!fmt || !limit.formats.includes(fmt))) {
    return `${c.name}: ${source} accepts ${limit.formats.join(', ')} ${kindPlural(kind)}.`
  }
  if (limit.max_size_bytes !== null && c.size_bytes != null && c.size_bytes > limit.max_size_bytes) {
    return `${c.name} is ${mb(c.size_bytes)}; ${source} accepts up to ${mb(limit.max_size_bytes)} per ${SINGULAR[kind]}.`
  }
  if (c.duration_s != null) {
    if (limit.max_duration_s !== null && c.duration_s > limit.max_duration_s) {
      return `${c.name} is ${seconds(c.duration_s)} long; ${source} accepts up to ${seconds(limit.max_duration_s)} per ${SINGULAR[kind]}.`
    }
    if (limit.min_duration_s !== null && c.duration_s < limit.min_duration_s) {
      return `${c.name} is ${seconds(c.duration_s)} long; ${source} needs at least ${seconds(limit.min_duration_s)} per ${SINGULAR[kind]}.`
    }
  }
  if (c.width != null && c.height != null) {
    if (limit.min_side_px !== null && Math.min(c.width, c.height) < limit.min_side_px) {
      return `${c.name} is ${c.width}x${c.height} px; ${source} needs each side to be at least ${limit.min_side_px} px.`
    }
    if (limit.max_side_px !== null && Math.max(c.width, c.height) > limit.max_side_px) {
      return `${c.name} is ${c.width}x${c.height} px; ${source} accepts at most ${limit.max_side_px} px per side.`
    }
  }
  return null
}

export interface CandidateCheck {
  /** Indexes of the candidates that may be added, in order. */
  accepted: number[]
  /** One readable message per refusal reason. */
  messages: string[]
}

/**
 * Which files may be added. Every consumer's limit applies; the count uses the
 * strictest consumer. `replacingId` is the item being replaced, which does not
 * count against the limit.
 */
export function checkCandidates(
  kind: LoaderKind,
  existing: readonly LoaderItem[],
  candidates: readonly LoaderCandidate[],
  consumers: readonly DownstreamLimit[],
  replacingId?: string,
): CandidateCheck {
  const messages: string[] = []
  const kept = existing.filter((i) => i.id !== replacingId)
  const strictest = strictestLimit(consumers)
  if (strictest && !strictest.accepted) {
    return {
      accepted: [],
      messages: [`Nothing was added: ${limitSource(strictest)} does not take ${kindPlural(kind)}. ${strictest.reason ?? ''}`.trim()],
    }
  }
  const valid: number[] = []
  candidates.forEach((c, index) => {
    if (!isKindFile(kind, c)) {
      messages.push(`${c.name} is not ${ARTICLE[kind]} file.`)
      return
    }
    for (const consumer of consumers) {
      const issue = consumer.limit ? candidateIssue(kind, c, consumer.limit, limitSource(consumer)) : null
      if (issue) {
        messages.push(issue)
        return
      }
    }
    valid.push(index)
  })

  // Total duration, per consumer, over the items kept plus the files added so far.
  const accepted: number[] = []
  const totals = new Map(consumers.map((c) => [c.blockId, kept.reduce((sum, i) => sum + (i.duration_s ?? 0), 0)]))
  for (const index of valid) {
    const c = candidates[index]
    const over = consumers.find((consumer) => {
      const max = consumer.limit?.max_total_duration_s ?? null
      return max !== null && c.duration_s != null && (totals.get(consumer.blockId) ?? 0) + c.duration_s > max
    })
    if (over) {
      const total = (totals.get(over.blockId) ?? 0) + (c.duration_s ?? 0)
      messages.push(`${c.name} would bring the ${kindPlural(kind)} to ${seconds(total)}; ${limitSource(over)} takes ${seconds(over.limit!.max_total_duration_s!)} in total.`)
      continue
    }
    for (const consumer of consumers) totals.set(consumer.blockId, (totals.get(consumer.blockId) ?? 0) + (c.duration_s ?? 0))
    accepted.push(index)
  }

  if (strictest) {
    const room = Math.max(0, strictest.maxCount - kept.length)
    if (accepted.length > room) {
      const dropped = accepted.splice(room)
      const what = dropped.length === 1 ? candidates[dropped[0]].name : `${dropped.length} files`
      messages.push(`${what} ${dropped.length === 1 ? 'was' : 'were'} not added: ${limitSource(strictest)} takes up to ${strictest.maxCount} ${noun(kind, strictest.maxCount)}.`)
    }
  }
  return { accepted, messages }
}

export type ItemFlagStatus = 'ok' | 'over_limit' | 'incompatible' | 'unsupported'

export interface ItemFlag {
  status: ItemFlagStatus
  reason: string | null
}

function itemIssue(kind: LoaderKind, item: LoaderItem, limit: MediaLimit, source: string): string | null {
  const fmt = item.format ?? referenceFormat({ kind, local: item.local ?? item.url ?? item.label })
  if (limit.formats.length > 0 && fmt && !limit.formats.includes(fmt)) {
    return `${source} does not accept .${fmt} ${kindPlural(kind)} (use ${limit.formats.join(', ')}).`
  }
  if (limit.max_size_bytes !== null && item.size_bytes != null && item.size_bytes > limit.max_size_bytes) {
    return `${source} accepts up to ${mb(limit.max_size_bytes)} per ${SINGULAR[kind]}; this is ${mb(item.size_bytes)}.`
  }
  if (item.duration_s != null) {
    if (limit.max_duration_s !== null && item.duration_s > limit.max_duration_s) {
      return `${source} accepts up to ${seconds(limit.max_duration_s)} per ${SINGULAR[kind]}; this is ${seconds(item.duration_s)}.`
    }
    if (limit.min_duration_s !== null && item.duration_s < limit.min_duration_s) {
      return `${source} needs at least ${seconds(limit.min_duration_s)} per ${SINGULAR[kind]}; this is ${seconds(item.duration_s)}.`
    }
  }
  if (item.width != null && item.height != null) {
    if (limit.min_side_px !== null && Math.min(item.width, item.height) < limit.min_side_px) {
      return `${source} needs each side to be at least ${limit.min_side_px} px; this is ${item.width}x${item.height}.`
    }
    if (limit.max_side_px !== null && Math.max(item.width, item.height) > limit.max_side_px) {
      return `${source} accepts at most ${limit.max_side_px} px per side; this is ${item.width}x${item.height}.`
    }
  }
  return null
}

/**
 * One flag per item, in order. Nothing is removed: excess and incompatible
 * items are flagged so the user can decide.
 */
export function flagItems(kind: LoaderKind, items: readonly LoaderItem[], consumers: readonly DownstreamLimit[]): ItemFlag[] {
  const strictest = strictestLimit(consumers)
  if (strictest && !strictest.accepted) {
    const reason = `${limitSource(strictest)} does not take ${kindPlural(kind)}.`
    return items.map(() => ({ status: 'unsupported', reason }))
  }
  const totals = new Map<string, number>()
  return items.map((item, index): ItemFlag => {
    if (!strictest) return { status: 'ok', reason: null }
    for (const consumer of consumers) {
      const issue = consumer.limit ? itemIssue(kind, item, consumer.limit, limitSource(consumer)) : null
      if (issue) return { status: 'incompatible', reason: issue }
    }
    if (index >= strictest.maxCount) {
      return {
        status: 'over_limit',
        reason: `${limitSource(strictest)} takes up to ${strictest.maxCount} ${noun(kind, strictest.maxCount)}.`,
      }
    }
    for (const consumer of consumers) {
      const max = consumer.limit?.max_total_duration_s ?? null
      const total = (totals.get(consumer.blockId) ?? 0) + (item.duration_s ?? 0)
      totals.set(consumer.blockId, total)
      if (max !== null && total > max) {
        return { status: 'over_limit', reason: `${limitSource(consumer)} takes ${seconds(max)} of ${kindPlural(kind)} in total.` }
      }
    }
    return { status: 'ok', reason: null }
  })
}

/** Remove the items flagged over the limit; everything else stays in order. */
export function removeExtras(items: readonly LoaderItem[], flags: readonly ItemFlag[]): LoaderItem[] {
  return items.filter((_, i) => flags[i]?.status !== 'over_limit')
}

export function moveItem(items: LoaderItem[], id: string, delta: -1 | 1): LoaderItem[] {
  const index = items.findIndex((i) => i.id === id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= items.length) return items
  const next = [...items]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

/** A sound reference passed between blocks (`audio` port). */
export interface SoundRef {
  kind: 'audio-ref'
  local: string
  url?: string
  label?: string
  size_bytes?: number
  duration_s?: number
}

export type LoaderRef = ImageRef | VideoRef | SoundRef

const REF_KIND = { image: 'image-ref', video: 'video-ref', audio: 'audio-ref' } as const

/**
 * Refs for the output port: saved items only, in order, with their metadata.
 * An item still saving, not saved, or `ready` without a file is left out, on
 * purpose and silently: the run blockers and `prepareRun` report the first two.
 */
export function itemsToOutput(kind: LoaderKind, items: readonly LoaderItem[]): LoaderRef[] {
  const out: LoaderRef[] = []
  for (const item of items) {
    if (item.status !== 'ready' || (!item.local && !item.url)) continue
    const meta = {
      label: item.label,
      ...(item.size_bytes != null ? { size_bytes: item.size_bytes } : {}),
      ...(item.width != null ? { width: item.width } : {}),
      ...(item.height != null ? { height: item.height } : {}),
      ...(item.duration_s != null ? { duration_s: item.duration_s } : {}),
      ...(item.character ? { character: item.character } : {}),
    }
    const local = item.local ?? item.url!
    const url = item.url && isHttp(item.url) ? { url: item.url } : {}
    out.push({ kind: REF_KIND[kind], local, ...url, ...meta } as LoaderRef)
  }
  return out
}
