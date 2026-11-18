import { describe, expect, it } from 'vitest'
import type { BlockResult, RunEntry } from '@/lib/types'
import {
  DEFAULT_ASPECT, findPrimaryArtifact, mediaUrls, parseAspectRatio, primaryMeta, runAspect, runFailure, runModelId, runOutputs,
  runPrompt, runProviderId, runReferences, runSettings,
} from './run-media'

// Shapes copied from real runs.
const LOADER_REF = {
  kind: 'image-ref', local: '/outputs/20261115_150936_ComfyUI_temp_atlvf_00015_.png',
  label: 'ComfyUI_temp_atlvf_00015_.png', size_bytes: 1767903, width: 1072, height: 1136,
}
const META = {
  job_id: '5de0992c', provider: 'kie', model: 'seedream-5-flash',
  cost: { amount: 3.24, unit: 'credits', usd_equivalent: 0.0162 },
}
const GEN_REF = { kind: 'image-ref', local: '/outputs/byok/5de0992c_1.png', url: 'https://tempfile.aiquickdraw.com/x.png', meta: META }

const block = (i: number, type: string, label: string, outputs: BlockResult['outputs'], status = 'completed'): BlockResult =>
  ({ block_index: i, block_type: type, block_label: label, status, outputs })

function run(block_results: BlockResult[], flow_snapshot: Record<string, unknown> = {}, status: RunEntry['status'] = 'completed'): RunEntry {
  return { id: 'r', name: 'Pipeline Run', status, duration_ms: 1, flow_snapshot, block_results, created_at: '2026-11-15T15:00:00Z' }
}

const GEN_CONFIG = {
  provider: 'kie', model: 'seedream-5-flash', prompt: 'A harsh flash photograph of Image1 ✨', use_upstream_prompt: false,
  params: { duration: null, resolution: '1.5K', aspect_ratio: null, settings: { quality: 'high' } },
}
const SNAPSHOT = { blocks: [{ type: 'uploadImageToTmpfiles', config: { items: [] } }, { type: 'imageToImage', config: GEN_CONFIG }] }
const BYOK = run([
  block(0, 'uploadImageToTmpfiles', 'Image Loader', { image: { kind: 'image', value: LOADER_REF } }),
  block(1, 'imageToImage', 'Image to Image', { image: { kind: 'image', value: GEN_REF } }),
  block(2, 'imageViewer', 'Image Viewer', { image: { kind: 'image', value: GEN_REF } }),
], SNAPSHOT)

describe('mediaUrls', () => {
  it('reads refs (local first, then url), arrays of refs and plain strings', () => {
    expect(mediaUrls('image', GEN_REF)).toEqual(['/outputs/byok/5de0992c_1.png'])
    expect(mediaUrls('image', { ...GEN_REF, local: '' })).toEqual(['https://tempfile.aiquickdraw.com/x.png'])
    expect(mediaUrls('image', [GEN_REF, LOADER_REF])).toHaveLength(2)
    expect(mediaUrls('image', ['/outputs/a.png'])).toEqual(['/outputs/a.png'])
    expect(mediaUrls('video', { kind: 'video-ref', local: '/outputs/v.mp4' })).toEqual(['/outputs/v.mp4'])
    expect(mediaUrls('audio', { kind: 'audio-ref', url: 'https://cdn/a.mp3' })).toEqual(['https://cdn/a.mp3'])
    expect(mediaUrls('text', 'hello')).toEqual([])
  })
})

describe('findPrimaryArtifact', () => {
  it('prefers generated output over a loader input wherever the blocks sit, else the last block', () => {
    expect(findPrimaryArtifact(BYOK.block_results)?.blockIndex).toBe(2)
    const reordered = [
      block(0, 'imageToImage', 'Image to Image', { image: { kind: 'image', value: GEN_REF } }),
      block(1, 'uploadImageToTmpfiles', 'Image Loader', { image: { kind: 'image', value: LOADER_REF } }),
    ]
    expect(findPrimaryArtifact(reordered)?.blockIndex).toBe(0)
    expect(findPrimaryArtifact([block(0, 'x', 'X', { image: { kind: 'image', value: LOADER_REF } })])?.blockIndex).toBe(0)
    expect(findPrimaryArtifact([])).toBeNull()
  })

  it('ranks video over image over audio', () => {
    const p = findPrimaryArtifact([
      block(0, 'a', 'A', { audio: { kind: 'audio', value: '/outputs/a.mp3' } }),
      block(1, 'v', 'V', { video: { kind: 'video', value: '/outputs/v.mp4' } }),
      block(2, 'i', 'I', { image: { kind: 'image', value: '/outputs/i.png' } }),
    ])
    expect(p?.kind).toBe('video')
  })

  it('exposes the generation metadata of the primary output', () => {
    expect(primaryMeta(findPrimaryArtifact(BYOK.block_results))?.model).toBe('seedream-5-flash')
    expect(primaryMeta(null)).toBeNull()
  })
})

