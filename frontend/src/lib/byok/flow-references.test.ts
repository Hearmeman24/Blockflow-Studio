import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SavedFlow } from '@/lib/pipeline/flow-io'
import { collectFlowReferences, countBrokenFlowReferences } from './flow-references'

const flow = (blocks: SavedFlow['blocks']): SavedFlow => ({ name: 'f', version: 2, schema_version: 5, created_at: '', blocks })

const characterConfig = {
  character_id: 'c1',
  selection: { image: ['i2', 'i1'], video: [], audio: ['a1'], voice: 'v1' },
  snapshot: {
    name: 'Mia',
    items: {
      i1: { kind: 'image', label: 'i1.png', local: '/outputs/characters/c1/i1.png' },
      i2: { kind: 'image', label: 'i2.png', local: '/outputs/characters/c1/i2.png' },
      a1: { kind: 'audio', label: 'a1.mp3', local: '/outputs/characters/c1/a1.mp3' },
      v1: { kind: 'voice', label: 'v1.wav', local: '/outputs/characters/c1/v1.wav' },
      notSelected: { kind: 'image', label: 'x.png', local: '/outputs/characters/c1/x.png' },
    },
  },
}

afterEach(() => vi.unstubAllGlobals())

describe('collectFlowReferences', () => {
  it("includes a Load Character block's selected snapshot items, in send order, in branches too", () => {
    const targets = collectFlowReferences([flow([
      { type: 'uploadImageToTmpfiles', config: { items: [{ id: 'a', label: 'a.png', local: '/outputs/a.png', status: 'ready' }] } },
      { type: 'textToImage', branches: [[{ type: 'loadCharacter', config: characterConfig }]] },
    ])])
    expect(targets).toEqual([
      { kind: 'image', local: '/outputs/a.png', url: undefined },
      { kind: 'image', local: '/outputs/characters/c1/i2.png' },
      { kind: 'image', local: '/outputs/characters/c1/i1.png' },
      { kind: 'audio', local: '/outputs/characters/c1/a1.mp3' },
      // A voice saved by an older version is read as audio, after the audio.
      { kind: 'audio', local: '/outputs/characters/c1/v1.wav' },
    ])
  })

  it('ignores a Load Character block with no or malformed config', () => {
    expect(collectFlowReferences([flow([
      { type: 'loadCharacter' },
      { type: 'loadCharacter', config: { selection: 'x', snapshot: [] } },
      { type: 'loadCharacter', config: { selection: { image: ['i1'] }, snapshot: { name: 'Mia', items: { i1: { kind: 'image', local: 'C:/x.png' } } } } },
    ])])).toEqual([])
  })

  it('counts broken character files in the import report', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      const { references } = JSON.parse(String(init?.body)) as { references: Array<{ local: string }> }
      return new Response(JSON.stringify({
        ok: true,
        results: references.map((r, index) => ({ index, status: r.local.includes('/i1.png') || r.local.includes('v1') ? 'missing_local' : 'ok', detail: '' })),
      }))
    }))
    expect(await countBrokenFlowReferences([flow([{ type: 'loadCharacter', config: characterConfig }])])).toBe(2)
  })
})
