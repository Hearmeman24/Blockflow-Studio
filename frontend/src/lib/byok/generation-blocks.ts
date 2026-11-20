/**
 * The generation blocks by block type, and how a block's saved provider
 * and model resolve against the catalog. Shared by the blocks themselves and by
 * loaders that show the limits of the generation blocks they feed.
 */
import { defaultProvider, modelAvailability, modelsForMode, providerIds } from './catalog'
import { mentionText } from './mentions'
import type { CatalogModel, GenerationMode, MediaKind, ModeSpec, ProviderCatalog } from './types'

export interface GenerationBlockConfig {
  mode: GenerationMode
  output: 'image' | 'video'
  /** Reference kinds this block shows, in display order. Empty for text-only modes. */
  referenceKinds: MediaKind[]
  /** Catalog model ids this block offers, in display order. Omitted: every model the ledger lists for the mode. */
  models?: readonly string[]
  /** The prompt a fresh block starts with; the user can edit it. `{image1}`, `{video1}`, `{audio1}`
   *  (any number) become the ledger's way of naming that reference for the selected provider and
   *  model. While the stored prompt is this template in any of the ledger's syntaxes
   *  (`isDefaultPrompt`), it follows the selected model; an edit is kept as written. */
  defaultPrompt?: string
  /** False: the block never takes its prompt from an upstream text block (no switch). Default true. */
  upstreamPrompt?: boolean
  /** True: the block needs a prompt whatever the ledger's prompt rule says; an empty or
   *  whitespace-only prompt is a blocking issue and the run stops before anything is sent. */
  promptRequired?: boolean
  /** Kinds the block uses an exact number of; any other count stops the run. */
  exactReferences?: Partial<Record<MediaKind, number>>
  /** The loader block type that supplies each kind. Omitted: the mode's one loader. */
  loaders?: Partial<Record<MediaKind, string>>
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
  // One driving video and one image of the person, through the ledger's Omni Reference mode.
  characterSwap: {
    mode: 'omni_reference_to_video',
    output: 'video',
    referenceKinds: ['video', 'image'],
    models: ['wan-3.0', 'wan-3.0-prime', 'seedance-2.5', 'seedance-2', 'kling-4.0'],
    defaultPrompt: 'Replace the person from {video1} with the person from {image1}',
    upstreamPrompt: false,
    // A swap without an instruction would spend credits for nothing, even where the ledger allows it.
    promptRequired: true,
    exactReferences: { video: 1, image: 1 },
    loaders: { video: 'videoLoader', image: 'uploadImageToTmpfiles' },
  },
})

export function generationBlockConfig(type: string): GenerationBlockConfig | null {
  return Object.prototype.hasOwnProperty.call(GENERATION_BLOCK_CONFIGS, type) ? GENERATION_BLOCK_CONFIGS[type] : null
}

/** The block type that owns a config, e.g. "characterSwap". */
export function generationBlockType(config: GenerationBlockConfig): string {
  return Object.keys(GENERATION_BLOCK_CONFIGS).find((type) => GENERATION_BLOCK_CONFIGS[type] === config) ?? ''
}

/**
 * The models a block offers: every model the ledger lists for the mode, or
 * only the block's own list, in the block's order. An id the catalog does not
 * list for the mode is dropped.
 */
export function modelsForBlock(
  catalog: ProviderCatalog,
  config: Pick<GenerationBlockConfig, 'mode' | 'models'>,
): CatalogModel[] {
  const listed = modelsForMode(catalog, config.mode)
  if (!config.models) return listed
  return config.models.flatMap((id) => listed.filter((m) => m.id === id))
}

/** A block's default prompt with each `{kindN}` written the way the selected mode names that reference. */
export function defaultPromptText(template: string, spec: ModeSpec | null | undefined): string {
  return template.replace(/\{(image|video|audio)(\d+)\}/g, (_, kind: MediaKind, n: string) => mentionText(spec, kind, Number(n)))
}

/**
 * Whether a stored prompt is still the block's default: the template written
 * in the plain syntax or in the syntax of any provider, model (or variant) the
 * catalog lists for the mode. Anything else, an empty prompt included, is the
 * user's own text. Decided from the text alone, so a flow or run saved before
 * the prompt was editable (it holds the default text) loads as the default.
 */
export function isDefaultPrompt(
  text: string,
  template: string,
  catalog: ProviderCatalog | undefined,
  mode: GenerationMode,
): boolean {
  if (text === defaultPromptText(template, null)) return true
  for (const model of catalog?.models ?? []) {
    for (const status of Object.values(model.providers)) {
      const spec = status.modes[mode]
      if (!spec) continue
      if (text === defaultPromptText(template, spec)) return true
      if (spec.variants.some(([, variant]) => text === defaultPromptText(template, variant))) return true
    }
  }
  return false
}

/** "a" or "an" before a block or media label. */
export function article(label: string): string {
  return /^[aeiou]/i.test(label) ? 'an' : 'a'
}

export interface GenerationSelection {
  provider: string | null
  model: string | null
}

/**
 * The provider and model a generation block uses: the saved values when the
 * catalog still lists them (and the block offers them), else the first
 * configured provider and the first selectable model the block offers.
 * Without a catalog the saved values are kept.
 */
export function resolveGenerationSelection(
  catalog: ProviderCatalog | undefined,
  mode: GenerationMode,
  storedProvider: string | null | undefined,
  storedModel: string | null | undefined,
  models?: readonly string[],
): GenerationSelection {
  if (!catalog) return { provider: storedProvider ?? null, model: storedModel ?? null }
  const ids = providerIds(catalog)
  const provider = storedProvider && ids.includes(storedProvider)
    ? storedProvider
    : defaultProvider(catalog) ?? ids[0] ?? null
  if (!provider) return { provider: null, model: storedModel ?? null }
  const listed = modelsForBlock(catalog, { mode, models })
  const model = storedModel && listed.some((m) => m.id === storedModel)
    ? storedModel
    : listed.find((m) => modelAvailability(catalog, m.id, provider, mode).available)?.id ?? listed[0]?.id ?? null
  return { provider, model }
}
