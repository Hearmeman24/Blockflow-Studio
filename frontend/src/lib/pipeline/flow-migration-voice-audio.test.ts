/**
 * Flow schema 5 to 6: voice is audio. The Omni Reference Loader's voice list
 * and the Load Character block's voice selection move into Audio, after the
 * audio; a block whose voice input read a producer its audio input would not
 * read now reads it as audio; prompts are never rewritten.
 */
import { describe, expect, it } from 'vitest'
import '@/components/pipeline/custom_blocks/_register'
import { importFlowWithReport, exportFlow, type SavedBlock, type SavedFlow } from './flow-io'
import { CURRENT_FLOW_SCHEMA_VERSION, FLOW_MIGRATIONS, NEWER_SCHEMA_ERROR, migrateSavedFlow } from './flow-migrations'

const REGISTERED = new Set(['omniReferenceLoader', 'loadCharacter', 'omniReferenceToVideo', 'audioViewer', 'textToImage', 'imageToVideo'])
/** Output kinds as the registry now reports them: no block outputs voice. */
const OUTPUTS: Record<string, string[]> = {
  omniReferenceLoader: ['video', 'image', 'audio'],
  loadCharacter: ['image', 'video', 'audio'],
  omniReferenceToVideo: ['video'],
  audioViewer: ['audio'],
  textToImage: ['image'],
  imageToVideo: ['video'],
}
const options = { isRegistered: (t: string) => REGISTERED.has(t), outputKinds: (t: string) => OUTPUTS[t] ?? [] }

function migrate6(blocks: unknown[], schema = 5) {
  const result = migrateSavedFlow({ name: 'f', version: 2, schema_version: schema, created_at: '', blocks }, options)
  if (!result.ok) throw new Error(result.error)
  return result
}

const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, local: `/outputs/${id}`, status: 'ready', ...extra })
const NOTE = 'Voice mentions in prompts (such as @Name) are not rewritten. Use the audio mention instead.'
const PROMPT = 'Ava says "hi" @Ava, then <Audio 1> plays — Zoë 李 ✨\n  @sound_1  '

describe('step 5 to 6 is registered', () => {
  it('is the last step and the current schema is 6', () => {
    expect(CURRENT_FLOW_SCHEMA_VERSION).toBe(6)
    expect(FLOW_MIGRATIONS.at(-1)).toMatchObject({ from: 5, to: 6 })
  })
})

describe('Omni Reference Loader', () => {
  it('appends the voice items after the audio items, drops their names and the voice key', () => {
    const result = migrate6([{
      type: 'omniReferenceLoader',
      config: {
        video_items: [item('v.mp4')],
        audio_items: [item('song.mp3'), item('rain.mp3')],
        voice_items: [item('ava.mp3', { name: 'Ava' }), item('Zoë 李.wav', { name: 'Zo', duration_s: 2.5 })],
      },
    }])
    expect(result.flow.blocks[0]).toEqual({
      type: 'omniReferenceLoader',
      config: {
        video_items: [item('v.mp4')],
        audio_items: [item('song.mp3'), item('rain.mp3'), item('ava.mp3'), item('Zoë 李.wav', { duration_s: 2.5 })],
      },
    })
    expect(result.report.warnings).toEqual([
      'Voices are now audio: moved 2 voice clips into Audio in "Omni Reference Loader".',
      NOTE,
    ])
  })

  it('names the block by its label, says "clip" for one, and creates the audio list when there was none', () => {
    const result = migrate6([{ type: 'omniReferenceLoader', label: 'Cast 李', config: { voice_items: [item('ava.mp3', { name: 'Ava' })] } }])
    expect(result.flow.blocks[0].config).toEqual({ audio_items: [item('ava.mp3')] })
    expect(result.report.warnings).toEqual(['Voices are now audio: moved 1 voice clip into Audio in "Cast 李".', NOTE])
  })

  it('removes an empty or malformed voice list without a message; keeps an item already in Audio once', () => {
    const result = migrate6([
      { type: 'omniReferenceLoader', config: { audio_items: [item('a.mp3')], voice_items: [] } },
      { type: 'omniReferenceLoader', config: { audio_items: [item('a.mp3')], voice_items: 'junk' } },
      { type: 'omniReferenceLoader', config: { audio_items: [item('a.mp3')], voice_items: [item('a.mp3', { name: 'A' })] } },
    ])
    for (const block of result.flow.blocks) expect(block.config).toEqual({ audio_items: [item('a.mp3')] })
    expect(result.report.warnings).toEqual([])
  })

  it('an audio list it cannot read (it held nothing usable) is replaced by the voice clips, so no clip is lost', () => {
    const result = migrate6([{ type: 'omniReferenceLoader', config: { audio_items: 'junk', voice_items: [item('v.mp3')] } }])
    expect(result.flow.blocks[0].config).toEqual({ audio_items: [item('v.mp3')] })
  })

  it('migrates disabled loaders and loaders in branches', () => {
    const result = migrate6([{
      type: 'textToImage',
      branches: [[{ type: 'omniReferenceLoader', disabled: true, config: { voice_items: [item('b.mp3')] } }]],
    }])
    const loader = result.flow.blocks[0].branches![0][0]
    expect(loader).toEqual({ type: 'omniReferenceLoader', disabled: true, config: { audio_items: [item('b.mp3')] } })
  })
})

