import { describe, expect, it } from 'vitest'
import { CATALOG_BOTH, CATALOG_KIE, CATALOG_PIAPI } from './__fixtures__'
import { getModeSpec, modelAvailability, modelsForMode } from './catalog'
import {
  GENERATION_BLOCK_CONFIGS,
  defaultPromptText,
  generationBlockConfig,
  isDefaultPrompt,
  modelsForBlock,
  resolveGenerationSelection,
} from './generation-blocks'

const SWAP = GENERATION_BLOCK_CONFIGS.characterSwap
const OMNI = GENERATION_BLOCK_CONFIGS.omniReferenceToVideo

describe('Character Swap config', () => {
  it('is an Omni Reference block limited to one video and one image, with five models', () => {
    expect(generationBlockConfig('characterSwap')).toBe(SWAP)
    expect(SWAP).toMatchObject({
      mode: 'omni_reference_to_video',
      output: 'video',
      referenceKinds: ['video', 'image'],
      models: ['wan-3.0', 'wan-3.0-prime', 'seedance-2.5', 'seedance-2', 'kling-4.0'],
      exactReferences: { video: 1, image: 1 },
      loaders: { video: 'videoLoader', image: 'uploadImageToTmpfiles' },
      defaultPrompt: 'Replace the person from {video1} with the person from {image1}',
      upstreamPrompt: false,
      promptRequired: true,
    })
    // The other blocks follow the ledger's prompt rule.
    for (const [type, config] of Object.entries(GENERATION_BLOCK_CONFIGS)) {
      if (type !== 'characterSwap') expect(config.promptRequired, type).toBeUndefined()
    }
    expect(SWAP).not.toHaveProperty('fixedPrompt')
  })

  it('names only models the ledger lists for the mode, each taking a video and an image', () => {
    const listed = modelsForMode(CATALOG_BOTH, SWAP.mode).map((m) => m.id)
    for (const id of SWAP.models!) {
      expect(listed).toContain(id)
      const providers = Object.keys(CATALOG_BOTH.providers).filter((p) => getModeSpec(CATALOG_BOTH, p, id, SWAP.mode))
      expect(providers.length).toBeGreaterThan(0)
      for (const p of providers) {
        const kinds = getModeSpec(CATALOG_BOTH, p, id, SWAP.mode)!.media.map((m) => m.kind)
        expect(kinds).toEqual(expect.arrayContaining(['video', 'image']))
      }
    }
  })
})

describe('modelsForBlock', () => {
  it('returns the allowed models in the block order, with the catalog names', () => {
    expect(modelsForBlock(CATALOG_BOTH, SWAP).map((m) => m.name)).toEqual(['Wan 3.0', 'Wan 3.0 Prime', 'Seedance 2.5', 'Seedance 2', 'Kling 4.0'])
  })

  it('returns every model for the mode when the block has no list', () => {
    expect(modelsForBlock(CATALOG_BOTH, OMNI)).toEqual(modelsForMode(CATALOG_BOTH, 'omni_reference_to_video'))
  })

  it('drops an allowed id the catalog no longer lists', () => {
    const catalog = { ...CATALOG_BOTH, models: CATALOG_BOTH.models.filter((m) => m.id !== 'wan-3.0' && m.id !== 'wan-3.0-prime') }
    expect(modelsForBlock(catalog, SWAP).map((m) => m.id)).toEqual(['seedance-2.5', 'seedance-2', 'kling-4.0'])
  })
})

describe('resolveGenerationSelection with an allowed list', () => {
  it('keeps a saved model that is allowed', () => {
    expect(resolveGenerationSelection(CATALOG_BOTH, SWAP.mode, 'kie', 'kling-4.0', SWAP.models))
      .toEqual({ provider: 'kie', model: 'kling-4.0' })
  })

  it('replaces a saved model outside the list with the first allowed one the provider can run', () => {
    expect(resolveGenerationSelection(CATALOG_KIE, SWAP.mode, 'kie', 'seedance-2-fast', SWAP.models))
      .toEqual({ provider: 'kie', model: 'wan-3.0' })
    // Wan 3.0 is not on PiAPI: the next allowed model is used.
    expect(resolveGenerationSelection(CATALOG_PIAPI, SWAP.mode, 'piapi', 'seedance-2-fast', SWAP.models))
      .toEqual({ provider: 'piapi', model: 'seedance-2.5' })
  })

  it('never picks a model outside the list when nothing was saved', () => {
    expect(SWAP.models).toContain(resolveGenerationSelection(CATALOG_BOTH, SWAP.mode, null, null, SWAP.models).model)
  })

  it('is unchanged for blocks without a list', () => {
    expect(resolveGenerationSelection(CATALOG_BOTH, OMNI.mode, 'kie', 'seedance-2-fast'))
      .toEqual({ provider: 'kie', model: 'seedance-2-fast' })
  })
})

