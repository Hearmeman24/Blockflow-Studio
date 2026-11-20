/**
 * Client-side mirror of the ledger's reference rules
 * (`backend/byok/validation.py::_check_references`) for instant feedback.
 * Issues use the backend's `{code, severity, field, message, limit, actual}`
 * shape and wording. The backend validate route stays authoritative: it is
 * called before every submit, and it also runs the cross-field `rules` this
 * mirror does not. Nothing here mutates its inputs.
 */
import { mediaLimit } from './catalog'
import {
  MEDIA_KINDS,
  REFERENCE_ROLES,
  type GenerationIssue,
  type MediaKind,
  type MediaLimit,
  type ModeSpec,
} from './types'

export interface CheckableReference {
  kind: MediaKind
  role?: string
  name?: string
  url?: string
  local?: string
  format?: string
  size_bytes?: number
  duration_s?: number
  width?: number
  height?: number
}

export interface CheckContext {
  modelName: string
  providerName: string
  modeName: string
}

const KIND_PLURAL: Record<MediaKind, string> = {
  image: 'images',
  video: 'videos',
  audio: 'audio clips',
}

const SOUND_KINDS: ReadonlySet<string> = new Set(['audio'])
const KNOWN_EXTS: ReadonlySet<string> = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'tif', 'gif', 'heic', 'heif',
  'mp4', 'mov', 'mkv', 'webm', 'm4v',
  'mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a',
])

const KIND_SINGULAR: Record<MediaKind, string> = { image: 'image', video: 'video', audio: 'audio clip' }

/** "1 image", "2 images". */
export function countOf(n: number, kind: MediaKind): string {
  return `${n} ${n === 1 ? KIND_SINGULAR[kind] ?? kind : KIND_PLURAL[kind] ?? kind}`
}

export function kindPlural(kind: MediaKind): string {
  return KIND_PLURAL[kind] ?? kind
}

export function kindSingular(kind: MediaKind): string {
  return KIND_SINGULAR[kind] ?? kind
}

function isKnownKind(kind: string): kind is MediaKind {
  return (MEDIA_KINDS as readonly string[]).includes(kind)
}

function hasSource(ref: CheckableReference): boolean {
  return Boolean(ref.url?.trim() || ref.local?.trim())
}

function roleOf(ref: CheckableReference): string {
  return ref.role || 'reference'
}

/** File extension of a reference, as the backend's `reference_format`. */
export function referenceFormat(ref: CheckableReference): string | null {
  if (ref.format) return ref.format.toLowerCase().replace(/^\./, '')
  const source = ref.url || ref.local || ''
  let path = source
  try {
    if (source.includes('://')) path = new URL(source).pathname
  } catch {
    path = source
  }
  const match = /\.([A-Za-z0-9]+)$/.exec(path.split('?')[0].split('#')[0])
  const ext = match?.[1]?.toLowerCase()
  return ext && KNOWN_EXTS.has(ext) ? ext : null
}

function formatSeconds(n: number): string {
  return String(Number(n.toPrecision(6)))
}

function mb(n: number): string {
  return `${(n / 1_000_000).toFixed(1)} MB`
}

