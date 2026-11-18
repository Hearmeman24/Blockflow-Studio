import { describe, expect, it } from 'vitest'
import { CATALOG_BOTH, CATALOG_KIE, CATALOG_NONE, CATALOG_PIAPI } from './__fixtures__'
import {
  acceptedKinds,
  configuredProviders,
  defaultProvider,
  findModel,
  firstSelectableModel,
  getModeSpec,
  mediaLimit,
  modelAvailability,
  modelsForMode,
  providerAvailability,
  providerIds,
  providerName,
} from './catalog'

const ids = (models: Array<{ id: string }>) => models.map((m) => m.id)

describe('providers', () => {
  it('lists providers in payload order with display names', () => {
    expect(providerIds(CATALOG_BOTH)).toEqual(['kie', 'piapi'])
    expect(providerName(CATALOG_BOTH, 'piapi')).toBe('PiAPI')
    expect(providerName(CATALOG_BOTH, 'unknown')).toBe('unknown')
  })

  it.each([
    ['both', CATALOG_BOTH, ['kie', 'piapi'], 'kie'],
    ['kie', CATALOG_KIE, ['kie'], 'kie'],
    ['piapi', CATALOG_PIAPI, ['piapi'], 'piapi'],
    ['none', CATALOG_NONE, [], null],
  ] as const)('configured providers and default with %s keys', (_name, catalog, configured, fallback) => {
    expect(configuredProviders(catalog)).toEqual(configured)
    expect(defaultProvider(catalog)).toBe(fallback)
  })

  it('explains why a provider without a key cannot be used', () => {
    expect(providerAvailability(CATALOG_KIE, 'kie')).toEqual({ available: true, reason: null })
    expect(providerAvailability(CATALOG_KIE, 'piapi')).toEqual({
      available: false,
      reason: 'Requires a PiAPI API key',
    })
    expect(providerAvailability(CATALOG_NONE, 'kie').reason).toBe('Requires a Kie API key')
  })
})

describe('modelsForMode', () => {
  it('lists every model that supports the mode on any provider, in catalog order', () => {
    expect(ids(modelsForMode(CATALOG_BOTH, 'text_to_image'))).toEqual([
      'seedream-5-pro', 'seedream-5-flash', 'seedream-5-lite', 'seedream-5.5', 'gpt-image-2.6', 'minimax-h3-image',
    ])
    // The upscaler only supports Image to Image.
    expect(ids(modelsForMode(CATALOG_BOTH, 'image_to_image'))).toContain('image-upscaler')
    expect(ids(modelsForMode(CATALOG_BOTH, 'text_to_video'))).not.toContain('seedream-5-pro')
  })

  it('keeps a model listed when only one provider supports the mode', () => {
    // Seedance 2.5 image-to-video exists on Kie only.
    expect(ids(modelsForMode(CATALOG_BOTH, 'image_to_video'))).toContain('seedance-2.5')
  })

  it('does not depend on which keys are configured', () => {
    for (const mode of ['text_to_video', 'image_to_video', 'omni_reference_to_video', 'text_to_image', 'image_to_image'] as const) {
      expect(ids(modelsForMode(CATALOG_NONE, mode))).toEqual(ids(modelsForMode(CATALOG_BOTH, mode)))
    }
  })
})

describe('modelAvailability', () => {
  it('is selectable when the provider offers the mode and has a key', () => {
    expect(modelAvailability(CATALOG_KIE, 'wan-3.0', 'kie', 'text_to_video')).toEqual({ available: true, reason: null })
  })

  it('reports a missing key', () => {
    expect(modelAvailability(CATALOG_KIE, 'seedance-2', 'piapi', 'text_to_video')).toEqual({
      available: false,
      reason: 'Requires a PiAPI API key',
    })
    expect(modelAvailability(CATALOG_NONE, 'seedance-2', 'kie', 'text_to_video').reason).toBe('Requires a Kie API key')
  })

  it('reports a provider that does not offer the model, even with every key', () => {
    expect(modelAvailability(CATALOG_BOTH, 'wan-3.0', 'piapi', 'text_to_video')).toEqual({
      available: false,
      reason: 'Not offered by PiAPI',
    })
    expect(modelAvailability(CATALOG_BOTH, 'seedream-5-lite', 'kie', 'text_to_image').reason).toBe('Not offered by Kie')
  })

  it('reports an unsupported mode with the ledger reason', () => {
    const result = modelAvailability(CATALOG_BOTH, 'seedance-2.5', 'piapi', 'image_to_video')
    expect(result.available).toBe(false)
    expect(result.reason).toBe(
      CATALOG_BOTH.models.find((m) => m.id === 'seedance-2.5')!.providers.piapi.modes.image_to_video!.unavailable_reason,
    )
  })

  it('becomes available when the catalog revalidates with the key', () => {
    expect(modelAvailability(CATALOG_KIE, 'seedance-2', 'piapi', 'omni_reference_to_video').available).toBe(false)
    expect(modelAvailability(CATALOG_BOTH, 'seedance-2', 'piapi', 'omni_reference_to_video').available).toBe(true)
  })

  it('reports unknown models', () => {
    expect(modelAvailability(CATALOG_BOTH, 'nope', 'kie', 'text_to_video')).toEqual({
      available: false,
      reason: 'Unknown model nope',
    })
  })

  it('finds the first selectable model for a provider', () => {
    expect(firstSelectableModel(CATALOG_BOTH, 'text_to_image', 'piapi')).toBe('seedream-5-pro')
    expect(firstSelectableModel(CATALOG_KIE, 'text_to_image', 'kie')).toBe('seedream-5-pro')
    expect(firstSelectableModel(CATALOG_NONE, 'text_to_image', 'kie')).toBeNull()
  })
})