describe('Load Character', () => {
  const snapshot = {
    name: 'Mia',
    items: {
      a1: { kind: 'audio', label: 'a1.mp3', local: '/outputs/characters/c1/a1.mp3' },
      v1: { kind: 'voice', label: 'Mia 李.wav', local: '/outputs/characters/c1/v1.wav', duration_s: 3 },
      i1: { kind: 'image', label: 'i1.png', local: '/outputs/characters/c1/i1.png' },
    },
  }

  it('appends the selected voice after the audio, removes selection.voice and makes voice snapshot items audio', () => {
    const result = migrate6([{
      type: 'loadCharacter',
      config: { character_id: 'c1', selection: { image: ['i1'], video: [], audio: ['a1'], voice: 'v1' }, snapshot },
    }])
    expect(result.flow.blocks[0].config).toEqual({
      character_id: 'c1',
      selection: { image: ['i1'], video: [], audio: ['a1', 'v1'] },
      snapshot: { ...snapshot, items: { ...snapshot.items, v1: { ...snapshot.items.v1, kind: 'audio' } } },
    })
    expect(result.report.warnings).toEqual(['Voices are now audio: moved 1 voice clip into Audio in "Load Character".', NOTE])
  })

  it('a null voice is only removed; a selection without audio gets one', () => {
    const result = migrate6([
      { type: 'loadCharacter', config: { selection: { image: [], video: [], audio: ['a1'], voice: null } } },
      { type: 'loadCharacter', label: 'Zoë', config: { selection: { image: [], video: [], voice: 'v1' } } },
    ])
    expect(result.flow.blocks[0].config).toEqual({ selection: { image: [], video: [], audio: ['a1'] } })
    expect(result.flow.blocks[1].config).toEqual({ selection: { image: [], video: [], audio: ['v1'] } })
    expect(result.report.warnings).toEqual(['Voices are now audio: moved 1 voice clip into Audio in "Zoë".', NOTE])
  })

  it('leaves malformed config alone', () => {
    const result = migrate6([{ type: 'loadCharacter', config: { selection: 'junk', snapshot: 7 } }])
    expect(result.flow.blocks[0].config).toEqual({ selection: 'junk', snapshot: 7 })
    expect(result.report.warnings).toEqual([])
  })
})

