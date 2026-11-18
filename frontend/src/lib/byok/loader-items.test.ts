import { describe, expect, it } from 'vitest'
import { CATALOG_BOTH } from './__fixtures__'
import { computeDownstreamLimit } from './downstream-limits'
import {
  checkCandidates,
  flagItems,
  itemsToOutput,
  legacyImageItems,
  legacyVideoItems,
  moveItem,
  removeExtras,
  restoreLoaderItems,
  type LoaderItem,
} from './loader-items'

const limit = (type: string, provider: string, model: string, kind: 'image' | 'video' = 'image', label = 'Image to Video') =>
  computeDownstreamLimit(CATALOG_BOTH, { blockId: label, type, label }, kind, { provider, model, params: null })!

const flash = () => limit('imageToVideo', 'kie', 'kling-4.0-flash')
const item = (id: string, extra: Partial<LoaderItem> = {}): LoaderItem => ({ id, label: `${id}.png`, local: `/outputs/${id}.png`, status: 'ready', ...extra })
const file = (name: string, extra: Partial<{ type: string; size_bytes: number; duration_s: number; width: number; height: number }> = {}) => ({
  name, type: extra.type ?? (name.endsWith('.mp4') || name.endsWith('.mkv') ? 'video/mp4' : 'image/png'), size_bytes: 1000, ...extra,
})

describe('restoreLoaderItems', () => {
  it('keeps order and metadata, drops malformed rows, and marks interrupted saves', () => {
    const raw = [
      { id: 'a', label: 'a.png', local: '/outputs/a.png', status: 'ready', size_bytes: 12, width: 10, height: 20 },
      'junk',
      { label: 'no id' },
      { id: 'b', label: 'b.png', status: 'saving' },
    ]
    expect(restoreLoaderItems(raw)).toEqual([
      { id: 'a', label: 'a.png', local: '/outputs/a.png', status: 'ready', size_bytes: 12, width: 10, height: 20 },
      { id: 'b', label: 'b.png', status: 'error', error: 'Saving this file was interrupted. Replace it or add it again.' },
    ])
    expect(restoreLoaderItems(undefined)).toEqual([])
  })
})

describe('legacy config', () => {
  it('turns the old single-video keys into one item', () => {
    expect(legacyVideoItems({ local_url: '/outputs/clip.mp4', remote_url: 'https://tmpfiles.org/dl/1/clip.mp4' })).toEqual([
      { id: 'legacy-video-0', label: 'clip.mp4', local: '/outputs/clip.mp4', url: 'https://tmpfiles.org/dl/1/clip.mp4', status: 'ready' },
    ])
    expect(legacyVideoItems({ uploaded_video_url: 'https://x/v.mp4' })).toEqual([
      { id: 'legacy-video-0', label: 'v.mp4', url: 'https://x/v.mp4', status: 'ready' },
    ])
    expect(legacyVideoItems({ local_url: '', remote_url: '' })).toEqual([])
  })

  it('turns the old image uploads map into items in saved order', () => {
    expect(legacyImageItems({ fp1: { local: '/outputs/a.png', url: 'https://t/a.png' }, fp2: { local: '/outputs/b.png' }, fp3: { localError: 'x' } })).toEqual([
      { id: 'legacy-image-0', label: 'a.png', local: '/outputs/a.png', url: 'https://t/a.png', status: 'ready' },
      { id: 'legacy-image-1', label: 'b.png', local: '/outputs/b.png', status: 'ready' },
    ])
  })
})

