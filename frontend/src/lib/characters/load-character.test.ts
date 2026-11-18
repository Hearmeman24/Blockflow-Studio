import { describe, expect, it } from 'vitest'
import { itemsToOutput } from '@/lib/byok/loader-items'
import {
  EMPTY_SELECTION,
  buildSnapshot,
  defaultSelection,
  deselectMedia,
  restoreCharacterId,
  restoreSelection,
  restoreSnapshot,
  selectedItems,
  selectedCount,
  snapshotTargets,
  toggleMedia,
} from './load-character'
import type { Character, CharacterMedia } from './types'

const media = (id: string, kind: CharacterMedia['kind'], position: number, over: Partial<CharacterMedia> = {}): CharacterMedia => ({
  id, kind, label: `${id}.file`, local: `/outputs/characters/c1/${id}`, size_bytes: 10, width: null, height: null, duration_s: null, position, created_at: '', ...over,
})
const character = (over: Partial<Character> = {}): Character => ({
  id: 'c1', name: 'Mia Rose', description: '', created_at: '', updated_at: '', default_face_id: null, default_audio_id: null, media: [], ...over,
})

const MIA = character({
  media: [
    media('i1', 'image', 0, { width: 800, height: 600 }), media('i2', 'image', 1), media('vid', 'video', 0, { duration_s: 4.5 }),
    media('a1', 'audio', 0), media('a2', 'audio', 1), media('a3', 'audio', 2),
  ],
  default_face_id: 'i2',
  default_audio_id: 'a2',
})

describe('defaultSelection', () => {
  it('selects the default face and the default audio clip', () => {
    expect(defaultSelection(MIA)).toEqual({ image: ['i2'], video: [], audio: ['a2'] })
  })
  it('selects nothing when no defaults are set, or they are stale', () => {
    expect(defaultSelection(character())).toEqual(EMPTY_SELECTION)
    expect(defaultSelection(character({ default_face_id: 'gone', default_audio_id: 'gone' }))).toEqual(EMPTY_SELECTION)
  })
  it('the empty selection has the three kinds and no voice', () => {
    expect(EMPTY_SELECTION).toEqual({ image: [], video: [], audio: [] })
  })
})

describe('toggleMedia', () => {
  it('appends in click order and removes on a second click', () => {
    let sel = toggleMedia(EMPTY_SELECTION, 'image', 'i2')
    sel = toggleMedia(sel, 'image', 'i1')
    expect(sel.image).toEqual(['i2', 'i1'])
    sel = toggleMedia(sel, 'image', 'i2')
    expect(sel.image).toEqual(['i1'])
    expect(toggleMedia(sel, 'audio', 'a1').audio).toEqual(['a1'])
  })
  it('audio is multi-select in click order, like images', () => {
    let sel = toggleMedia(defaultSelection(MIA), 'audio', 'a3')
    sel = toggleMedia(sel, 'audio', 'a1')
    expect(sel.audio).toEqual(['a2', 'a3', 'a1'])
    expect(toggleMedia(sel, 'audio', 'a2').audio).toEqual(['a3', 'a1'])
  })
  it('deselectMedia drops the given ids of one kind', () => {
    const sel = { ...EMPTY_SELECTION, image: ['i1', 'i2', 'i3'], audio: ['a1', 'a2'] }
    expect(deselectMedia(sel, 'image', ['i1', 'i3']).image).toEqual(['i2'])
    expect(deselectMedia(sel, 'audio', ['a1']).audio).toEqual(['a2'])
    expect(deselectMedia(sel, 'audio', ['other']).audio).toEqual(['a1', 'a2'])
  })
})