describe('parseAspectRatio / runAspect', () => {
  it('parses "w:h" and ignores auto or junk', () => {
    expect(parseAspectRatio('16:9')).toBeCloseTo(16 / 9)
    expect(parseAspectRatio('9:16')).toBeCloseTo(9 / 16)
    for (const v of ['auto', '', null, undefined, '0:5', 'a:b', 7]) expect(parseAspectRatio(v)).toBeNull()
  })

  it("uses the ref's own size first", () => {
    const loaderOnly = run([block(0, 'l', 'Loader', { image: { kind: 'image', value: LOADER_REF } })])
    expect(runAspect(loaderOnly)).toBeCloseTo(1072 / 1136)
  })

  it("falls back to the run's requested aspect ratio, then a neutral default", () => {
    const withRatio = run(BYOK.block_results, { blocks: [{ type: 'textToImage', config: { ...GEN_CONFIG, params: { aspect_ratio: '9:16' } } }] })
    expect(runAspect(withRatio)).toBeCloseTo(9 / 16)
    expect(runAspect(BYOK)).toBe(DEFAULT_ASPECT)
    expect(runAspect(run([]))).toBe(DEFAULT_ASPECT)
  })
})

describe('runPrompt', () => {
  it("takes the generation block's prompt from the flow snapshot", () => {
    expect(runPrompt(BYOK)).toBe('A harsh flash photograph of Image1 ✨')
  })

  it('takes the upstream prompt when the generation block uses one', () => {
    const r = run([
      block(0, 'promptWriter', 'Prompt Writer', { prompt: { kind: 'prompt', value: 'Written by the prompt writer' } }),
      block(1, 'textToImage', 'Text to Image', { image: { kind: 'image', value: GEN_REF } }),
    ], { blocks: [{ type: 'promptWriter', config: {} }, { type: 'textToImage', config: { ...GEN_CONFIG, prompt: '', use_upstream_prompt: true } }] })
    expect(runPrompt(r)).toBe('Written by the prompt writer')
  })

  describe('upstream text from a block whose port kind is text', () => {
    const GEN_UP = { ...GEN_CONFIG, prompt: '', use_upstream_prompt: true }
    const writer = (i: number, value: unknown, status = 'completed') =>
      block(i, 'promptWriter', 'Prompt Writer', value === undefined ? {} : { prompt: { kind: 'text', value } }, status)
    const snap = (...blocks: Array<[string, Record<string, unknown>]>) => ({ blocks: blocks.map(([type, config]) => ({ type, config })) })
    const WRITER_CFG = { user_prompt: 'idea', output: 'x' }
    const vid = (i: number, type = 'omniReferenceToVideo') =>
      block(i, type, 'Video', { video: { kind: 'video', value: { kind: 'video-ref', local: '/outputs/v.mp4' } } })

    it('shows the Prompt Writer text for a generation block that uses the upstream prompt', () => {
      const r = run(
        [block(0, 'loadCharacter', 'Load Character', { image: { kind: 'image', value: LOADER_REF } }), writer(1, '  A written prompt  '), vid(2), block(3, 'videoViewer', 'Viewer', {})],
        snap(['loadCharacter', {}], ['promptWriter', WRITER_CFG], ['omniReferenceToVideo', GEN_UP], ['videoViewer', {}]),
      )
      expect(runPrompt(r)).toBe('A written prompt')
    })

    it('uses the closest text producer before the generation block', () => {
      const r = run(
        [writer(0, 'first'), block(1, 'promptFromTxt', 'Prompt From Txt', { text: { kind: 'text', value: 'second' } }), vid(2)],
        snap(['promptWriter', WRITER_CFG], ['promptFromTxt', {}], ['omniReferenceToVideo', GEN_UP]),
      )
      expect(runPrompt(r)).toBe('second')
    })

    it('prefers the own prompt when the switch is off, even with a Prompt Writer upstream', () => {
      const r = run(
        [writer(0, 'from writer'), vid(1)],
        snap(['promptWriter', WRITER_CFG], ['omniReferenceToVideo', { ...GEN_CONFIG, prompt: 'own', use_upstream_prompt: false }]),
      )
      expect(runPrompt(r)).toBe('own')
    })

    it('is empty when the Prompt Writer failed or produced nothing', () => {
      const snapshot = snap(['promptWriter', WRITER_CFG], ['omniReferenceToVideo', GEN_UP])
      expect(runPrompt(run([writer(0, undefined, 'error'), vid(1)], snapshot))).toBe('')
      expect(runPrompt(run([writer(0, ''), vid(1)], snapshot))).toBe('')
      expect(runPrompt(run([writer(0, '   '), vid(1)], snapshot))).toBe('')
      expect(runPrompt(run([vid(1)], snapshot))).toBe('')
    })

    it('ignores text produced after the generation block', () => {
      const r = run(
        [vid(0), writer(1, 'too late')],
        snap(['omniReferenceToVideo', GEN_UP], ['promptWriter', WRITER_CFG]),
      )
      expect(runPrompt(r)).toBe('')
    })

    it('uses the block that produced the primary output when there are two generation blocks', () => {
      const snapshot = snap(
        ['promptWriter', WRITER_CFG],
        ['textToImage', GEN_UP],
        ['promptFromTxt', {}],
        ['omniReferenceToVideo', GEN_UP],
      )
      const results = [
        writer(0, 'for the image'),
        block(1, 'textToImage', 'Text to Image', { image: { kind: 'image', value: GEN_REF } }),
        block(2, 'promptFromTxt', 'Prompt From Txt', { text: { kind: 'text', value: 'for the video' } }),
        vid(3),
      ]
      expect(runPrompt(run(results, snapshot))).toBe('for the video')
      // Primary is the image block when it is the only generated output.
      expect(runPrompt(run(results.slice(0, 3), snapshot))).toBe('for the image')
    })

    it("lets the primary generation block's own prompt win over another block's upstream use", () => {
      const r = run(
        [writer(0, 'writer'), block(1, 'textToImage', 'Text to Image', { image: { kind: 'image', value: GEN_REF } }), vid(2)],
        snap(['promptWriter', WRITER_CFG], ['textToImage', { ...GEN_CONFIG, prompt: 'image prompt', use_upstream_prompt: false }], ['omniReferenceToVideo', GEN_UP]),
      )
      expect(runPrompt(r)).toBe('writer')
    })

    describe('with viewer blocks after the generation block (same ref, same meta)', () => {
      const VID = { kind: 'video-ref', local: '/outputs/byok/j1.mp4', meta: { ...META, job_id: 'j1', model: 'seedance-2-fast', provider: 'piapi' } }
      const prod = (i: number, type: string, kind: string, value: unknown) => block(i, type, type, { [kind]: { kind, value } })
      const cfg = { ...GEN_UP, provider: 'piapi', model: 'seedance-2-fast' }

      it('video run: generation block then videoViewer', () => {
        const r = run(
          [prod(0, 'loadCharacter', 'image', LOADER_REF), writer(1, 'real prompt'), prod(2, 'omniReferenceToVideo', 'video', VID), prod(3, 'videoViewer', 'video', VID)],
          snap(['loadCharacter', {}], ['promptWriter', WRITER_CFG], ['omniReferenceToVideo', cfg], ['videoViewer', {}]),
        )
        expect(runPrompt(r)).toBe('real prompt')
      })

      it('image run: imageToImage then imageViewer', () => {
        const r = run(
          [writer(0, 'image prompt'), prod(1, 'imageToImage', 'image', GEN_REF), prod(2, 'imageViewer', 'image', GEN_REF)],
          snap(['promptWriter', WRITER_CFG], ['imageToImage', GEN_UP], ['imageViewer', {}]),
        )
        expect(runPrompt(r)).toBe('image prompt')
      })

      it('two viewers after the generation block', () => {
        const r = run(
          [writer(0, 'two viewers'), prod(1, 'omniReferenceToVideo', 'video', VID), prod(2, 'videoViewer', 'video', VID), prod(3, 'videoViewer', 'video', VID)],
          snap(['promptWriter', WRITER_CFG], ['omniReferenceToVideo', cfg], ['videoViewer', {}], ['videoViewer', {}]),
        )
        expect(runPrompt(r)).toBe('two viewers')
      })

      it('old runs without meta: nearest generation block at or before the primary', () => {
        const bare = { kind: 'video-ref', local: '/outputs/v.mp4' }
        const r = run(
          [writer(0, 'old'), prod(1, 'omniReferenceToVideo', 'video', bare), prod(2, 'videoViewer', 'video', bare)],
          snap(['promptWriter', WRITER_CFG], ['omniReferenceToVideo', cfg], ['videoViewer', {}]),
        )
        expect(runPrompt(r)).toBe('old')
      })
    })

    it('returns Unicode and long prompts unchanged apart from trimming', () => {
      const long = `日本語 ✨ ${'word '.repeat(2000)}end\nline two 🎬`
      const r = run([writer(0, `\n ${long} \n`), vid(1)], snap(['promptWriter', WRITER_CFG], ['omniReferenceToVideo', GEN_UP]))
      expect(runPrompt(r)).toBe(long)
    })
  })

  it('reads old runs from their metadata output, and is empty without a prompt', () => {
    const old = run([block(0, 'comfyGen', 'ComfyGen', { meta: { kind: 'metadata', value: [{ prompt: 'old prompt', seed: 1 }] } })])
    expect(runPrompt(old)).toBe('old prompt')
    expect(runPrompt(run([]))).toBe('')
    expect(runPrompt(run([], { blocks: 'nope' }))).toBe('')
  })
})