export function checkReferences(
  spec: ModeSpec,
  refs: ReadonlyArray<CheckableReference>,
  ctx: CheckContext,
): GenerationIssue[] {
  const issues: GenerationIssue[] = []
  const where = `${ctx.modelName} on ${ctx.providerName}`
  const error = (code: string, field: string, message: string, limit: unknown = null, actual: unknown = null) => {
    issues.push({ code, severity: 'error', field, message, limit, actual })
  }

  const byKind = new Map<MediaKind, Array<[number, CheckableReference]>>()
  refs.forEach((ref, i) => {
    const field = `references[${i}]`
    if (!isKnownKind(ref.kind)) {
      error('unknown_media_kind', `${field}.kind`, `Unknown media kind '${ref.kind}'. Use one of: ${MEDIA_KINDS.join(', ')}.`)
      return
    }
    if (!hasSource(ref)) error('reference_url_missing', `${field}.url`, 'This reference has no file or URL.')
    if (!(REFERENCE_ROLES as readonly string[]).includes(roleOf(ref))) {
      error('invalid_reference_role', `${field}.role`, `Unknown reference role '${ref.role}'.`)
    }
    const list = byKind.get(ref.kind) ?? []
    list.push([i, ref])
    byKind.set(ref.kind, list)
  })

  for (const [kind, items] of byKind) {
    const limit = mediaLimit(spec, kind)
    if (!limit) {
      error('media_kind_not_accepted', `references.${kind}`,
        `${where} does not accept ${KIND_PLURAL[kind]} in ${ctx.modeName}. Remove ${countOf(items.length, kind)}.`,
        0, items.length)
      continue
    }
    if (items.length > limit.max_count) {
      error('too_many_references', `references.${kind}`,
        `${where} accepts at most ${countOf(limit.max_count, kind)}; remove ${items.length - limit.max_count}.`,
        limit.max_count, items.length)
    }
    checkItems(kind, limit, items, where, error)
  }

  for (const limit of spec.media) {
    const count = byKind.get(limit.kind)?.length ?? 0
    if (count < limit.min_count) {
      error('too_few_references', `references.${limit.kind}`,
        `${where} needs at least ${countOf(limit.min_count, limit.kind)}.`, limit.min_count, count)
    }
  }

  const known = refs.filter((r) => isKnownKind(r.kind))
  const total = known.length
  if (spec.max_total_references !== null && total > spec.max_total_references) {
    error('too_many_total_references', 'references',
      `${where} accepts at most ${spec.max_total_references} references in total; remove ${total - spec.max_total_references}.`,
      spec.max_total_references, total)
  }
  if (spec.frames === null && total < spec.min_total_references) {
    error('too_few_references', 'references',
      `${ctx.modeName} needs at least ${spec.min_total_references} ${spec.min_total_references === 1 ? 'reference' : 'references'}.`, spec.min_total_references, total)
  }
  const kinds = new Set(known.map((r) => r.kind))
  if (kinds.size > 1 && !spec.mixed_media_allowed) {
    const sorted = [...kinds].sort()
    error('mixed_media_not_allowed', 'references', `${where} cannot mix ${sorted.join(', ')} in ${ctx.modeName}.`, null, sorted)
  }
  if (kinds.size > 0 && [...kinds].every((k) => SOUND_KINDS.has(k)) && !spec.audio_only_allowed && spec.media.length > 0) {
    error('audio_only_not_allowed', 'references',
      `${where} needs at least one image or video alongside audio references.`)
  }

  if (spec.frames !== null) {
    checkFrames(spec, known, where, error)
  } else {
    refs.forEach((ref, i) => {
      const role = roleOf(ref)
      if ((REFERENCE_ROLES as readonly string[]).includes(role) && role !== 'reference') {
        error('invalid_reference_role', `references[${i}].role`,
          `${ctx.modeName} does not use a ${role.replace('_', ' ')}; mark it as a reference or switch to Image to Video.`)
      }
    })
  }
  return issues
}

type ErrorFn = (code: string, field: string, message: string, limit?: unknown, actual?: unknown) => void

function checkFrames(spec: ModeSpec, refs: CheckableReference[], where: string, error: ErrorFn) {
  const frames = spec.frames!
  const firsts = refs.filter((r) => roleOf(r) === 'first_frame')
  const lasts = refs.filter((r) => roleOf(r) === 'last_frame')
  if (refs.some((r) => roleOf(r) === 'reference')) {
    error('invalid_reference_role', 'references',
      'Image to Video only takes a first frame and an optional last frame. Use Omni Reference to Video for other references.')
  }
  if (frames.first_frame_required && firsts.length === 0) {
    error('first_frame_required', 'references.first_frame', 'Add a first frame image.', 1, 0)
  }
  if (firsts.length > 1) error('duplicate_frame', 'references.first_frame', 'Only one first frame is allowed.', 1, firsts.length)
  if (lasts.length > 0 && !frames.last_frame_allowed) {
    error('last_frame_not_supported', 'references.last_frame', `${where} does not support a last frame. Remove it.`, 0, lasts.length)
  } else if (lasts.length > 1) {
    error('duplicate_frame', 'references.last_frame', 'Only one last frame is allowed.', 1, lasts.length)
  }
  if (lasts.length > 0 && firsts.length === 0) {
    error('first_frame_required', 'references.first_frame', 'A last frame needs a first frame.', 1, 0)
  }
}

