import { describe, expect, it } from 'vitest'
import { CATALOG_BOTH } from './__fixtures__'
import { getModeSpec } from './catalog'
import { insertMention, mentionSegments, referenceBadges } from './mentions'
import type { GenerationReference } from './references'

const ref = (kind: GenerationReference['kind'], label: string, extra: Partial<GenerationReference> = {}): GenerationReference => ({
  id: label, kind, role: 'reference', local: `/outputs/${label}`, label, status: 'ready', ...extra,
})

describe('referenceBadges', () => {
  it('numbers references per kind, grouped image, video, audio, with the provider syntax', () => {
    const spec = getModeSpec(CATALOG_BOTH, 'piapi', 'seedance-2', 'omni_reference_to_video')
    const badges = referenceBadges(spec, [ref('video', 'v.mp4'), ref('image', 'a.png'), ref('image', 'b.png'), ref('audio', 's.mp3')])
    expect(badges.map((b) => [b.label, b.text])).toEqual([
      ['Image 1', '@image1'], ['Image 2', '@image2'], ['Video 1', '@video1'], ['Audio 1', '@audio1'],
    ])
    expect(badges[0].thumbnail).toBe('/outputs/a.png')
  })

  it('uses each model and provider syntax from the catalog', () => {
    const refs = [ref('image', 'a.png'), ref('video', 'v.mp4'), ref('audio', 'ava.mp3')]
    const kling = getModeSpec(CATALOG_BOTH, 'kie', 'kling-4.0', 'omni_reference_to_video')
    expect(referenceBadges(kling, refs).map((b) => [b.label, b.text])).toEqual([
      ['Image 1', '@image_1'], ['Video 1', '@video_1'], ['Audio 1', '@sound_1'],
    ])
    const wan = getModeSpec(CATALOG_BOTH, 'kie', 'wan-3.0', 'omni_reference_to_video')
    expect(referenceBadges(wan, refs.slice(0, 2)).map((b) => b.text)).toEqual(['Image1', 'Video1'])
    const minimax = getModeSpec(CATALOG_BOTH, 'kie', 'minimax-h3-image', 'image_to_image')
    expect(referenceBadges(minimax, [ref('image', 'a.png'), ref('image', 'b.png')]).map((b) => b.text)).toEqual(['<Picture 1>', '<Picture 2>'])
    const seedream = getModeSpec(CATALOG_BOTH, 'kie', 'seedream-5-pro', 'image_to_image')
    expect(referenceBadges(seedream, [ref('image', 'a.png')]).map((b) => b.text)).toEqual(['Image1'])
  })

  it('labels frames by role only where the model names them so', () => {
    const frames = [ref('image', 'a.png', { role: 'first_frame' }), ref('image', 'b.png', { role: 'last_frame' })]
    const kling = getModeSpec(CATALOG_BOTH, 'kie', 'kling-4.0', 'image_to_video')
    expect(referenceBadges(kling, frames).map((b) => [b.label, b.text])).toEqual([['First frame', '@first_frame'], ['Last frame', '@last_frame']])
    const seedance = getModeSpec(CATALOG_BOTH, 'piapi', 'seedance-2', 'image_to_video')
    expect(referenceBadges(seedance, frames).map((b) => [b.label, b.text])).toEqual([['Image 1', '@image1'], ['Image 2', '@image2']])
  })

  it('has none without references or without a mode spec', () => {
    expect(referenceBadges(getModeSpec(CATALOG_BOTH, 'kie', 'seedance-2', 'omni_reference_to_video'), [])).toEqual([])
    expect(referenceBadges(null, [ref('image', 'a.png')]).map((b) => b.text)).toEqual(['Image1'])
  })
})