describe('checkCandidates', () => {
  it('accepts anything of the right kind when nothing downstream limits it', () => {
    const r = checkCandidates('image', [], [file('a.png'), file('notes.txt', { type: 'text/plain' })], [])
    expect(r.accepted).toEqual([0])
    expect(r.messages).toEqual(['notes.txt is not an image file.'])
  })

  it('blocks adding beyond the strictest limit and names it', () => {
    const r = checkCandidates('image', [item('a')], [file('b.png')], [flash()])
    expect(r.accepted).toEqual([])
    expect(r.messages).toEqual(['b.png was not added: Image to Video · Kling 4.0 Flash takes up to 1 image.'])
    const two = checkCandidates('image', [], [file('a.png'), file('b.png'), file('c.png')], [limit('imageToVideo', 'kie', 'seedance-2')])
    expect(two.accepted).toEqual([0, 1])
    expect(two.messages).toEqual(['c.png was not added: Image to Video · Seedance 2 takes up to 2 images.'])
    const many = checkCandidates('image', [], [file('a.png'), file('b.png'), file('c.png')], [flash()])
    expect(many.messages).toEqual(['2 files were not added: Image to Video · Kling 4.0 Flash takes up to 1 image.'])
  })

  it('rejects formats, sizes, durations and dimensions the ledger rules out', () => {
    const sd = limit('imageToVideo', 'kie', 'seedance-2')
    expect(checkCandidates('image', [], [file('a.heic', { type: 'image/heic' })], [sd]).messages)
      .toEqual(['a.heic: Image to Video · Seedance 2 accepts jpeg, jpg, png, webp, bmp, tiff, gif images.'])
    expect(checkCandidates('image', [], [file('big.png', { size_bytes: 31_000_000 })], [sd]).messages)
      .toEqual(['big.png is 31.0 MB; Image to Video · Seedance 2 accepts up to 30.0 MB per image.'])
    expect(checkCandidates('image', [], [file('tiny.png', { width: 100, height: 400 })], [sd]).messages)
      .toEqual(['tiny.png is 100x400 px; Image to Video · Seedance 2 needs each side to be at least 300 px.'])
    const omni = limit('omniReferenceToVideo', 'kie', 'seedance-2', 'video', 'Omni')
    expect(checkCandidates('video', [], [file('long.mp4', { type: 'video/mp4', duration_s: 20 })], [omni]).messages)
      .toEqual(['long.mp4 is 20 s long; Omni · Seedance 2 accepts up to 15 s per video.'])
    expect(checkCandidates('video', [], [file('short.mp4', { type: 'video/mp4', duration_s: 1 })], [omni]).messages)
      .toEqual(['short.mp4 is 1 s long; Omni · Seedance 2 needs at least 2 s per video.'])
    expect(checkCandidates('video', [item('v', { duration_s: 10 })], [file('more.mp4', { type: 'video/mp4', duration_s: 8 })], [omni]).messages)
      .toEqual(['more.mp4 would bring the videos to 18 s; Omni · Seedance 2 takes 15 s in total.'])
  })

  it('refuses every file when a consumer does not take the kind', () => {
    const none = limit('imageToVideo', 'piapi', 'seedance-2.5')
    const r = checkCandidates('image', [], [file('a.png')], [none])
    expect(r.accepted).toEqual([])
    expect(r.messages[0]).toMatch(/^Nothing was added: Image to Video · Seedance 2.5 /)
  })

  it('replacing an item does not count it against the limit', () => {
    expect(checkCandidates('image', [item('a')], [file('b.png')], [flash()], 'a').accepted).toEqual([0])
  })
})

