import { describe, expect, it } from 'vitest'
import {
  combineReferences,
  moveReference,
  removeReference,
  restoreReferences,
  toRequestReference,
  upstreamReferences,
  type GenerationReference,
} from './references'

const local = (id: string, kind: GenerationReference['kind'] = 'image', extra: Partial<GenerationReference> = {}): GenerationReference => ({
  id, kind, role: 'reference', local: `/outputs/${id}`, status: 'ready', ...extra,
})

describe('upstreamReferences', () => {
  it('reads image, video and audio ports in order, preferring the local copy', () => {
    const refs = upstreamReferences({
      image: [
        { kind: 'image-ref', local: '/outputs/a.png', url: 'https://tmp/a.png' },
        'https://cdn/b.jpg',
      ],
      video: { kind: 'video-ref', local: '/outputs/c.mp4' },
      audio: ['/outputs/d.mp3'],
      text: 'ignored',
    }, ['image', 'video', 'audio'])
    expect(refs.map((r) => [r.id, r.kind, r.local, r.url, r.label])).toEqual([
      ['upstream:image:0', 'image', '/outputs/a.png', 'https://tmp/a.png', 'a.png'],
      ['upstream:image:1', 'image', undefined, 'https://cdn/b.jpg', 'b.jpg'],
      ['upstream:video:0', 'video', '/outputs/c.mp4', undefined, 'c.mp4'],
      ['upstream:audio:0', 'audio', '/outputs/d.mp3', undefined, 'd.mp3'],
    ])
  })

  it('only reads the ports the block uses', () => {
    expect(upstreamReferences({ image: '/outputs/a.png', video: '/outputs/b.mp4' }, ['video']).map((r) => r.kind)).toEqual(['video'])
  })

  it('carries the loader metadata so limits can be checked on upstream files', () => {
    const [ref] = upstreamReferences({
      video: [{ kind: 'video-ref', local: '/outputs/20261115_clip.mp4', label: 'clip.mp4', size_bytes: 42, width: 640, height: 360, duration_s: 4.5 }],
    }, ['video'])
    expect(ref).toMatchObject({ label: 'clip.mp4', size_bytes: 42, width: 640, height: 360, duration_s: 4.5, local: '/outputs/20261115_clip.mp4' })
  })

  it('reads sound from the audio port and never carries a speaker name', () => {
    const [ref] = upstreamReferences({ audio: [{ kind: 'audio-ref', local: '/outputs/ava.mp3', label: 'ava.mp3', name: 'Ava' }] }, ['audio'])
    expect(ref).toMatchObject({ kind: 'audio', label: 'ava.mp3', local: '/outputs/ava.mp3' })
    expect(ref).not.toHaveProperty('name')
  })

  it('ignores a value left on a retired voice port', () => {
    expect(upstreamReferences({ voice: [{ kind: 'voice-ref', local: '/outputs/v.mp3' }] }, ['image', 'video', 'audio'])).toEqual([])
  })

  it('keeps an upstream preview that was never saved, flagged as broken', () => {
    const [ref] = upstreamReferences({ image: { kind: 'image-ref', local: 'blob:http://x/1' } }, ['image'])
    expect(ref.local).toBeUndefined()
    expect(ref.url).toBeUndefined()
    expect(ref.status).toBe('error')
    expect(ref.error).toMatch(/not been saved/)
  })
})

describe('combineReferences', () => {
  it('puts upstream references first and keeps local order', () => {
    const entries = combineReferences('omni_reference_to_video', [local('up', 'image')], [local('b', 'video'), local('a')])
    expect(entries.map((e) => [e.ref.id, e.source, e.ref.role])).toEqual([
      ['up', 'upstream', 'reference'],
      ['b', 'local', 'reference'],
      ['a', 'local', 'reference'],
    ])
  })

  it('assigns first and last frame by position in Image to Video', () => {
    const entries = combineReferences('image_to_video', [local('up')], [local('a'), local('b')])
    expect(entries.map((e) => e.ref.role)).toEqual(['first_frame', 'last_frame', 'reference'])
  })

  it('does not mutate its inputs', () => {
    const items = Object.freeze([Object.freeze(local('a'))]) as GenerationReference[]
    expect(() => combineReferences('image_to_video', [], items)).not.toThrow()
    expect(items[0].role).toBe('reference')
  })
})