describe('audio badges: one sound kind, the catalog mention per provider and model', () => {
  const clips = [ref('audio', 'line 1.wav'), ref('audio', 'rain.mp3')]

  it('Kling 4.0 on Kie: @sound_N (Kie reserves audio_N)', () => {
    const spec = getModeSpec(CATALOG_BOTH, 'kie', 'kling-4.0', 'omni_reference_to_video')
    expect(referenceBadges(spec, clips).map((b) => [b.kind, b.label, b.text])).toEqual([
      ['audio', 'Audio 1', '@sound_1'], ['audio', 'Audio 2', '@sound_2'],
    ])
  })

  it('Seedance on PiAPI: @audioN', () => {
    const spec = getModeSpec(CATALOG_BOTH, 'piapi', 'seedance-2', 'omni_reference_to_video')
    expect(referenceBadges(spec, clips).map((b) => [b.label, b.text])).toEqual([['Audio 1', '@audio1'], ['Audio 2', '@audio2']])
  })

  it('Seedance on Kie: AudioN', () => {
    const spec = getModeSpec(CATALOG_BOTH, 'kie', 'seedance-2', 'omni_reference_to_video')
    expect(referenceBadges(spec, clips).map((b) => [b.label, b.text])).toEqual([['Audio 1', 'Audio1'], ['Audio 2', 'Audio2']])
  })

  it('a character clip reads "<name> · Audio N"; Unicode names are kept', () => {
    const spec = getModeSpec(CATALOG_BOTH, 'kie', 'kling-4.0', 'omni_reference_to_video')
    const badges = referenceBadges(spec, [ref('audio', 'mia.wav', { character: 'Mia' }), ref('audio', 'b.wav', { character: '李小龙' })])
    expect(badges.map((b) => [b.label, b.text])).toEqual([['Mia · Audio 1', '@sound_1'], ['李小龙 · Audio 2', '@sound_2']])
  })

  it('a sound badge has no thumbnail and no name field shapes it', () => {
    const [badge] = referenceBadges(null, [ref('audio', 'a.mp3', { label: 'Narrator.mp3' })])
    expect(badge).toEqual({ key: 'audio:1:a.mp3', kind: 'audio', label: 'Audio 1', text: 'Audio1' })
  })
})

describe('insertMention', () => {
  it('inserts at the caret with spaces only where needed', () => {
    expect(insertMention('a cat on', 2, 2, '@image1', true)).toEqual({ value: 'a @image1 cat on', caret: 9 })
    expect(insertMention('a cat', 5, 5, '@image1', true)).toEqual({ value: 'a cat @image1', caret: 13 })
    expect(insertMention('', 0, 0, '@image1', true)).toEqual({ value: '@image1', caret: 7 })
  })

  it('replaces the selection', () => {
    expect(insertMention('use the dog here', 8, 11, 'Image1', true)).toEqual({ value: 'use the Image1 here', caret: 14 })
  })

  it('appends with a space when the prompt was never focused', () => {
    expect(insertMention('a cat', 0, 0, 'image 1', false)).toEqual({ value: 'a cat image 1', caret: 13 })
    expect(insertMention('a cat ', 0, 0, 'image 1', false)).toEqual({ value: 'a cat image 1', caret: 13 })
  })
})

describe('badges for references from a character', () => {
  it('prefix the character name on image, video and audio badges; the inserted text is unchanged', () => {
    const kling = getModeSpec(CATALOG_BOTH, 'kie', 'kling-4.0', 'omni_reference_to_video')
    const refs = [
      ref('image', 'plain.png'),
      ref('image', 'face.png', { character: 'Zoë 李' }),
      ref('video', 'walk.mp4', { character: 'Mia' }),
      ref('audio', 'song.mp3', { character: 'Mia' }),
      ref('audio', 'mia.wav', { character: 'Mia' }),
    ]
    expect(referenceBadges(kling, refs).map((b) => [b.label, b.text])).toEqual([
      ['Image 1', '@image_1'],
      ['Zoë 李 · Image 2', '@image_2'],
      ['Mia · Video 1', '@video_1'],
      ['Mia · Audio 1', '@sound_1'],
      ['Mia · Audio 2', '@sound_2'],
    ])
  })

  it('prefix frame labels too', () => {
    const kling = getModeSpec(CATALOG_BOTH, 'kie', 'kling-4.0', 'image_to_video')
    const frames = [ref('image', 'a.png', { role: 'first_frame', character: 'Mia' }), ref('image', 'b.png', { role: 'last_frame' })]
    expect(referenceBadges(kling, frames).map((b) => [b.label, b.text])).toEqual([['Mia · First frame', '@first_frame'], ['Last frame', '@last_frame']])
  })
})

it('caps a long character name on the badge (the chip does not wrap) without touching the inserted text', () => {
  const long = 'Bartholomew Montgomery-Fitzwilliam III'
  const [badge] = referenceBadges(null, [ref('image', 'a.png', { character: long })])
  expect(badge.label).toBe('Bartholomew Montgome… · Image 1')
  expect(badge.text).toBe('Image1')
  // Unicode is cut by code point, never mid-character.
  const [emoji] = referenceBadges(null, [ref('image', 'a.png', { character: '😀'.repeat(25) })])
  expect(emoji.label).toBe(`${'😀'.repeat(20)}… · Image 1`)
})

