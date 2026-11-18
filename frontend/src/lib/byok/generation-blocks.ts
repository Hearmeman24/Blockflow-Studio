/**
 * The five generation blocks by block type, and how a block's saved provider
 * and model resolve against the catalog. Shared by the blocks themselves and by
 * loaders that show the limits of the generation blocks they feed.
 */
import { defaultProvider, firstSelectableModel, modelsForMode, providerIds } from './catalog'
import type { GenerationMode, MediaKind, ProviderCatalog } from './types'

export interface GenerationBlockConfig {
  mode: GenerationMode
  output: 'image' | 'video'
  /** Reference kinds this block shows, in display order. Empty for text-only modes. */
  referenceKinds: MediaKind[]
}

export const GENERATION_BLOCK_CONFIGS: Readonly<Record<string, GenerationBlockConfig>> = Object.freeze({
  textToVideo: { mode: 'text_to_video', output: 'video', referenceKinds: [] },
  imageToVideo: { mode: 'image_to_video', output: 'video', referenceKinds: ['image'] },
  textToImage: { mode: 'text_to_image', output: 'image', referenceKinds: [] },
  imageToImage: { mode: 'image_to_image', output: 'image', referenceKinds: ['image'] },
  omniReferenceToVideo: {
    mode: 'omni_reference_to_video',
    output: 'video',
    referenceKinds: ['video', 'image', 'audio'],
  },
})

export function generationBlockConfig(type: string): GenerationBlockConfig | null {
  return Object.prototype.hasOwnProperty.call(GENERATION_BLOCK_CONFIGS, type) ? GENERATION_BLOCK_CONFIGS[type] : null
}

export interface GenerationSelection {
  provider: string | null
  model: string | null
}

/**
 * The provider and model a generation block uses: the saved values when the
 * catalog still lists them, else the first configured provider and the first
 * selectable model for the mode. Without a catalog the saved values are kept.
 */
export function resolveGenerationSelection(
  catalog: ProviderCatalog | undefined,
  mode: GenerationMode,
  storedProvider: string | null | undefined,
  storedModel: string | null | undefined,
): GenerationSelection {
  if (!catalog) return { provider: storedProvider ?? null, model: storedModel ?? null }
  const ids = providerIds(catalog)
  const provider = storedProvider && ids.includes(storedProvider)
    ? storedProvider
    : defaultProvider(catalog) ?? ids[0] ?? null
  if (!provider) return { provider: null, model: storedModel ?? null }
  const listed = modelsForMode(catalog, mode)
  const model = storedModel && listed.some((m) => m.id === storedModel)
    ? storedModel
    : firstSelectableModel(catalog, mode, provider) ?? listed[0]?.id ?? null
  return { provider, model }
}
