/**
 * The reference model used by the generation blocks: upstream references from
 * the block's input ports plus references added in the block, in order.
 */
import { restoreTransferStatus } from './transfer-status'
import { MEDIA_KINDS, type GenerationMode, type MediaKind, type ReferenceRole, type RequestReference } from './types'

/** Stored as is (old flows, the legacy session key); the lifecycle is in `transfer-status.ts`. */
export type ReferenceUploadStatus = 'uploading' | 'ready' | 'error'

export interface GenerationReference {
  id: string
  kind: MediaKind
  role: ReferenceRole
  /** `/outputs/...` path of the durable local copy. */
  local?: string
  /** Remote http(s) URL. */
  url?: string
  /** File name shown in the list. */
  label?: string
  /** The character the reference comes from (Load Character block), for the badge label. */
  character?: string
  duration_s?: number
  size_bytes?: number
  width?: number
  height?: number
  format?: string
  status?: ReferenceUploadStatus
  error?: string
}

export type ReferenceSource = 'upstream' | 'local'

export interface ReferenceEntry {
  ref: GenerationReference
  source: ReferenceSource
}

const OUTPUTS_PREFIX = '/outputs/'

function isHttp(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim())
}

function isOutputsPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().startsWith(OUTPUTS_PREFIX)
}