describe('mentionSegments', () => {
  const m = (text: string, kind: GenerationReference['kind'] = 'image') => ({ text, kind })
  /** Segments as [text, kind or null], for short assertions. */
  const seg = (value: string, mentions: Parameters<typeof mentionSegments>[1]) =>
    mentionSegments(value, mentions).map((s) => [s.text, s.kind])

  it('is one plain segment without mentions, and nothing for an empty prompt', () => {
    expect(seg('a cat with Image1', [])).toEqual([['a cat with Image1', null]])
    expect(seg('', [m('Image1')])).toEqual([])
  })

  it('marks each mention with its kind, keeping the text around it', () => {
    const mentions = [m('Image1'), m('Video1', 'video'), m('Audio1', 'audio')]
    expect(seg('swap Video1 into Image1, sing Audio1.', mentions)).toEqual([
      ['swap ', null], ['Video1', 'video'], [' into ', null], ['Image1', 'image'], [', sing ', null], ['Audio1', 'audio'], ['.', null],
    ])
  })

  it('handles mentions at the start, at the end, adjacent and repeated', () => {
    const mentions = [m('@image_1'), m('@video_1', 'video')]
    expect(seg('@image_1 x @video_1', mentions)).toEqual([['@image_1', 'image'], [' x ', null], ['@video_1', 'video']])
    expect(seg('@image_1@video_1@image_1', mentions)).toEqual([['@image_1', 'image'], ['@video_1', 'video'], ['@image_1', 'image']])
  })

  it('matches whole mentions only: not inside a longer word or a longer number', () => {
    expect(seg('Image10 MyImage1 Image1_ Image1', [m('Image1')])).toEqual([['Image10 MyImage1 Image1_ ', null], ['Image1', 'image']])
    expect(seg('@image_12 @image_1', [m('@image_1')])).toEqual([['@image_12 ', null], ['@image_1', 'image']])
    // Letters of any script count as part of a word.
    expect(seg('éImage1 Image1é', [m('Image1')])).toEqual([['éImage1 Image1é', null]])
  })

  it('prefers the longer mention when one is a prefix of another', () => {
    expect(seg('@image_12 and @image_1', [m('@image_1'), m('@image_12')])).toEqual([
      ['@image_12', 'image'], [' and ', null], ['@image_1', 'image'],
    ])
  })

  it('treats regex metacharacters in a mention literally', () => {
    const mentions = [m('<Picture 1>'), m('[img.1]'), m('$v(1)+', 'video')]
    expect(seg('see <Picture 1>, [img.1] and $v(1)+; not <Picture 11> or [imgX1]', mentions)).toEqual([
      ['see ', null], ['<Picture 1>', 'image'], [', ', null], ['[img.1]', 'image'], [' and ', null], ['$v(1)+', 'video'],
      ['; not <Picture 11> or [imgX1]', null],
    ])
  })

  it('a mention that starts or ends with a symbol can touch a word on that side', () => {
    expect(seg('as<Picture 1>is', [m('<Picture 1>')])).toEqual([['as', null], ['<Picture 1>', 'image'], ['is', null]])
  })

  it('keeps Unicode text around mentions intact', () => {
    const value = 'Zoë 李 😀 Image1 ✨ 名前'
    const out = mentionSegments(value, [m('Image1')])
    expect(out.map((s) => s.text).join('')).toBe(value)
    expect(out.map((s) => [s.text, s.kind])).toEqual([['Zoë 李 😀 ', null], ['Image1', 'image'], [' ✨ 名前', null]])
  })

  it('the same text in two badges takes the first kind; empty mention texts are ignored', () => {
    expect(seg('Image1', [m('Image1', 'image'), m('Image1', 'video'), m('')])).toEqual([['Image1', 'image']])
  })

  it('splits a very long prompt in linear time and loses no text', () => {
    const unit = 'a long line with Image1 and @video_1, but not Image10 or @video_12. '
    const value = unit.repeat(20000)
    const started = performance.now()
    const out = mentionSegments(value, [m('Image1'), m('@video_1', 'video')])
    expect(performance.now() - started).toBeLessThan(1000)
    expect(out.map((s) => s.text).join('')).toBe(value)
    expect(out.filter((s) => s.kind === 'image')).toHaveLength(20000)
    expect(out.filter((s) => s.kind === 'video')).toHaveLength(20000)
  })
})
