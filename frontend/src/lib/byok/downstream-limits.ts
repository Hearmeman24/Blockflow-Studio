/**
 * The ledger limit a downstream generation block puts on one media kind,
 * computed from the catalog and the block's saved provider, model and
 * settings. Pure; the hook that finds the consumers is
 * `use-downstream-limits.ts`. No model rule is written here.
 */
import { findModel, getModeSpec, mediaLimit, modeName, modelAvailability, providerName } from './catalog'
import { kindPlural } from './check-references'
import { generationBlockConfig, resolveGenerationSelection } from './generation-blocks'
import type { GenerationMode, MediaKind, MediaLimit, ProviderCatalog, SettingValue } from './types'

export interface ConsumerRef {
  blockId: string
  type: string
  label: string
}

export interface StoredSelection {
  provider: string | null
  model: string | null
  params: { settings?: Record<string, unknown> } | null
}

export interface DownstreamLimit {
  blockId: string
  type: string
  /** The consumer block's label. */
  label: string
  mode: GenerationMode
  modeName: string
  provider: string | null
  providerName: string
  model: string | null
  modelName: string
  /** False when the selected model, in this mode on this provider, takes no items of this kind. */
  accepted: boolean
  /** Why the kind is not accepted, or null. */
  reason: string | null
  /** The ledger's per-kind limit, or null when not accepted. */
  limit: MediaLimit | null
  /** How many items of this kind the block can use: the ledger count capped by frame slots and the total cap. */
  maxCount: number
  /** Image to Video only: how many frame slots the model has (1, or 2 with a last frame); null elsewhere. */
  frameSlots: number | null
}

function settingsOf(params: StoredSelection['params']): Record<string, SettingValue> {
  const raw = params && typeof params === 'object' ? params.settings : undefined
  return raw && typeof raw === 'object' ? (raw as Record<string, SettingValue>) : {}
}

export function computeDownstreamLimit(
  catalog: ProviderCatalog,
  consumer: ConsumerRef,
  kind: MediaKind,
  stored: StoredSelection,
): DownstreamLimit | null {
  const config = generationBlockConfig(consumer.type)
  if (!config || !config.referenceKinds.includes(kind)) return null
  const { mode } = config
  const { provider, model } = resolveGenerationSelection(catalog, mode, stored.provider, stored.model)
  const names = {
    mode: modeName(catalog, mode),
    provider: provider ? providerName(catalog, provider) : 'no provider',
    model: (model && findModel(catalog, model)?.name) || model || 'no model',
  }
  const base = {
    blockId: consumer.blockId,
    type: consumer.type,
    label: consumer.label,
    mode,
    modeName: names.mode,
    provider,
    providerName: names.provider,
    model,
    modelName: names.model,
  }
  const spec = provider && model ? getModeSpec(catalog, provider, model, mode, settingsOf(stored.params)) : null
  if (!spec) {
    const why = provider && model ? modelAvailability(catalog, model, provider, mode).reason : null
    return {
      ...base,
      accepted: false,
      reason: why ? `${why}.` : `${consumer.label} has no model selected.`,
      limit: null,
      maxCount: 0,
      frameSlots: null,
    }
  }
  const limit = mediaLimit(spec, kind)
  if (!limit) {
    return {
      ...base,
      accepted: false,
      reason: `${names.model} does not accept ${kindPlural(kind)} in ${names.mode}.`,
      limit: null,
      maxCount: 0,
      frameSlots: null,
    }
  }
  let maxCount = limit.max_count
  const frameSlots = spec.frames && kind === 'image' ? (spec.frames.last_frame_allowed ? 2 : 1) : null
  if (frameSlots !== null) maxCount = Math.min(maxCount, frameSlots)
  if (spec.max_total_references !== null) maxCount = Math.min(maxCount, spec.max_total_references)
  return { ...base, accepted: true, reason: null, limit, maxCount, frameSlots }
}

/** The consumer that allows the fewest items; one that takes none comes first. Ties keep pipeline order. */
export function strictestLimit(limits: readonly DownstreamLimit[]): DownstreamLimit | null {
  let best: DownstreamLimit | null = null
  for (const limit of limits) {
    if (!best || limit.maxCount < best.maxCount) best = limit
  }
  return best
}

/** "Image to Video · Kling 4.0 Flash": where a limit comes from, for messages. */
export function limitSource(limit: Pick<DownstreamLimit, 'label' | 'modelName'>): string {
  return `${limit.label} · ${limit.modelName}`
}