describe('runModelId', () => {
  it('reads the model from metadata, then the snapshot, then old metadata outputs', () => {
    expect(runModelId(BYOK)).toBe('seedream-5-flash')
    const snapshotOnly = run([], SNAPSHOT)
    expect(runModelId(snapshotOnly)).toBe('seedream-5-flash')
    const old = run([block(0, 'c', 'C', { meta: { kind: 'metadata', value: { model: 'flux-dev' } } })])
    expect(runModelId(old)).toBe('flux-dev')
    expect(runModelId(run([]))).toBe('')
  })
})

describe('runFailure', () => {
  it('names the blocks that failed, only for runs that did not complete', () => {
    const failed = run([block(0, 'l', 'Image Loader', {}), block(1, 'g', 'Image to Image', {}, 'error')], {}, 'failed')
    expect(runFailure(failed)).toBe('Image to Image failed.')
    expect(runFailure(run([], {}, 'failed'))).toBe('The run failed.')
    expect(runFailure(run([], {}, 'partial'))).toBe('The run finished partly.')
    expect(runFailure(BYOK)).toBeNull()
  })
})

describe('runOutputs', () => {
  it('lists every output of the primary port with its kind, local copy first', () => {
    const two = run([block(0, 't', 'T', { image: { kind: 'image', value: [GEN_REF, { ...GEN_REF, local: '/outputs/byok/5de0992c_2.png' }] } })])
    expect(runOutputs(two)).toEqual([
      { kind: 'image', url: '/outputs/byok/5de0992c_1.png' },
      { kind: 'image', url: '/outputs/byok/5de0992c_2.png' },
    ])
    expect(runOutputs(run([]))).toEqual([])
  })
})