describe('restoring saved config', () => {
  it('character id: a non-empty string or null', () => {
    expect(restoreCharacterId('c1')).toBe('c1')
    for (const bad of ['', 3, null, undefined, {}, ['c1']]) expect(restoreCharacterId(bad)).toBeNull()
  })
  it('selection: wrong shapes become empty, non-string ids and duplicates are dropped', () => {
    for (const bad of [null, undefined, 'x', 3, [], { image: 'i1' }]) expect(restoreSelection(bad)).toEqual(EMPTY_SELECTION)
    expect(restoreSelection({ image: ['i1', 2, '', 'i1', 'i2'], video: null, audio: ['a1'], voice: 7 }))
      .toEqual({ image: ['i1', 'i2'], video: [], audio: ['a1'] })
  })
  it('selection: a voice saved by an older version is appended after the audio, once', () => {
    expect(restoreSelection({ image: [], video: [], audio: ['a1', 'a2'], voice: 'v1' })).toEqual({ image: [], video: [], audio: ['a1', 'a2', 'v1'] })
    expect(restoreSelection({ voice: 'v1' })).toEqual({ ...EMPTY_SELECTION, audio: ['v1'] })
    expect(restoreSelection({ audio: ['v1'], voice: 'v1' })).toEqual({ ...EMPTY_SELECTION, audio: ['v1'] })
    expect(restoreSelection({ audio: ['a1'], voice: null })).toEqual({ ...EMPTY_SELECTION, audio: ['a1'] })
  })
  it('snapshot: wrong shapes become empty; items need a valid kind, a local path and a label', () => {
    for (const bad of [null, 'x', [], { name: 3 }]) expect(restoreSnapshot(bad)).toEqual({ name: '', items: {} })
    const restored = restoreSnapshot({
      name: 'Zoë 李',
      items: {
        ok: { kind: 'image', label: 'face ✨.png', local: '/outputs/characters/c1/ok.png', width: 10, height: 'x', size_bytes: Infinity },
        badKind: { kind: 'text', label: 'a', local: '/outputs/a' },
        noLocal: { kind: 'image', label: 'a' },
        notOutputs: { kind: 'image', label: 'a', local: '/etc/passwd' },
        noLabel: { kind: 'audio', local: '/outputs/characters/c1/a.wav' },
        oldVoice: { kind: 'voice', label: 'Zoë 李.wav', local: '/outputs/characters/c1/v.wav' },
        junk: 'x',
      },
    })
    expect(restored).toEqual({
      name: 'Zoë 李',
      items: {
        ok: { kind: 'image', label: 'face ✨.png', local: '/outputs/characters/c1/ok.png', width: 10 },
        noLabel: { kind: 'audio', label: 'a.wav', local: '/outputs/characters/c1/a.wav' },
        // A voice saved by an older version reads as audio.
        oldVoice: { kind: 'audio', label: 'Zoë 李.wav', local: '/outputs/characters/c1/v.wav' },
      },
    })
  })
})

describe('buildSnapshot', () => {
  it('records the name and the selected items as currently seen', () => {
    const snap = buildSnapshot(MIA, { image: ['i1'], video: ['vid'], audio: ['a1'] }, { name: '', items: {} })
    expect(snap).toEqual({
      name: 'Mia Rose',
      items: {
        i1: { kind: 'image', label: 'i1.file', local: '/outputs/characters/c1/i1', size_bytes: 10, width: 800, height: 600 },
        vid: { kind: 'video', label: 'vid.file', local: '/outputs/characters/c1/vid', size_bytes: 10, duration_s: 4.5 },
        a1: { kind: 'audio', label: 'a1.file', local: '/outputs/characters/c1/a1', size_bytes: 10 },
      },
    })
  })
  it('keeps the last-seen entry of a selected file the character no longer has, and drops deselected ones', () => {
    const previous = {
      name: 'Old name',
      items: {
        gone: { kind: 'image' as const, label: 'gone.png', local: '/outputs/characters/c1/gone.png' },
        dropped: { kind: 'image' as const, label: 'dropped.png', local: '/outputs/characters/c1/dropped.png' },
      },
    }
    const snap = buildSnapshot(MIA, { ...EMPTY_SELECTION, image: ['gone', 'i2'] }, previous)
    expect(Object.keys(snap.items)).toEqual(['gone', 'i2'])
    expect(snap.items.gone).toEqual(previous.items.gone)
    expect(snap.name).toBe('Mia Rose')
  })
})