describe('references saved inside generation blocks', () => {
  it('turns voice references into audio references without a name', () => {
    const result = migrate6([{
      type: 'omniReferenceToVideo',
      config: { prompt: PROMPT, references: [{ id: 'v', kind: 'voice', role: 'reference', name: 'Ava', local: '/outputs/v.mp3' }, { id: 'i', kind: 'image', role: 'reference' }] },
    }])
    expect(result.flow.blocks[0].config).toEqual({
      prompt: PROMPT,
      references: [{ id: 'v', kind: 'audio', role: 'reference', local: '/outputs/v.mp3' }, { id: 'i', kind: 'image', role: 'reference' }],
    })
    expect(result.report.warnings).toEqual(['Voices are now audio: moved 1 voice clip into Audio in "Omni Reference to Video".', NOTE])
  })
})

describe('sources: the voice port folds into the audio port', () => {
  const loader = (voices = [item('v.mp3')]) => ({ type: 'omniReferenceLoader', config: { audio_items: [item('a.mp3')], voice_items: voices } })
  const character = { type: 'loadCharacter', config: { selection: { image: [], video: [], audio: [], voice: 'v1' } } }
  const gen = (extra: Partial<SavedBlock> = {}) => ({ type: 'omniReferenceToVideo', config: { prompt: PROMPT }, ...extra })

  it('closest on both ports reading the same block: only the voice entries go', () => {
    const result = migrate6([loader(), gen({ source_modes: { voice: 'closest', audio: 'closest' } })])
    expect(result.flow.blocks[1]).toEqual({ type: 'omniReferenceToVideo', source_modes: { audio: 'closest' }, config: { prompt: PROMPT } })
  })

  it('closest: voice read a loader the audio input did not (an audio block in between) — audio now reads both, upstream first', () => {
    const result = migrate6([loader(), { type: 'audioViewer' }, gen()])
    expect(result.flow.blocks[2]).toEqual({
      type: 'omniReferenceToVideo',
      source_modes: { audio: 'custom' },
      source_selections: { audio: [0, 1] },
      config: { prompt: PROMPT },
    })
    expect(result.report.warnings).toContain('Voices are now audio: the audio input of "Omni Reference to Video" now also reads what its voice input read.')
  })

  it('custom on the voice port: its selection joins the audio port', () => {
    const result = migrate6([
      loader(), character, { type: 'audioViewer' },
      gen({ label: 'Scene 李', source_modes: { voice: 'custom', audio: 'closest' }, source_selections: { voice: [0, 1] } }),
    ])
    expect(result.flow.blocks[3]).toEqual({
      type: 'omniReferenceToVideo',
      label: 'Scene 李',
      source_modes: { audio: 'custom' },
      source_selections: { audio: [0, 1, 2] },
      config: { prompt: PROMPT },
    })
    expect(result.report.warnings).toContain('Voices are now audio: the audio input of "Scene 李" now also reads what its voice input read.')
  })

  it('all on the voice port: every voice producer joins a custom audio selection', () => {
    const result = migrate6([
      loader(), character, { type: 'audioViewer' },
      gen({ source_modes: { voice: 'all', audio: 'custom' }, source_selections: { audio: [2] } }),
    ])
    expect(result.flow.blocks[3].source_modes).toEqual({ audio: 'custom' })
    expect(result.flow.blocks[3].source_selections).toEqual({ audio: [0, 1, 2] })
  })

  it('all on the audio port already reads every voice producer: unchanged', () => {
    const result = migrate6([loader(), character, gen({ source_modes: { voice: 'custom', audio: 'all' }, source_selections: { voice: [0] } })])
    expect(result.flow.blocks[2].source_modes).toEqual({ audio: 'all' })
    expect(result.flow.blocks[2].source_selections).toBeUndefined()
  })

  it('an explicit voice source joins; the explicit audio source is kept in the selection', () => {
    const result = migrate6([loader(), character, gen({ sources: { voice: 0, audio: 1 } })])
    expect(result.flow.blocks[2]).toMatchObject({ source_modes: { audio: 'custom' }, source_selections: { audio: [0, 1] } })
    expect(result.flow.blocks[2].sources).toBeUndefined()
  })

  it('closest skips disabled producers, as the runner does', () => {
    const result = migrate6([loader(), { ...character, disabled: true }, { type: 'audioViewer' }, gen()])
    expect(result.flow.blocks[3].source_selections).toEqual({ audio: [0, 2] })
  })

  it('works in branches: ancestors include the parent chain', () => {
    const result = migrate6([loader(), { type: 'audioViewer', branches: [[gen({ disabled: true })]] }])
    const branchGen = result.flow.blocks[1].branches![0][0]
    expect(branchGen).toMatchObject({ disabled: true, source_modes: { audio: 'custom' }, source_selections: { audio: [0, 1] } })
  })

  it('an empty voice selection reads nothing and changes nothing', () => {
    const result = migrate6([loader(), { type: 'audioViewer' }, gen({ source_modes: { voice: 'custom' }, source_selections: { voice: [] } })])
    expect(result.flow.blocks[2]).toEqual({ type: 'omniReferenceToVideo', config: { prompt: PROMPT } })
  })
})