describe('runProviderId', () => {
  it('reads the provider from metadata, then the snapshot', () => {
    expect(runProviderId(BYOK)).toBe('kie')
    expect(runProviderId(run([], { blocks: [{ type: 'x', config: { ...GEN_CONFIG, provider: 'piapi' } }] }))).toBe('piapi')
    expect(runProviderId(run([]))).toBe('')
  })
})

describe('runSettings', () => {
  it('lists the settings that were used, compactly, skipping empty and off values', () => {
    const r = run([], { blocks: [{ type: 'textToVideo', config: {
      ...GEN_CONFIG,
      params: { duration: 5, resolution: '720p', aspect_ratio: '16:9', settings: { quality: 'high', generate_audio: true, web_search: false, seed: 42, empty: '' } },
    } }] })
    expect(runSettings(r)).toEqual([
      { label: 'Resolution', value: '720p' },
      { label: 'Aspect ratio', value: '16:9' },
      { label: 'Duration', value: '5 s' },
      { label: 'Quality', value: 'high' },
      { label: 'Generate audio', value: 'On' },
      { label: 'Seed', value: '42' },
    ])
  })

  it('is empty without a generation block or settings', () => {
    expect(runSettings(run([]))).toEqual([])
    expect(runSettings(BYOK)).toEqual([{ label: 'Resolution', value: '1.5K' }, { label: 'Quality', value: 'high' }])
  })
})