describe('defaultPromptText', () => {
  const template = SWAP.defaultPrompt!
  const text = (provider: string, model: string) => defaultPromptText(template, getModeSpec(CATALOG_BOTH, provider, model, SWAP.mode))

  it.each([
    ['kie', 'wan-3.0', 'Replace the person from Video1 with the person from Image1'],
    ['kie', 'seedance-2.5', 'Replace the person from Video1 with the person from Image1'],
    ['kie', 'seedance-2', 'Replace the person from Video1 with the person from Image1'],
    ['piapi', 'seedance-2.5', 'Replace the person from @video1 with the person from @image1'],
    ['piapi', 'seedance-2', 'Replace the person from @video1 with the person from @image1'],
    ['kie', 'kling-4.0', 'Replace the person from @video_1 with the person from @image_1'],
  ])('%s %s writes the references the way the ledger says', (provider, model, expected) => {
    expect(text(provider, model)).toBe(expected)
  })

  it('PiAPI does not run Kling 4.0 in this mode: the catalog says so, and there is no spec to name references with', () => {
    expect(modelAvailability(CATALOG_BOTH, 'kling-4.0', 'piapi', SWAP.mode).available).toBe(false)
    expect(getModeSpec(CATALOG_BOTH, 'piapi', 'kling-4.0', SWAP.mode)).toBeNull()
  })

  it('uses the plain form without a spec, and leaves other braces alone', () => {
    expect(defaultPromptText(template, null)).toBe('Replace the person from Video1 with the person from Image1')
    expect(defaultPromptText('{image2} and {other} and {audio3}', null)).toBe('Image2 and {other} and Audio3')
  })
})

describe('isDefaultPrompt', () => {
  const template = SWAP.defaultPrompt!
  const is = (text: string, catalog = CATALOG_BOTH) => isDefaultPrompt(text, template, catalog, SWAP.mode)

  it('is true for the template written in any mention syntax the ledger has for the mode', () => {
    expect(is('Replace the person from Video1 with the person from Image1')).toBe(true)
    expect(is('Replace the person from @video1 with the person from @image1')).toBe(true)
    expect(is('Replace the person from @video_1 with the person from @image_1')).toBe(true)
  })

  it('is true for every provider and model of the block, whatever the catalog keys', () => {
    for (const catalog of [CATALOG_BOTH, CATALOG_KIE, CATALOG_PIAPI]) {
      for (const id of SWAP.models!) {
        for (const provider of Object.keys(catalog.providers)) {
          const spec = getModeSpec(catalog, provider, id, SWAP.mode)
          if (spec) expect(is(defaultPromptText(template, spec), catalog)).toBe(true)
        }
      }
    }
  })

  it('without a catalog only the plain form is known', () => {
    expect(isDefaultPrompt('Replace the person from Video1 with the person from Image1', template, undefined, SWAP.mode)).toBe(true)
    expect(isDefaultPrompt('Replace the person from @video1 with the person from @image1', template, undefined, SWAP.mode)).toBe(false)
  })

  it('is false for an edit, an empty prompt, extra spaces, or a mix of two syntaxes', () => {
    expect(is('')).toBe(false)
    expect(is('Replace the person from Video1 with the woman from Image1')).toBe(false)
    expect(is('Replace the person from Video1 with the person from Image1 ')).toBe(false)
    expect(is('Replace the person from @video1 with the person from Image1')).toBe(false)
    expect(is('Replace the person from {video1} with the person from {image1}')).toBe(false)
  })
})