describe('list edits', () => {
  const list = [local('a'), local('b'), local('c')]

  it('moves items up and down and stops at the ends', () => {
    expect(moveReference(list, 'b', -1).map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(moveReference(list, 'b', 1).map((r) => r.id)).toEqual(['a', 'c', 'b'])
    expect(moveReference(list, 'a', -1)).toBe(list)
    expect(moveReference(list, 'c', 1)).toBe(list)
  })

  it('moves past references of other kinds', () => {
    const mixed = [local('a'), local('v', 'video'), local('b')]
    expect(moveReference(mixed, 'b', -1).map((r) => r.id)).toEqual(['b', 'v', 'a'])
    expect(moveReference(mixed, 'v', 1)).toBe(mixed)
  })

  it('removes by id', () => {
    expect(removeReference(list, 'b').map((r) => r.id)).toEqual(['a', 'c'])
  })
})

describe('toRequestReference', () => {
  it('sends the backend fields only: an audio clip has no name', () => {
    expect(toRequestReference(local('v', 'audio', { label: 'ann.mp3', size_bytes: 10, format: 'mp3' }), 'reference'))
      .toEqual({ kind: 'audio', role: 'reference', local: '/outputs/v', size_bytes: 10, format: 'mp3' })
  })

  it('never sends a name', () => {
    // A reference restored from an older session may still carry a voice name.
    const legacy = { ...local('i', 'image', { url: 'https://u/i.png' }), name: 'x' } as GenerationReference
    expect(toRequestReference(legacy, 'first_frame'))
      .toEqual({ kind: 'image', role: 'first_frame', local: '/outputs/i', url: 'https://u/i.png' })
  })
})

describe('restoreReferences', () => {
  it('round-trips saved references', () => {
    const saved = [local('a', 'image', { label: 'a.png', width: 10, height: 20 }), local('v', 'audio', { label: 'v.mp3' })]
    expect(restoreReferences(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
  })

  it('reads a saved voice reference (older flows) as audio, without its name', () => {
    const [ref] = restoreReferences([{ id: 'v', kind: 'voice', role: 'reference', local: '/outputs/v.mp3', name: 'Ann', label: 'ann.mp3' }])
    expect(ref).toEqual({ id: 'v', kind: 'audio', role: 'reference', local: '/outputs/v.mp3', label: 'ann.mp3' })
  })

  it('flags interrupted uploads instead of dropping them', () => {
    const [ref] = restoreReferences([{ id: 'x', kind: 'image', role: 'reference', status: 'uploading', label: 'x.png' }])
    expect(ref.status).toBe('error')
    expect(ref.error).toBe('The upload was interrupted. Remove this reference and add the file again.')
  })

  it('ignores values that are not references', () => {
    expect(restoreReferences('nope')).toEqual([])
    expect(restoreReferences([null, { kind: 'gif' }, { id: 'a', kind: 'image' }]).map((r) => r.id)).toEqual(['a'])
  })
})

describe('character on upstream references', () => {
  it('reads a non-empty character name from the upstream ref, of any kind', () => {
    const refs = upstreamReferences({
      image: [{ kind: 'image-ref', local: '/outputs/a.png', character: 'Zoë 李' }, { kind: 'image-ref', local: '/outputs/b.png', character: '' }],
      audio: [{ kind: 'audio-ref', local: '/outputs/v.wav', character: 'Mia' }, { kind: 'audio-ref', local: '/outputs/s.mp3', character: 7 }],
    }, ['image', 'audio'])
    expect(refs.map((r) => r.character)).toEqual(['Zoë 李', undefined, 'Mia', undefined])
  })

  it('keeps it through restoreReferences', () => {
    const saved = [local('a', 'image', { label: 'a.png', character: 'Mia' })]
    expect(restoreReferences(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
  })
})