function checkItems(
  kind: MediaKind,
  limit: MediaLimit,
  items: Array<[number, CheckableReference]>,
  where: string,
  error: ErrorFn,
) {
  const durations: number[] = []
  let allKnown = true
  for (const [i, ref] of items) {
    const field = `references[${i}]`
    const fmt = referenceFormat(ref)
    if (limit.formats.length > 0 && fmt && !limit.formats.includes(fmt)) {
      error('invalid_format', `${field}.format`,
        `${where} does not accept .${fmt} ${KIND_PLURAL[kind]}. Use ${limit.formats.join(', ')}.`, [...limit.formats], fmt)
    }
    if (limit.max_size_bytes !== null && ref.size_bytes != null && ref.size_bytes > limit.max_size_bytes) {
      error('file_too_large', `${field}.size_bytes`,
        `This file is ${mb(ref.size_bytes)}; ${where} accepts at most ${mb(limit.max_size_bytes)} per file.`,
        limit.max_size_bytes, ref.size_bytes)
    }
    if (ref.duration_s == null) {
      allKnown = false
    } else {
      durations.push(ref.duration_s)
      if (limit.min_duration_s !== null && ref.duration_s < limit.min_duration_s) {
        error('reference_duration_out_of_range', `${field}.duration_s`,
          `Each reference must be at least ${formatSeconds(limit.min_duration_s)} s long.`, limit.min_duration_s, ref.duration_s)
      }
      if (limit.max_duration_s !== null && ref.duration_s > limit.max_duration_s) {
        error('reference_duration_out_of_range', `${field}.duration_s`,
          `Each reference can be at most ${formatSeconds(limit.max_duration_s)} s long. Trim it.`, limit.max_duration_s, ref.duration_s)
      }
    }
    if (ref.width != null && ref.height != null) {
      const { width: w, height: h } = ref
      if (limit.min_side_px !== null && Math.min(w, h) < limit.min_side_px) {
        error('dimension_out_of_range', `${field}.width`,
          `Each side must be at least ${limit.min_side_px} px (this is ${w}x${h}).`, limit.min_side_px, Math.min(w, h))
      }
      if (limit.max_side_px !== null && Math.max(w, h) > limit.max_side_px) {
        error('dimension_out_of_range', `${field}.width`,
          `Each side must be at most ${limit.max_side_px} px (this is ${w}x${h}).`, limit.max_side_px, Math.max(w, h))
      }
    }
  }
  const total = durations.reduce((a, b) => a + b, 0)
  if (limit.max_total_duration_s !== null && total > limit.max_total_duration_s) {
    error('total_duration_exceeded', `references.${kind}`,
      `All ${KIND_PLURAL[kind]} together are ${formatSeconds(total)} s; ${where} accepts at most ${formatSeconds(limit.max_total_duration_s)} s in total.`,
      limit.max_total_duration_s, total)
  }
  if (limit.min_total_duration_s !== null && allKnown && durations.length > 0 && total < limit.min_total_duration_s) {
    error('total_duration_too_short', `references.${kind}`,
      `All ${KIND_PLURAL[kind]} together must be at least ${formatSeconds(limit.min_total_duration_s)} s.`,
      limit.min_total_duration_s, total)
  }
}

// ---- Per-item status for the reference lists ----

export type ReferenceItemStatus = 'ok' | 'incompatible' | 'over_limit' | 'broken'

export interface ReferenceItemCheck {
  status: ReferenceItemStatus
  reason: string | null
}

/**
 * One status per reference, in input order, so a list can flag exactly which
 * items are excess or incompatible. Items are never dropped.
 */
export function referenceItemStatuses(
  spec: ModeSpec | null,
  refs: ReadonlyArray<CheckableReference>,
): ReferenceItemCheck[] {
  const seenByKind = new Map<string, number>()
  let seenTotal = 0
  let firstFrames = 0
  let lastFrames = 0
  return refs.map((ref) => {
    if (!hasSource(ref)) return { status: 'broken', reason: 'This reference has no file or URL' }
    if (!spec) return { status: 'incompatible', reason: 'The selected model cannot use references here' }
    const limit = isKnownKind(ref.kind) ? mediaLimit(spec, ref.kind) : null
    if (!limit) return { status: 'incompatible', reason: `Not accepted in this mode` }
    const fmt = referenceFormat(ref)
    if (limit.formats.length > 0 && fmt && !limit.formats.includes(fmt)) {
      return { status: 'incompatible', reason: `.${fmt} is not accepted; use ${limit.formats.join(', ')}` }
    }
    const role = roleOf(ref)
    if (spec.frames) {
      if (role === 'reference') return { status: 'incompatible', reason: 'Only a first and a last frame are used' }
      if (role === 'last_frame') {
        if (!spec.frames.last_frame_allowed) return { status: 'incompatible', reason: 'This model does not take a last frame' }
        lastFrames += 1
        if (lastFrames > 1) return { status: 'incompatible', reason: 'Only one last frame is allowed' }
      }
      if (role === 'first_frame') {
        firstFrames += 1
        if (firstFrames > 1) return { status: 'incompatible', reason: 'Only one first frame is allowed' }
      }
    } else if (role !== 'reference') {
      return { status: 'incompatible', reason: 'Frame roles only apply to Image to Video' }
    }
    const index = seenByKind.get(ref.kind) ?? 0
    seenByKind.set(ref.kind, index + 1)
    seenTotal += 1
    if (index >= limit.max_count) {
      return { status: 'over_limit', reason: `Over the limit of ${countOf(limit.max_count, ref.kind)}` }
    }
    if (spec.max_total_references !== null && seenTotal > spec.max_total_references) {
      return { status: 'over_limit', reason: `Over the total limit of ${spec.max_total_references} references` }
    }
    return { status: 'ok', reason: null }
  })
}
