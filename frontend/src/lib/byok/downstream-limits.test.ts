import { describe, expect, it } from 'vitest'
import { CATALOG_BOTH, CATALOG_NONE } from './__fixtures__'
import { computeDownstreamLimit, limitSource, strictestLimit } from './downstream-limits'

const consumer = (type: string, label = 'Image to Video', blockId = 'b1') => ({ blockId, type, label })
const stored = (provider: string | null, model: string | null, settings: Record<string, unknown> = {}) => ({
  provider, model, params: { settings },
})

describe('computeDownstreamLimit', () => {
  it('returns null for a block that is not a generation block or does not take the kind', () => {
    expect(computeDownstreamLimit(CATALOG_BOTH, consumer('imageViewer'), 'image', stored(null, null))).toBeNull()
    expect(computeDownstreamLimit(CATALOG_BOTH, consumer('imageToVideo'), 'video', stored(null, null))).toBeNull()
  })

  it('reads the limit for the selected provider and model from the catalog', () => {
    const limit = computeDownstreamLimit(CATALOG_BOTH, consumer('omniReferenceToVideo', 'Omni'), 'image', stored('kie', 'seedance-2'))!
    expect(limit).toMatchObject({
      blockId: 'b1', label: 'Omni', provider: 'kie', providerName: 'Kie', model: 'seedance-2', modelName: 'Seedance 2',
      mode: 'omni_reference_to_video', accepted: true, maxCount: 9,
    })
    expect(limit.limit?.formats).toContain('png')
    expect(limit.limit?.max_size_bytes).toBe(30_000_000)
  })

  it('caps images in Image to Video by the frame slots the model has', () => {
    // Seedance 2 on Kie lists 9 images, but Image to Video only uses a first and a last frame.
    expect(computeDownstreamLimit(CATALOG_BOTH, consumer('imageToVideo'), 'image', stored('kie', 'seedance-2'))!.maxCount).toBe(2)
    // Kling 4.0 Flash has no last frame.
    expect(computeDownstreamLimit(CATALOG_BOTH, consumer('imageToVideo'), 'image', stored('kie', 'kling-4.0-flash'))!.maxCount).toBe(1)
  })

  it('caps a kind by the total reference limit', () => {
    const limit = computeDownstreamLimit(CATALOG_BOTH, consumer('omniReferenceToVideo'), 'image', stored('kie', 'seedance-2.5'))!
    expect(limit.limit?.max_count).toBe(30)
    expect(limit.maxCount).toBe(30)
    const video = computeDownstreamLimit(CATALOG_BOTH, consumer('omniReferenceToVideo'), 'video', stored('kie', 'kling-4.0'))!
    expect(video.maxCount).toBe(5)
  })

  it('resolves an unset provider and model the same way the block does', () => {
    const limit = computeDownstreamLimit(CATALOG_BOTH, consumer('imageToVideo'), 'image', stored(null, null))!
    expect(limit.provider).toBe('kie')
    expect(limit.model).toBe('seedance-2')
  })

  it('still shows limits without any key saved', () => {
    const limit = computeDownstreamLimit(CATALOG_NONE, consumer('imageToVideo'), 'image', stored('kie', 'kling-4.0-flash'))!
    expect(limit.accepted).toBe(true)
    expect(limit.maxCount).toBe(1)
  })

  it('marks the kind as not accepted when the selected model cannot run the mode on that provider', () => {
    // Seedance 2.5 has no Image to Video on PiAPI.
    const limit = computeDownstreamLimit(CATALOG_BOTH, consumer('imageToVideo'), 'image', stored('piapi', 'seedance-2.5'))!
    expect(limit.accepted).toBe(false)
    expect(limit.maxCount).toBe(0)
    expect(limit.reason).toMatch(/Seedance 2.5/)
  })

  it('marks the kind as not accepted when the mode has no limit for it', () => {
    const limit = computeDownstreamLimit(CATALOG_BOTH, consumer('omniReferenceToVideo'), 'audio', stored('kie', 'kling-4.0-flash'))!
    expect(limit.accepted).toBe(false)
    expect(limit.reason).toBe('Kling 4.0 Flash does not accept audio clips in Omni Reference to Video.')
  })
})

describe('strictestLimit', () => {
  it('picks the lowest count, and a block that does not accept the kind first', () => {
    const a = computeDownstreamLimit(CATALOG_BOTH, consumer('imageToVideo', 'A', 'a'), 'image', stored('kie', 'seedance-2'))!
    const b = computeDownstreamLimit(CATALOG_BOTH, consumer('imageToVideo', 'B', 'b'), 'image', stored('kie', 'kling-4.0-flash'))!
    const c = computeDownstreamLimit(CATALOG_BOTH, consumer('imageToVideo', 'C', 'c'), 'image', stored('piapi', 'seedance-2.5'))!
    expect(strictestLimit([a, b])?.blockId).toBe('b')
    expect(strictestLimit([a, b, c])?.blockId).toBe('c')
    expect(strictestLimit([])).toBeNull()
  })

  it('names the source as block label and model', () => {
    const b = computeDownstreamLimit(CATALOG_BOTH, consumer('imageToVideo'), 'image', stored('kie', 'kling-4.0-flash'))!
    expect(limitSource(b)).toBe('Image to Video · Kling 4.0 Flash')
  })
})
