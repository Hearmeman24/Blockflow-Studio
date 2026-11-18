/**
 * Pure helpers over the provider catalog payload. Everything is derived from
 * the payload; no model name, limit or provider rule is written here.
 */
import type {
  CatalogModel,
  GenerationMode,
  MediaKind,
  MediaLimit,
  ModeSpec,
  ProviderCatalog,
  ProviderId,
  SettingValue,
} from './types'

export interface Availability {
  available: boolean
  reason: string | null
}

const AVAILABLE: Availability = { available: true, reason: null }

export function providerIds(catalog: ProviderCatalog): ProviderId[] {
  return Object.keys(catalog.providers)
}

export function providerName(catalog: ProviderCatalog | undefined, provider: ProviderId): string {
  return catalog?.providers[provider]?.name ?? provider
}

export function isProviderConfigured(catalog: ProviderCatalog, provider: ProviderId): boolean {
  return Boolean(catalog.providers[provider]?.configured)
}

export function configuredProviders(catalog: ProviderCatalog): ProviderId[] {
  return providerIds(catalog).filter((id) => isProviderConfigured(catalog, id))
}

/** The first configured provider, or null when no key is configured. */
export function defaultProvider(catalog: ProviderCatalog): ProviderId | null {
  return configuredProviders(catalog)[0] ?? null
}

export function modeName(catalog: ProviderCatalog | undefined, mode: GenerationMode): string {
  return catalog?.modes.find((m) => m.id === mode)?.name ?? mode
}

export function findModel(catalog: ProviderCatalog | undefined, modelId: string): CatalogModel | undefined {
  return catalog?.models.find((m) => m.id === modelId)
}

/** Why a provider cannot be used at all (no key). Reuses the ledger's wording. */
export function providerAvailability(catalog: ProviderCatalog, provider: ProviderId): Availability {
  if (isProviderConfigured(catalog, provider)) return AVAILABLE
  const fromLedger = catalog.models
    .map((m) => m.providers[provider])
    .find((status) => status?.offered && !status.configured)?.unavailable_reason
  return {
    available: false,
    reason: fromLedger ?? `Requires a ${providerName(catalog, provider)} API key`,
  }
}

function rawModeSpec(model: CatalogModel, provider: ProviderId, mode: GenerationMode): ModeSpec | undefined {
  const status = model.providers[provider]
  if (!status?.offered) return undefined
  return status.modes[mode]
}

/** Every model that supports `mode` on at least one provider, in catalog order. */
export function modelsForMode(catalog: ProviderCatalog, mode: GenerationMode): CatalogModel[] {
  return catalog.models.filter((model) =>
    Object.keys(model.providers).some((p) => rawModeSpec(model, p, mode)?.supported === true),
  )
}

/**
 * Whether `provider` can run `modelId` in `mode` right now, and if not, the
 * reason to show. Order: unknown model, not offered, mode unsupported, no key.
 */
export function modelAvailability(
  catalog: ProviderCatalog,
  modelId: string,
  provider: ProviderId,
  mode: GenerationMode,
): Availability {
  const model = findModel(catalog, modelId)
  if (!model) return { available: false, reason: `Unknown model ${modelId}` }
  const status = model.providers[provider]
  const name = providerName(catalog, provider)
  if (!status || !status.offered) {
    return { available: false, reason: status?.unavailable_reason ?? `Not offered by ${name}` }
  }
  const spec = status.modes[mode]
  if (!spec || !spec.supported) {
    return {
      available: false,
      reason: spec?.unavailable_reason ?? `${model.name} on ${name} does not support ${modeName(catalog, mode)}`,
    }
  }
  if (!status.configured) {
    return { available: false, reason: status.unavailable_reason ?? providerAvailability(catalog, provider).reason }
  }
  return AVAILABLE
}

export function firstSelectableModel(
  catalog: ProviderCatalog,
  mode: GenerationMode,
  provider: ProviderId,
): string | null {
  return modelsForMode(catalog, mode).find((m) => modelAvailability(catalog, m.id, provider, mode).available)?.id ?? null
}

/** The variant selected by `settings` (GPT Image tier), like the backend's `resolve_variant`. */
export function resolveVariant(spec: ModeSpec, settings: Record<string, SettingValue> | undefined): ModeSpec {
  if (!spec.variant_key) return spec
  const setting = spec.settings.find((s) => s.key === spec.variant_key)
  const value = settings?.[spec.variant_key] ?? setting?.default ?? null
  const match = spec.variants.find(([name]) => name === value)
  if (!match) return spec
  return { ...match[1], available: spec.available }
}

/**
 * The supported ModeSpec for one provider/model/mode, or null. Returned even
 * without a key so limits can be shown. With `settings`, the variant is applied.
 */
export function getModeSpec(
  catalog: ProviderCatalog | undefined,
  provider: ProviderId,
  modelId: string,
  mode: GenerationMode,
  settings?: Record<string, SettingValue>,
): ModeSpec | null {
  const model = findModel(catalog, modelId)
  if (!model) return null
  const spec = rawModeSpec(model, provider, mode)
  if (!spec || !spec.supported) return null
  return settings === undefined ? spec : resolveVariant(spec, settings)
}

export function mediaLimit(spec: ModeSpec | null | undefined, kind: MediaKind): MediaLimit | null {
  return spec?.media.find((limit) => limit.kind === kind) ?? null
}

export function acceptedKinds(spec: ModeSpec | null | undefined): MediaKind[] {
  return spec?.media.map((limit) => limit.kind) ?? []
}
