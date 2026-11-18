import { describe, expect, it } from 'vitest'
import * as helpers from './use-characters'
import { defaultAudio, defaultFace, mediaOfKind, needsFace } from './use-characters'
import type { Character, CharacterMedia } from './types'

const media = (id: string, kind: CharacterMedia['kind'], position: number): CharacterMedia => ({
  id, kind, label: `${id}.file`, local: `/outputs/characters/c1/${id}`, size_bytes: 1, width: null, height: null, duration_s: null, position, created_at: '',
})
const character = (over: Partial<Character> = {}): Character => ({
  id: 'c1', name: 'Mia', description: '', created_at: '', updated_at: '', default_face_id: null, default_audio_id: null, media: [], ...over,
})

describe('no speaker names', () => {
  it('has no voice-name or default-voice helper: sound is audio and is not named', () => {
    expect(helpers).not.toHaveProperty('voiceNameFor')
    expect(helpers).not.toHaveProperty('defaultVoice')
  })
})

describe('media helpers', () => {
  const c = character({
    media: [media('a2', 'audio', 1), media('i2', 'image', 1), media('a1', 'audio', 0), media('i1', 'image', 0), media('vid', 'video', 0)],
    default_face_id: 'i2',
    default_audio_id: 'a2',
  })
  it('mediaOfKind returns one kind in position order', () => {
    expect(mediaOfKind(c, 'image').map((m) => m.id)).toEqual(['i1', 'i2'])
    expect(mediaOfKind(c, 'audio').map((m) => m.id)).toEqual(['a1', 'a2'])
    expect(mediaOfKind(character(), 'video')).toEqual([])
  })
  it('defaultFace and defaultAudio find the default media', () => {
    expect(defaultFace(c)?.id).toBe('i2')
    expect(defaultAudio(c)?.id).toBe('a2')
  })
  it('return null when unset or the id is stale or of the wrong kind', () => {
    expect(defaultFace(character())).toBeNull()
    expect(defaultFace(character({ default_face_id: 'gone' }))).toBeNull()
    expect(defaultFace({ ...c, default_face_id: 'v1' })).toBeNull()
    expect(defaultAudio({ ...c, default_audio_id: 'i1' })).toBeNull()
    expect(defaultAudio({ ...c, default_audio_id: 'gone' })).toBeNull()
    expect(defaultAudio(character())).toBeNull()
  })
})

describe('needsFace', () => {
  it('is true without a default face, including a stale or wrong-kind id', () => {
    expect(needsFace(character())).toBe(true)
    expect(needsFace(character({ default_face_id: 'gone', media: [media('i1', 'image', 0)] }))).toBe(true)
    expect(needsFace(character({ default_face_id: 'v1', media: [media('v1', 'video', 0)] }))).toBe(true)
  })
  it('is false when the default face is one of its images', () => {
    expect(needsFace(character({ default_face_id: 'i1', media: [media('i1', 'image', 0)] }))).toBe(false)
  })
})