describe('the whole flow', () => {
  const flow = () => [
    { type: 'omniReferenceLoader', config: { audio_items: [item('a.mp3')], voice_items: [item('v1.mp3', { name: 'Ava' }), item('v2.mp3', { name: 'Bo' })] } },
    { type: 'loadCharacter', config: { selection: { image: [], video: [], audio: [], voice: 'c1' } } },
    { type: 'omniReferenceToVideo', config: { prompt: PROMPT, provider: 'kie', model: 'kling-4.0' } },
  ]

  it('one message per block and one flow-level note; prompts are byte-identical', () => {
    const result = migrate6(flow())
    expect(result.report.warnings).toEqual([
      'Voices are now audio: moved 2 voice clips into Audio in "Omni Reference Loader".',
      'Voices are now audio: moved 1 voice clip into Audio in "Load Character".',
      NOTE,
    ])
    expect(result.flow.blocks[2].config!.prompt).toBe(PROMPT)
    expect(JSON.stringify(result.flow)).not.toMatch(/"voice/)
  })

  it('never mutates its input and is idempotent; a flow already at 6 is untouched', () => {
    const input = flow()
    const frozen = JSON.stringify(input)
    const first = migrate6(input)
    expect(JSON.stringify(input)).toBe(frozen)
    const again = migrateSavedFlow(first.flow, options)
    if (!again.ok) throw new Error(again.error)
    expect(again.flow).toEqual(first.flow)
    expect(again.report.warnings).toEqual([])
    // Version 6 data is never rewritten, even if it looks like version 5.
    const at6 = migrate6(flow(), 6)
    expect(at6.flow.blocks).toEqual(flow())
    expect(at6.report.warnings).toEqual([])
  })

  it('a newer schema is still refused', () => {
    expect(migrateSavedFlow({ schema_version: 7, blocks: [] }, options)).toEqual({ ok: false, code: 'newer_schema', error: NEWER_SCHEMA_ERROR })
  })

  it('round trip through flow-io: import writes audio (no voice key) to the session, export writes 6 and no voice', () => {
    sessionStorage.clear()
    const outcome = importFlowWithReport({ name: 'old', version: 1, schema_version: 5, created_at: '', blocks: flow() })
    if (!outcome.ok) throw new Error(outcome.error)
    const [loaderBlock, characterBlock] = outcome.pipeline.blocks
    expect(JSON.parse(sessionStorage.getItem(`block_${loaderBlock.id}_audio_items`)!).map((i: { id: string }) => i.id)).toEqual(['a.mp3', 'v1.mp3', 'v2.mp3'])
    expect(sessionStorage.getItem(`block_${loaderBlock.id}_voice_items`)).toBeNull()
    expect(JSON.parse(sessionStorage.getItem(`block_${characterBlock.id}_selection`)!)).toEqual({ image: [], video: [], audio: ['c1'] })
    expect(outcome.report.warnings).toContain(NOTE)
    const exported: SavedFlow = exportFlow(outcome.pipeline, 'again')
    expect(exported.schema_version).toBe(6)
    expect(JSON.stringify(exported)).not.toMatch(/voice/i)
    expect(exported.blocks[2].config!.prompt).toBe(PROMPT)
  })
})
