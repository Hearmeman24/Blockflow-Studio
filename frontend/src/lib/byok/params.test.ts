import { describe, expect, it } from 'vitest'
import { CATALOG_BOTH } from './__fixtures__'
import { getModeSpec } from './catalog'
import {
  EMPTY_PARAMS,
  buildRequestParams,
  defaultParams,
  displayValue,
  reconcileParams,
  type ParamState,
} from './params'
import type { GenerationMode } from './types'

const spec = (provider: string, model: string, mode: GenerationMode, settings = {}) => {
  const s = getModeSpec(CATALOG_BOTH, provider, model, mode, settings)
  if (!s) throw new Error('missing spec')
  return s
}

const params = (over: Partial<ParamState>): ParamState => ({ ...EMPTY_PARAMS, settings: {}, ...over })

describe('defaultParams', () => {
  it('reads every default from the spec', () => {
    expect(defaultParams(spec('kie', 'seedance-2', 'text_to_video'))).toEqual({
      duration: 5,
      resolution: '720p',
      aspect_ratio: '16:9',
      settings: { generate_audio: true, nsfw_checker: false },
    })
    expect(defaultParams(spec('piapi', 'seedance-2', 'text_to_video')).resolution).toBe('480p')
  })

  it('leaves fields the mode does not have empty', () => {
    const upscale = defaultParams(spec('kie', 'image-upscaler', 'image_to_image'))
    expect(upscale).toEqual({ duration: null, resolution: null, aspect_ratio: null, settings: { upscale_factor: '2' } })
  })

  it('shows the stored value, else the default', () => {
    const s = spec('kie', 'seedance-2', 'text_to_video')
    expect(displayValue(s, params({ resolution: '1080p' }), 'resolution')).toBe('1080p')
    expect(displayValue(s, params({}), 'resolution')).toBe('720p')
    expect(displayValue(s, params({}), 'settings.nsfw_checker')).toBe(false)
  })
})

describe('reconcileParams', () => {
  const where = 'Seedance 2 on PiAPI'

  it('keeps values the new spec accepts and changes nothing', () => {
    const p = params({ resolution: '720p', duration: 10, settings: { audio: false } })
    expect(reconcileParams(spec('piapi', 'seedance-2', 'text_to_video'), p, where)).toEqual({ params: p, changes: [] })
  })

  it('resets a resolution the new provider lacks and explains it', () => {
    const p = params({ resolution: '4k' })
    const result = reconcileParams(spec('piapi', 'seedance-2', 'text_to_video'), p, where)
    expect(result.params.resolution).toBeNull()
    expect(result.changes).toEqual([
      {
        field: 'resolution',
        label: 'Resolution',
        from: '4k',
        to: '480p',
        message: 'Resolution 4k is not available for Seedance 2 on PiAPI; reset to 480p.',
      },
    ])
    expect(p.resolution).toBe('4k')
  })

  it('resets an out-of-range or automatic duration', () => {
    const piapi = spec('piapi', 'seedance-2', 'text_to_video')
    expect(reconcileParams(piapi, params({ duration: 30 }), where).changes[0]).toMatchObject({ field: 'duration', from: 30, to: 5 })
    // Kie's automatic duration sentinel is not a PiAPI value.
    const kieAuto = spec('kie', 'seedance-2', 'text_to_video').duration!.auto_value
    expect(reconcileParams(piapi, params({ duration: kieAuto }), where).params.duration).toBeNull()
    expect(reconcileParams(spec('kie', 'seedance-2', 'text_to_video'), params({ duration: kieAuto }), where).changes).toEqual([])
  })

  it('resets invalid settings and keeps settings the mode does not use', () => {
    const gpt = spec('kie', 'gpt-image-2.6', 'text_to_image', {})
    const p = params({ settings: { quality: 'ultra', nsfw_checker: true } })
    const result = reconcileParams(gpt, p, 'GPT Image 2.6 on Kie')
    expect(result.params.settings).toEqual({ quality: null, nsfw_checker: true })
    expect(result.changes.map((c) => [c.field, c.label, c.to])).toEqual([['settings.quality', 'Quality', 'medium']])
  })

  it('keeps values for fields the new mode does not have', () => {
    const p = params({ duration: 10 })
    expect(reconcileParams(spec('kie', 'seedream-5-pro', 'text_to_image'), p, 'x')).toEqual({ params: p, changes: [] })
  })
})

describe('buildRequestParams', () => {
  it('sends only fields the spec has, without empty values', () => {
    const s = spec('kie', 'seedance-2', 'text_to_video')
    const p = params({ duration: 8, resolution: null, aspect_ratio: '9:16', settings: { nsfw_checker: true, seed: 3 } })
    expect(buildRequestParams(s, p, '  a cat  ')).toEqual({
      prompt: '  a cat  ',
      duration: 8,
      aspect_ratio: '9:16',
      settings: { nsfw_checker: true },
    })
  })

  it('omits the prompt when the mode takes none or it is blank', () => {
    expect(buildRequestParams(spec('kie', 'image-upscaler', 'image_to_image'), params({}), 'ignored')).toEqual({ settings: {} })
    expect(buildRequestParams(spec('kie', 'seedance-2', 'text_to_video'), params({}), '   ')).toEqual({ settings: {} })
  })

  it('drops fields the mode lacks', () => {
    const p = params({ duration: 8, resolution: '2K', aspect_ratio: '3:2' })
    expect(buildRequestParams(spec('kie', 'seedream-5-pro', 'text_to_image'), p, 'x')).toEqual({
      prompt: 'x', aspect_ratio: '3:2', settings: {},
    })
  })
})