describe('selectedItems', () => {
  const sel = { image: ['i1', 'i2'], video: ['vid'], audio: ['a2', 'a1'] }

  it('builds ready loader items in send order with metadata and the character name, never a speaker name', () => {
    const images = selectedItems('image', sel, MIA, { name: '', items: {} })
    expect(images.map((i) => i.id)).toEqual(['i1', 'i2'])
    expect(images[0]).toEqual({
      id: 'i1', label: 'i1.file', local: '/outputs/characters/c1/i1', size_bytes: 10, width: 800, height: 600, status: 'ready', character: 'Mia Rose',
    })
    const audio = selectedItems('audio', sel, MIA, { name: '', items: {} })
    expect(audio.map((i) => i.id)).toEqual(['a2', 'a1'])
    expect(audio[0]).toEqual({ id: 'a2', label: 'a2.file', local: '/outputs/characters/c1/a2', size_bytes: 10, status: 'ready', character: 'Mia Rose' })
    expect(selectedItems('video', sel, MIA, { name: '', items: {} })[0]).toMatchObject({ duration_s: 4.5 })
  })

  it('itemsToOutput puts the character on every ref; audio refs are plain audio', () => {
    const refs = itemsToOutput('audio', selectedItems('audio', sel, MIA, { name: '', items: {} }))
    expect(refs[0]).toEqual({ kind: 'audio-ref', local: '/outputs/characters/c1/a2', label: 'a2.file', size_bytes: 10, character: 'Mia Rose' })
  })

  it('keeps a Unicode character name as is', () => {
    const [clip] = selectedItems('audio', sel, { ...MIA, name: '李小龙' }, { name: '', items: {} })
    expect(clip.character).toBe('李小龙')
    expect(clip).not.toHaveProperty('name')
  })

  it('falls back to the snapshot for a file the character no longer has', () => {
    const snapshot = { name: 'Mia Rose', items: { gone: { kind: 'image' as const, label: 'gone.png', local: '/outputs/characters/c1/gone.png' } } }
    const items = selectedItems('image', { ...EMPTY_SELECTION, image: ['gone', 'i1', 'unknown'] }, MIA, snapshot)
    // An id with neither a live file nor a snapshot entry has nothing to show and is left out.
    expect(items.map((i) => [i.id, i.label, i.local])).toEqual([
      ['gone', 'gone.png', '/outputs/characters/c1/gone.png'],
      ['i1', 'i1.file', '/outputs/characters/c1/i1'],
    ])
  })

  it('renders entirely from the snapshot when the character is gone or not loaded, with the snapshot name', () => {
    const snapshot = buildSnapshot(MIA, sel, { name: '', items: {} })
    const items = selectedItems('audio', sel, null, snapshot)
    expect(items).toEqual([
      expect.objectContaining({ id: 'a2', local: '/outputs/characters/c1/a2', character: 'Mia Rose' }),
      expect.objectContaining({ id: 'a1', local: '/outputs/characters/c1/a1', character: 'Mia Rose' }),
    ])
  })

  it('ignores a snapshot entry of another kind', () => {
    const snapshot = { name: 'X', items: { i1: { kind: 'video' as const, label: 'x', local: '/outputs/x' } } }
    expect(selectedItems('image', { ...EMPTY_SELECTION, image: ['i1'] }, null, snapshot)).toEqual([])
  })

  it('a media id selected under the wrong kind is not used', () => {
    expect(selectedItems('image', { ...EMPTY_SELECTION, image: ['a1'] }, MIA, { name: '', items: {} })).toEqual([])
  })
})

describe('counts and flow targets', () => {
  it('selectedCount counts every kind', () => {
    expect(selectedCount(EMPTY_SELECTION)).toBe(0)
    expect(selectedCount({ image: ['a', 'b'], video: [], audio: ['c', 'd'] })).toBe(4)
  })
  it('snapshotTargets lists the selected snapshot items with their kind and local path, in kind then send order', () => {
    const config = {
      selection: { image: ['i2', 'i1'], video: [], audio: ['a1'] },
      snapshot: buildSnapshot(MIA, { image: ['i1', 'i2'], video: [], audio: ['a1'] }, { name: '', items: {} }),
    }
    expect(snapshotTargets(config)).toEqual([
      { kind: 'image', local: '/outputs/characters/c1/i2' },
      { kind: 'image', local: '/outputs/characters/c1/i1' },
      { kind: 'audio', local: '/outputs/characters/c1/a1' },
    ])
    expect(snapshotTargets({})).toEqual([])
    expect(snapshotTargets({ selection: 'bad', snapshot: 7 })).toEqual([])
  })
})
