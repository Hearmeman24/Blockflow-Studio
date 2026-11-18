import { describe, expect, it } from 'vitest'
import { CATALOG_BOTH } from './__fixtures__'
import { getModeSpec } from './catalog'
import { checkReferences, referenceItemStatuses, type CheckableReference } from './check-references'
import type { GenerationMode, ModeSpec } from './types'

function spec(provider: string, model: string, mode: GenerationMode): ModeSpec {
  const s = getModeSpec(CATALOG_BOTH, provider, model, mode)
  if (!s) throw new Error(`no spec for ${provider}/${model}/${mode}`)
  return s
}

const ctx = { modelName: 'Seedance 2', providerName: 'Kie', modeName: 'Omni Reference to Video' }
const img = (n: number, extra: Partial<CheckableReference> = {}): CheckableReference => ({
  kind: 'image', local: `/outputs/i${n}.png`, role: 'reference', ...extra,
})
const vid = (n: number, extra: Partial<CheckableReference> = {}): CheckableReference => ({
  kind: 'video', local: `/outputs/v${n}.mp4`, role: 'reference', ...extra,
})
const aud = (n: number, extra: Partial<CheckableReference> = {}): CheckableReference => ({
  kind: 'audio', local: `/outputs/a${n}.mp3`, role: 'reference', ...extra,
})
const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code)

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const omniKie = () => spec('kie', 'seedance-2', 'omni_reference_to_video') // 9 img, 3 vid, 3 audio, 12 total, min 1

describe('checkReferences counts', () => {
  it('accepts references exactly at every per-kind limit', () => {
    const refs = [...Array.from({ length: 9 }, (_, i) => img(i)), vid(1), vid(2)]
    expect(checkReferences(omniKie(), refs, ctx)).toEqual([])
  })

  it('reports one over the per-kind limit with the limit and actual count', () => {
    const issues = checkReferences(omniKie(), Array.from({ length: 10 }, (_, i) => img(i)), ctx)
    expect(issues).toEqual([
      {
        code: 'too_many_references',
        severity: 'error',
        field: 'references.image',
        message: 'Seedance 2 on Kie accepts at most 9 images; remove 1.',
        limit: 9,
        actual: 10,
      },
    ])
  })

  it('reports the total cap separately from per-kind caps', () => {
    const refs = [...Array.from({ length: 9 }, (_, i) => img(i)), vid(1), vid(2), vid(3), aud(1)]
    const issues = checkReferences(omniKie(), refs, ctx)
    expect(codes(issues)).toEqual(['too_many_total_references'])
    expect(issues[0]).toMatchObject({ field: 'references', limit: 12, actual: 13 })
  })

  it('requires the minimum total for reference modes', () => {
    expect(codes(checkReferences(omniKie(), [], ctx))).toEqual(['too_few_references'])
  })

  it('requires the per-kind minimum', () => {
    const i2i = spec('kie', 'seedream-5-pro', 'image_to_image') // image min 1
    const issues = checkReferences(i2i, [], { ...ctx, modeName: 'Image to Image' })
    expect(issues.map((i) => [i.code, i.field])).toEqual([
      ['too_few_references', 'references.image'],
      ['too_few_references', 'references'],
    ])
  })
})

describe('checkReferences kinds and mixing', () => {
  it('rejects a kind the mode does not accept', () => {
    const flash = spec('kie', 'kling-4.0-flash', 'omni_reference_to_video')
    const issues = checkReferences(flash, [img(1), aud(1)], ctx)
    expect(issues).toEqual([
      expect.objectContaining({ code: 'media_kind_not_accepted', field: 'references.audio', limit: 0, actual: 1 }),
    ])
  })

  it('treats a retired voice kind as unknown', () => {
    const issues = checkReferences(omniKie(), [img(1), { kind: 'voice' as never, local: '/outputs/v.mp3' }], ctx)
    expect(issues).toEqual([expect.objectContaining({ code: 'unknown_media_kind', message: "Unknown media kind 'voice'. Use one of: image, video, audio." })])
  })

  it('rejects unknown kinds and missing files', () => {
    const issues = checkReferences(omniKie(), [{ kind: 'gif' as never, local: '/outputs/x' }, { kind: 'image' }], ctx)
    expect(issues.map((i) => [i.code, i.field])).toEqual([
      ['unknown_media_kind', 'references[0].kind'],
      ['reference_url_missing', 'references[1].url'],
    ])
  })

  it('rejects audio-only references when the model needs a picture', () => {
    expect(codes(checkReferences(omniKie(), [aud(1)], ctx))).toEqual(['audio_only_not_allowed'])
  })

  it('accepts audio-only references when the model allows it', () => {
    const wan = spec('kie', 'wan-3.0', 'omni_reference_to_video')
    expect(wan.audio_only_allowed).toBe(true)
    expect(checkReferences(wan, [aud(1)], ctx)).toEqual([])
  })

  it('rejects mixed media where the mode forbids it', () => {
    const i2v = spec('kie', 'seedance-2', 'image_to_video')
    expect(i2v.mixed_media_allowed).toBe(false)
    const issues = checkReferences(i2v, [img(1, { role: 'first_frame' }), vid(1, { role: 'first_frame' })], ctx)
    expect(codes(issues)).toContain('mixed_media_not_allowed')
    expect(codes(issues)).toContain('media_kind_not_accepted')
  })

  it('accepts audio on Kling 4.0 on Kie, with no name', () => {
    const kling = spec('kie', 'kling-4.0', 'omni_reference_to_video')
    expect(checkReferences(kling, [img(1), aud(1)], ctx)).toEqual([])
  })

  it('rejects formats outside the documented list', () => {
    const issues = checkReferences(omniKie(), [{ kind: 'video', local: '/outputs/clip.webm' }, img(1)], ctx)
    expect(issues).toEqual([expect.objectContaining({ code: 'invalid_format', field: 'references[0].format', actual: 'webm' })])
  })
})