describe('getModeSpec and limits', () => {
  it('returns per provider limits for the same model', () => {
    const kie = getModeSpec(CATALOG_BOTH, 'kie', 'seedance-2', 'image_to_video')!
    const piapi = getModeSpec(CATALOG_BOTH, 'piapi', 'seedance-2', 'image_to_video')!
    expect(mediaLimit(kie, 'image')?.max_count).toBe(9)
    expect(mediaLimit(piapi, 'image')?.max_count).toBe(2)
  })

  it('returns per model limits on the same provider', () => {
    const s2 = getModeSpec(CATALOG_BOTH, 'kie', 'seedance-2', 'omni_reference_to_video')!
    const s25 = getModeSpec(CATALOG_BOTH, 'kie', 'seedance-2.5', 'omni_reference_to_video')!
    expect(s2.max_total_references).toBe(12)
    expect(s25.max_total_references).toBe(50)
    expect(mediaLimit(s25, 'image')?.max_count).toBe(30)
  })

  it('has one sound kind, audio, on every model that takes sound', () => {
    expect(CATALOG_BOTH.media_kinds).toEqual(['image', 'video', 'audio'])
    expect(acceptedKinds(getModeSpec(CATALOG_BOTH, 'kie', 'kling-4.0', 'omni_reference_to_video')!)).toEqual([
      'image', 'video', 'audio',
    ])
    expect(mediaLimit(getModeSpec(CATALOG_BOTH, 'kie', 'kling-4.0', 'omni_reference_to_video')!, 'audio')?.max_count).toBe(3)
    expect(acceptedKinds(getModeSpec(CATALOG_BOTH, 'piapi', 'kling-4.0', 'omni_reference_to_video')!)).toEqual([
      'image', 'video', 'audio',
    ])
  })

  it('returns null for unsupported or unknown combinations', () => {
    expect(getModeSpec(CATALOG_BOTH, 'piapi', 'wan-3.0', 'text_to_video')).toBeNull()
    expect(getModeSpec(CATALOG_BOTH, 'piapi', 'seedance-2.5', 'image_to_video')).toBeNull()
    expect(getModeSpec(CATALOG_BOTH, 'kie', 'image-upscaler', 'text_to_image')).toBeNull()
    expect(getModeSpec(CATALOG_BOTH, 'kie', 'missing', 'text_to_image')).toBeNull()
  })

  it('returns the spec even without a key so limits can be shown', () => {
    expect(getModeSpec(CATALOG_NONE, 'kie', 'seedance-2', 'text_to_video')?.duration?.max_s).toBe(15)
  })

  it('applies the variant chosen by settings', () => {
    const flare = getModeSpec(CATALOG_BOTH, 'kie', 'gpt-image-2.6', 'text_to_image', {})!
    const economy = getModeSpec(CATALOG_BOTH, 'kie', 'gpt-image-2.6', 'text_to_image', { tier: 'economy' })!
    expect(flare.resolutions).not.toBeNull()
    expect(economy.resolutions).toBeNull()
    expect(economy.settings.map((s) => s.key)).not.toContain('quality')
    expect(economy.mode).toBe('text_to_image')
  })

  it('finds models by id', () => {
    expect(findModel(CATALOG_BOTH, 'wan-3.0')?.nsfw).toBe(true)
    expect(findModel(CATALOG_BOTH, 'missing')).toBeUndefined()
  })
})