describe('flagItems', () => {
  it('flags nothing without consumers, and the excess past the strictest count', () => {
    const items = [item('a'), item('b'), item('c')]
    expect(flagItems('image', items, []).map((f) => f.status)).toEqual(['ok', 'ok', 'ok'])
    const flags = flagItems('image', items, [limit('imageToVideo', 'kie', 'seedance-2'), flash()])
    expect(flags.map((f) => f.status)).toEqual(['ok', 'over_limit', 'over_limit'])
    expect(flags[1].reason).toBe('Image to Video · Kling 4.0 Flash takes up to 1 image.')
  })

  it('flags every item when the kind is not accepted', () => {
    const flags = flagItems('image', [item('a'), item('b')], [limit('imageToVideo', 'piapi', 'seedance-2.5')])
    expect(flags.every((f) => f.status === 'unsupported')).toBe(true)
  })

  it('flags an item whose format another consumer rejects', () => {
    const flags = flagItems('video', [item('a', { label: 'a.mkv', local: '/outputs/a.mkv' })],
      [limit('omniReferenceToVideo', 'piapi', 'seedance-2.5', 'video', 'Omni')])
    expect(flags[0]).toEqual({ status: 'incompatible', reason: 'Omni · Seedance 2.5 does not accept .mkv videos (use mp4, mov).' })
  })
})

describe('list helpers', () => {
  it('moves by one, never off the ends, and removes only the extras', () => {
    const items = [item('a'), item('b'), item('c')]
    expect(moveItem(items, 'b', -1).map((i) => i.id)).toEqual(['b', 'a', 'c'])
    expect(moveItem(items, 'a', -1)).toBe(items)
    expect(moveItem(items, 'c', 1)).toBe(items)
    const flags = flagItems('image', items, [flash()])
    expect(removeExtras(items, flags).map((i) => i.id)).toEqual(['a'])
  })

  it('emits refs that carry the local path and metadata, in order', () => {
    const refs = itemsToOutput('image', [item('a', { size_bytes: 5, width: 1, height: 2 }), item('b', { status: 'saving', local: undefined })])
    expect(refs).toEqual([{ kind: 'image-ref', local: '/outputs/a.png', label: 'a.png', size_bytes: 5, width: 1, height: 2 }])
    expect(itemsToOutput('video', [item('v', { label: 'v.mp4', local: '/outputs/v.mp4', duration_s: 3 })]))
      .toEqual([{ kind: 'video-ref', local: '/outputs/v.mp4', label: 'v.mp4', duration_s: 3 }])
  })

  it('emits audio refs with no name', () => {
    expect(itemsToOutput('audio', [item('s', { label: 'song.mp3', local: '/outputs/song.mp3' })]))
      .toEqual([{ kind: 'audio-ref', local: '/outputs/song.mp3', label: 'song.mp3' }])
  })
})

describe('audio', () => {
  it('accepts audio files, worded once', () => {
    expect(checkCandidates('audio', [], [file('a.mp3', { type: 'audio/mpeg' }), file('b.png')], []).messages).toEqual(['b.png is not an audio file.'])
    expect(checkCandidates('audio', [], [file('a.wav', { type: '' })], []).accepted).toEqual([0])
  })

  it('has no name rules: unnamed and same-named clips are fine', () => {
    const flags = flagItems('audio', [item('a', { label: 'Ava.mp3' }), item('b', { label: ' ' }), item('c', { label: 'ava.mp3' })], [])
    expect(flags.map((f) => f.status)).toEqual(['ok', 'ok', 'ok'])
  })

  it('restores items without a name, even from older sessions that saved one', () => {
    const [restored] = restoreLoaderItems([{ id: 'v', label: 'Zoë 李.wav', local: '/outputs/z.wav', name: 'Zo', status: 'ready' }])
    expect(restored).toEqual({ id: 'v', label: 'Zoë 李.wav', local: '/outputs/z.wav', status: 'ready' })
    expect(itemsToOutput('audio', [restored])).toEqual([{ kind: 'audio-ref', local: '/outputs/z.wav', label: 'Zoë 李.wav' }])
  })
})

describe('character on refs', () => {
  it('passes an item character through to its ref, and only when it is non-empty', () => {
    expect(itemsToOutput('image', [item('a', { character: 'Mia' })])).toEqual([
      { kind: 'image-ref', local: '/outputs/a.png', label: 'a.png', character: 'Mia' },
    ])
    expect(itemsToOutput('image', [item('a', { character: '' })])[0]).not.toHaveProperty('character')
  })
})