describe('runReferences', () => {
  it('lists the loader items from the snapshot with their kind', () => {
    const r = run([], { blocks: [
      { type: 'uploadImageToTmpfiles', config: { items: [{ id: 'a', label: 'face.png', local: '/outputs/face.png', status: 'ready' }] } },
      { type: 'videoLoader', config: { items: [{ id: 'v', label: 'take.mov', local: '/outputs/take.mov' }] } },
      { type: 'omniReferenceLoader', config: {
        video_items: [{ id: 'b', label: 'clip.mp4', local: '/outputs/clip.mp4' }],
        audio_items: [{ id: 'c', label: 'voice.mp3', url: 'https://cdn/voice.mp3' }, { id: 'd', label: 'broken' }],
      } },
      { type: 'textToImage', config: GEN_CONFIG },
    ] })
    expect(runReferences(r)).toEqual([
      { kind: 'image', url: '/outputs/face.png', label: 'face.png' },
      { kind: 'video', url: '/outputs/take.mov', label: 'take.mov' },
      { kind: 'video', url: '/outputs/clip.mp4', label: 'clip.mp4' },
      { kind: 'audio', url: 'https://cdn/voice.mp3', label: 'voice.mp3' },
    ])
    expect(runReferences(run([]))).toEqual([])
  })
})

describe('runs saved before voice became audio', () => {
  // An old run: the Omni Reference Loader emitted on a `voice` port with `voice-ref` values.
  const VOICE_REF = { kind: 'voice-ref', local: '/outputs/20261101_ava.wav', label: 'Ava 李.wav', name: 'Ava', size_bytes: 10 }
  const OLD = run([
    block(0, 'omniReferenceLoader', 'Omni Reference Loader', { voice: { kind: 'voice', value: [VOICE_REF] } }),
  ], { schema_version: 5, blocks: [{ type: 'omniReferenceLoader', config: {
    audio_items: [{ id: 'a', label: 'song.mp3', local: '/outputs/song.mp3' }],
    voice_items: [{ id: 'v', label: 'Ava 李.wav', local: '/outputs/20261101_ava.wav', name: 'Ava' }],
  } }] })

  it('reads a voice output as audio: it can be the primary artifact and renders as audio', () => {
    const primary = findPrimaryArtifact(OLD.block_results)
    expect(primary).toMatchObject({ kind: 'audio', label: 'Omni Reference Loader', blockIndex: 0 })
    expect(runOutputs(OLD)).toEqual([{ kind: 'audio', url: '/outputs/20261101_ava.wav' }])
    expect(mediaUrls('voice', [VOICE_REF])).toEqual(['/outputs/20261101_ava.wav'])
  })

  it('a voice output ranks with audio, below video and image', () => {
    const mixed = run([
      block(0, 'omniReferenceLoader', 'Loader', { voice: { kind: 'voice', value: VOICE_REF }, image: { kind: 'image', value: LOADER_REF } }),
    ])
    expect(findPrimaryArtifact(mixed.block_results)?.kind).toBe('image')
  })

  it('lists the old voice items as audio references, after the audio', () => {
    expect(runReferences(OLD)).toEqual([
      { kind: 'audio', url: '/outputs/song.mp3', label: 'song.mp3' },
      { kind: 'audio', url: '/outputs/20261101_ava.wav', label: 'Ava 李.wav' },
    ])
  })
})
