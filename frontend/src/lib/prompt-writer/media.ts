/**
 * Upstream media the Prompt Writer can send to its model, and which models
 * can take it.
 *
 * The files arrive on the block's `image`, `video` and `audio` input ports,
 * read with the same helpers the generation blocks use for loader
 * references (`lib/byok/references.ts`). The ticks ("Send to the model") are
 * saved under the `send_media` config key; a flow saved before the boxes
 * existed has none, which reads as all unticked.
 */
import { toRequestReference, upstreamReferences, type GenerationReference } from '@/lib/byok/references'
import type { RequestReference } from '@/lib/byok/types'
import { WRITER_MEDIA_KINDS, type WriterMediaKind, type WriterProviderStatus } from './types'

export const SEND_MEDIA_KEY = 'send_media'

export type SendMedia = Record<WriterMediaKind, boolean>

export const DEFAULT_SEND_MEDIA: SendMedia = Object.freeze({ image: false, video: false, audio: false }) as SendMedia

/** As the checkboxes name them: "Images (2)". */
export const MEDIA_LABELS: Record<WriterMediaKind, string> = { image: 'Images', video: 'Videos', audio: 'Audio' }
/** In sentences: "does not accept videos". */
const PLURAL: Record<WriterMediaKind, string> = { image: 'images', video: 'videos', audio: 'audio' }
/** In a model option's short reason: "Does not accept video". */
const SHORT: Record<WriterMediaKind, string> = { image: 'images', video: 'video', audio: 'audio' }

/** What a local server (Ollama, LM Studio) can ever take besides text. */
const LOCAL_KINDS: ReadonlySet<WriterMediaKind> = new Set(['image'])

export function normalizeSendMedia(raw: unknown): SendMedia {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_SEND_MEDIA }
  const r = raw as Record<string, unknown>
  return { image: r.image === true, video: r.video === true, audio: r.audio === true }
}

/** true / false for a listed model; null when unknown (a model ID typed by hand). Local servers never take video or audio. */
export function modelAccepts(provider: WriterProviderStatus, modelId: string, kind: WriterMediaKind): boolean | null {
  if (provider.kind === 'local' && !LOCAL_KINDS.has(kind)) return false
  const model = provider.models.find((m) => m.id === modelId)
  return model ? model.accepts.includes(kind) : null
}

/** Why a model cannot be chosen while `kinds` are ticked, e.g. "Does not accept video". */
export function unavailableReason(
  provider: WriterProviderStatus,
  modelId: string,
  kinds: readonly WriterMediaKind[],
): string | null {
  const refused = kinds.find((k) => modelAccepts(provider, modelId, k) === false)
  return refused ? `Does not accept ${SHORT[refused]}` : null
}

/**
 * The error that blocks a run while `kinds` are ticked: no model of the
 * provider takes a kind, or the selected one does not. Null when the run can go.
 */
export function mediaBlocker(
  provider: WriterProviderStatus,
  modelId: string,
  kinds: readonly WriterMediaKind[],
): string | null {
  for (const kind of kinds) {
    const anyModel = provider.kind === 'local' && !LOCAL_KINDS.has(kind)
      ? false
      : provider.models.length === 0 || provider.models.some((m) => m.accepts.includes(kind))
    if (!anyModel) {
      const elsewhere = provider.kind === 'local'
        ? `, or choose OpenRouter and a model that accepts ${PLURAL[kind]}`
        : ''
      return `No ${provider.label} model accepts ${PLURAL[kind]}. Untick ${MEDIA_LABELS[kind]}${elsewhere}.`
    }
  }
  if (!modelId) return null
  const refused = kinds.find((k) => modelAccepts(provider, modelId, k) === false)
  if (!refused) return null
  const name = provider.models.find((m) => m.id === modelId)?.name ?? modelId
  return `${name} does not accept ${PLURAL[refused]}. Pick a model that accepts ${PLURAL[refused]}, or untick ${MEDIA_LABELS[refused]}.`
}

export interface UpstreamMedia {
  refs: GenerationReference[]
  counts: Record<WriterMediaKind, number>
}

/** The media on the input ports, in upstream order, with a count per kind. */
export function upstreamMedia(inputs: Record<string, unknown>, kinds: readonly WriterMediaKind[] = WRITER_MEDIA_KINDS): UpstreamMedia {
  const refs = upstreamReferences(inputs, kinds)
  const counts = { image: 0, video: 0, audio: 0 }
  for (const ref of refs) counts[ref.kind as WriterMediaKind] += 1
  return { refs, counts }
}

/** References as the backend takes them. */
export function toMediaRequest(refs: readonly GenerationReference[]): RequestReference[] {
  return refs.map((ref) => toRequestReference(ref, 'reference'))
}