export function fileLabel(value: string | undefined): string | undefined {
  if (!value) return undefined
  const path = value.split('?')[0].split('#')[0]
  const name = path.split('/').filter(Boolean).pop()
  if (!name) return undefined
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

function flatten(value: unknown): unknown[] {
  if (value == null) return []
  if (Array.isArray(value)) return value.flatMap(flatten)
  return [value]
}

function fromUpstreamValue(kind: MediaKind, value: unknown, index: number): GenerationReference | null {
  let localCandidate: unknown
  let urlCandidate: unknown
  if (typeof value === 'string') {
    if (!value.trim()) return null
    localCandidate = value
    urlCandidate = value
  } else if (value && typeof value === 'object') {
    const obj = value as { local?: unknown; url?: unknown }
    localCandidate = obj.local
    urlCandidate = isHttp(obj.url) ? obj.url : obj.local
  } else {
    return null
  }
  const localPath = isOutputsPath(localCandidate) ? localCandidate.trim() : undefined
  const url = isHttp(urlCandidate) ? urlCandidate.trim() : undefined
  const ref: GenerationReference = {
    id: `upstream:${kind}:${index}`,
    kind,
    role: 'reference',
    ...(localPath ? { local: localPath } : {}),
    ...(url ? { url } : {}),
    label: fileLabel(localPath ?? url ?? (typeof localCandidate === 'string' ? localCandidate : undefined)),
    status: 'ready',
  }
  if (value && typeof value === 'object') {
    // Metadata a loader attaches (`ImageRef` / `VideoRef`), for limit checks.
    const meta = value as Record<string, unknown>
    if (typeof meta.label === 'string' && meta.label) ref.label = meta.label
    // A reference from a Load Character block names its character.
    if (typeof meta.character === 'string' && meta.character.trim()) ref.character = meta.character
    for (const key of ['size_bytes', 'width', 'height', 'duration_s'] as const) {
      if (typeof meta[key] === 'number' && Number.isFinite(meta[key])) ref[key] = meta[key] as number
    }
  }
  if (!localPath && !url) {
    ref.status = 'error'
    ref.error = 'The upstream file has not been saved yet. Run the upstream block or re-add the file.'
  }
  return ref
}

/** References arriving on the block's input ports, one port per media kind. */
export function upstreamReferences(inputs: Record<string, unknown>, kinds: readonly MediaKind[]): GenerationReference[] {
  const out: GenerationReference[] = []
  for (const kind of kinds) {
    flatten(inputs[kind]).forEach((value, i) => {
      const ref = fromUpstreamValue(kind, value, i)
      if (ref) out.push(ref)
    })
  }
  return out
}

/**
 * Upstream references first, then the block's own, in order. In Image to Video
 * the images take the first frame, then the last frame, by position; anything
 * after that stays a plain reference and is flagged by the checks.
 */
export function combineReferences(
  mode: GenerationMode,
  upstream: readonly GenerationReference[],
  local: readonly GenerationReference[],
): ReferenceEntry[] {
  const entries: ReferenceEntry[] = [
    ...upstream.map((ref) => ({ ref, source: 'upstream' as const })),
    ...local.map((ref) => ({ ref, source: 'local' as const })),
  ]
  if (mode !== 'image_to_video') {
    return entries.map((e) => (e.ref.role === 'reference' ? e : { ...e, ref: { ...e.ref, role: 'reference' } }))
  }
  const frameRoles: ReferenceRole[] = ['first_frame', 'last_frame']
  let imageIndex = 0
  return entries.map((entry) => {
    if (entry.ref.kind !== 'image') return entry
    const role = frameRoles[imageIndex] ?? 'reference'
    imageIndex += 1
    return entry.ref.role === role ? entry : { ...entry, ref: { ...entry.ref, role } }
  })
}

/** Swap a reference with its neighbour of the same kind (each kind is listed on its own). */
export function moveReference(list: GenerationReference[], id: string, delta: -1 | 1): GenerationReference[] {
  const index = list.findIndex((r) => r.id === id)
  if (index < 0) return list
  let target = index + delta
  while (target >= 0 && target < list.length && list[target].kind !== list[index].kind) target += delta
  if (target < 0 || target >= list.length) return list
  const next = [...list]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

export function removeReference(list: GenerationReference[], id: string): GenerationReference[] {
  return list.filter((r) => r.id !== id)
}

export function toRequestReference(ref: GenerationReference, role: ReferenceRole): RequestReference {
  const out: RequestReference = { kind: ref.kind, role }
  if (ref.local) out.local = ref.local
  if (ref.url) out.url = ref.url
  if (ref.duration_s != null) out.duration_s = ref.duration_s
  if (ref.size_bytes != null) out.size_bytes = ref.size_bytes
  if (ref.width != null) out.width = ref.width
  if (ref.height != null) out.height = ref.height
  if (ref.format) out.format = ref.format
  return out
}

const NUMBER_FIELDS = ['duration_s', 'size_bytes', 'width', 'height'] as const
const STRING_FIELDS = ['local', 'url', 'label', 'character', 'format', 'error'] as const

/** Legacy: flows saved before voice became audio have `kind: 'voice'` references. */
const LEGACY_KINDS: Readonly<Record<string, MediaKind>> = { voice: 'audio' }

function kindOf(raw: unknown): MediaKind | null {
  if ((MEDIA_KINDS as readonly unknown[]).includes(raw)) return raw as MediaKind
  return typeof raw === 'string' ? LEGACY_KINDS[raw] ?? null : null
}

/** Sanitise references read back from session storage or a saved flow. A saved voice reads as audio. */
export function restoreReferences(raw: unknown): GenerationReference[] {
  if (!Array.isArray(raw)) return []
  const out: GenerationReference[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const kind = kindOf(row.kind)
    if (typeof row.id !== 'string' || !kind) continue
    const ref: GenerationReference = {
      id: row.id,
      kind,
      role: row.role === 'first_frame' || row.role === 'last_frame' ? row.role : 'reference',
    }
    for (const key of STRING_FIELDS) if (typeof row[key] === 'string') ref[key] = row[key] as string
    for (const key of NUMBER_FIELDS) if (typeof row[key] === 'number' && Number.isFinite(row[key])) ref[key] = row[key] as number
    // A missing or unknown status stays unset.
    const status = restoreTransferStatus(row.status, 'uploading')
    if (status === 'interrupted') {
      ref.status = 'error'
      ref.error = 'The upload was interrupted. Remove this reference and add the file again.'
    } else if (status) {
      ref.status = status
    }
    out.push(ref)
  }
  return out
}
