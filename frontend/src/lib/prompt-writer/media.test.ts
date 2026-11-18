import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SEND_MEDIA,
  mediaBlocker,
  modelAccepts,
  normalizeSendMedia,
  unavailableReason,
  upstreamMedia,
} from './media'
import type { WriterProviderStatus } from './types'

const OPENROUTER: WriterProviderStatus = {
  id: 'openrouter', label: 'OpenRouter', kind: 'hosted', available: true, reason: null,
  models: [
    { id: 'text/only', name: 'Text Only', accepts: [] },
    { id: 'see/all', name: 'Sees All', accepts: ['image', 'video', 'audio'] },
    { id: 'see/image', name: 'Sees Images', accepts: ['image'] },
  ],
  models_error: null, base_url: null,
}
const OLLAMA: WriterProviderStatus = {
  id: 'ollama', label: 'Ollama', kind: 'local', available: true, reason: null,
  models: [{ id: 'llava', name: 'llava', accepts: ['image'] }, { id: 'llama', name: 'llama', accepts: [] }],
  models_error: null, base_url: 'http://localhost:11434',
}

describe('normalizeSendMedia', () => {
  it('defaults every kind to unticked, for flows saved before the boxes existed', () => {
    expect(normalizeSendMedia(undefined)).toEqual({ image: false, video: false, audio: false })
    expect(normalizeSendMedia(null)).toEqual(DEFAULT_SEND_MEDIA)
    expect(normalizeSendMedia('yes')).toEqual(DEFAULT_SEND_MEDIA)
    expect(normalizeSendMedia([true])).toEqual(DEFAULT_SEND_MEDIA)
  })

  it('keeps only real true values', () => {
    expect(normalizeSendMedia({ image: true, video: 'true', audio: 1, voice: true })).toEqual({ image: true, video: false, audio: false })
  })
})

describe('modelAccepts', () => {
  it('reads a listed model', () => {
    expect(modelAccepts(OPENROUTER, 'see/all', 'video')).toBe(true)
    expect(modelAccepts(OPENROUTER, 'text/only', 'image')).toBe(false)
  })

  it('is unknown for a model that is not listed (a typed OpenRouter ID)', () => {
    expect(modelAccepts(OPENROUTER, 'typed/id', 'video')).toBeNull()
  })

  it('local servers never take video or audio, listed or not', () => {
    expect(modelAccepts(OLLAMA, 'llava', 'video')).toBe(false)
    expect(modelAccepts(OLLAMA, 'unlisted', 'audio')).toBe(false)
    expect(modelAccepts(OLLAMA, 'unlisted', 'image')).toBeNull()
  })
})

describe('unavailableReason', () => {
  it('names the first ticked kind the model does not take', () => {
    expect(unavailableReason(OPENROUTER, 'see/image', ['image', 'video'])).toBe('Does not accept video')
    expect(unavailableReason(OPENROUTER, 'text/only', ['image'])).toBe('Does not accept images')
    expect(unavailableReason(OPENROUTER, 'see/all', ['image', 'video', 'audio'])).toBeNull()
    expect(unavailableReason(OPENROUTER, 'text/only', [])).toBeNull()
  })
})

describe('mediaBlocker', () => {
  it('is null with nothing ticked or a model that takes every ticked kind', () => {
    expect(mediaBlocker(OPENROUTER, 'text/only', [])).toBeNull()
    expect(mediaBlocker(OPENROUTER, 'see/all', ['video', 'audio'])).toBeNull()
    expect(mediaBlocker(OPENROUTER, 'typed/id', ['video'])).toBeNull()
  })

  it('tells the user to pick another model or untick the box', () => {
    expect(mediaBlocker(OPENROUTER, 'see/image', ['image', 'video'])).toBe(
      'Sees Images does not accept videos. Pick a model that accepts videos, or untick Videos.',
    )
  })

  it('says plainly when no model of the provider takes the kind', () => {
    expect(mediaBlocker(OLLAMA, 'llava', ['image', 'video'])).toBe(
      'No Ollama model accepts videos. Untick Videos, or choose OpenRouter and a model that accepts videos.',
    )
    const noAudio = { ...OPENROUTER, models: OPENROUTER.models.filter((m) => !m.accepts.includes('audio')) }
    expect(mediaBlocker(noAudio, 'see/image', ['audio'])).toBe('No OpenRouter model accepts audio. Untick Audio.')
  })
})

describe('upstreamMedia', () => {
  it('reads loader refs per kind, in order, with counts, through the shared reference helpers', () => {
    const media = upstreamMedia({
      image: [{ kind: 'image-ref', local: '/outputs/a.png', label: 'a.png' }, { kind: 'image-ref', local: '/outputs/b.png' }],
      video: { kind: 'video-ref', local: '/outputs/c.mp4' },
      text: 'ignored',
    })
    expect(media.counts).toEqual({ image: 2, video: 1, audio: 0 })
    expect(media.refs.map((r) => [r.kind, r.local])).toEqual([
      ['image', '/outputs/a.png'], ['image', '/outputs/b.png'], ['video', '/outputs/c.mp4'],
    ])
  })

  it('is empty with nothing upstream', () => {
    expect(upstreamMedia({}).counts).toEqual({ image: 0, video: 0, audio: 0 })
  })
})