describe('checkReferences frame roles', () => {
  const i2v = () => spec('kie', 'kling-4.0', 'image_to_video') // first + last allowed
  const flash = () => spec('kie', 'kling-4.0-flash', 'image_to_video') // last frame not allowed

  it('accepts a first and last frame', () => {
    expect(checkReferences(i2v(), [img(1, { role: 'first_frame' }), img(2, { role: 'last_frame' })], ctx)).toEqual([])
  })

  it('requires a first frame', () => {
    expect(codes(checkReferences(i2v(), [], ctx))).toEqual(['first_frame_required'])
    // Same as the backend: "Add a first frame" and "A last frame needs a first frame".
    expect(codes(checkReferences(i2v(), [img(2, { role: 'last_frame' })], ctx)))
      .toEqual(['first_frame_required', 'first_frame_required'])
  })

  it('rejects plain references and duplicate frames', () => {
    expect(codes(checkReferences(i2v(), [img(1, { role: 'first_frame' }), img(2)], ctx))).toEqual(['invalid_reference_role'])
    expect(codes(checkReferences(i2v(), [img(1, { role: 'first_frame' }), img(2, { role: 'first_frame' })], ctx)))
      .toEqual(['duplicate_frame'])
  })

  it('rejects a last frame where the model does not allow one', () => {
    const issues = checkReferences(flash(), [img(1, { role: 'first_frame' }), img(2, { role: 'last_frame' })], ctx)
    expect(codes(issues)).toEqual(['too_many_references', 'last_frame_not_supported'])
  })

  it('rejects frame roles outside image to video', () => {
    expect(codes(checkReferences(omniKie(), [img(1, { role: 'first_frame' })], ctx))).toEqual(['invalid_reference_role'])
  })
})

describe('checkReferences purity', () => {
  it('never mutates the spec or the references', () => {
    const s = deepFreeze(structuredClone(omniKie()))
    const refs = deepFreeze(Array.from({ length: 11 }, (_, i) => img(i)))
    const before = JSON.stringify(refs)
    expect(() => checkReferences(s, refs, ctx)).not.toThrow()
    expect(() => referenceItemStatuses(s, refs)).not.toThrow()
    expect(JSON.stringify(refs)).toBe(before)
  })
})

describe('referenceItemStatuses', () => {
  it('flags items past the per-kind limit as over limit and keeps the rest ok', () => {
    const statuses = referenceItemStatuses(omniKie(), Array.from({ length: 11 }, (_, i) => img(i)))
    expect(statuses.slice(0, 9).every((s) => s.status === 'ok')).toBe(true)
    expect(statuses.slice(9).map((s) => s.status)).toEqual(['over_limit', 'over_limit'])
    expect(statuses[9].reason).toBe('Over the limit of 9 images')
  })

  it('flags unsupported kinds as incompatible and missing files as broken', () => {
    const flash = spec('kie', 'kling-4.0-flash', 'omni_reference_to_video')
    const statuses = referenceItemStatuses(flash, [{ kind: 'audio', local: '/outputs/a.mp3' }, { kind: 'image' }])
    expect(statuses.map((s) => s.status)).toEqual(['incompatible', 'broken'])
  })

  it('flags a last frame the model cannot use as incompatible', () => {
    const flash = spec('kie', 'kling-4.0-flash', 'image_to_video')
    const statuses = referenceItemStatuses(flash, [img(1, { role: 'first_frame' }), img(2, { role: 'last_frame' })])
    expect(statuses.map((s) => s.status)).toEqual(['ok', 'incompatible'])
  })

  it('treats a missing spec as every item incompatible', () => {
    expect(referenceItemStatuses(null, [img(1)])[0].status).toBe('incompatible')
  })
})
