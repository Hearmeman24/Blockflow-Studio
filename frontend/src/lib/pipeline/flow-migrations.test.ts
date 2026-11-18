import { describe, it, expect } from 'vitest'
import {
  CURRENT_FLOW_SCHEMA_VERSION,
  FLOW_MIGRATIONS,
  MAX_FLOW_DEPTH,
  NEWER_SCHEMA_ERROR,
  migrateSavedFlow,
} from './flow-migrations'
import { LEGACY_BLOCKS, UNKNOWN_BLOCK_REASON } from './legacy-blocks'
import type { SavedFlow } from './flow-io'

const KNOWN = new Set(['src', 'sink', 'viewer'])
const isRegistered = (type: string) => KNOWN.has(type)
const migrate = (input: unknown) => migrateSavedFlow(input, { isRegistered })

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

function ok(result: ReturnType<typeof migrate>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.error}`)
  return result
}

const V1_FLOW = {
  name: 'Old linear',
  version: 1,
  created_at: '2025-01-01T00:00:00Z',
  blocks: [
    { type: 'src', label: 'Source', config: { prompt: 'a' } },
    { type: 'sink', sources: { image: 0 }, disabled: true },
  ],
}

const V2_FLOW = {
  name: 'Old branched',
  version: 2,
  created_at: '2025-06-01T00:00:00Z',
  blocks: [
    {
      type: 'src',
      branches: [
        [{ type: 'sink', sources: { image: 0 }, source_modes: { image: 'all' } }],
        [{ type: 'viewer', source_selections: { image: [0] }, source_modes: { image: 'custom' } }],
      ],
    },
    { type: 'sink' },
  ],
}

describe('schema versions', () => {
  it('current schema is 6 and the step list is ordered and contiguous', () => {
    expect(CURRENT_FLOW_SCHEMA_VERSION).toBe(6)
    expect(FLOW_MIGRATIONS.map((m) => [m.from, m.to])).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
    ])
  })

  it('treats a schema-less version 1 file as schema 1', () => {
    const result = ok(migrate(V1_FLOW))
    expect(result.report.from_version).toBe(1)
    expect(result.report.to_version).toBe(6)
    expect(result.flow.schema_version).toBe(6)
    expect(result.flow.blocks).toEqual(V1_FLOW.blocks)
    expect(result.report.unsupported).toEqual([])
    expect(result.report.warnings).toEqual([])
  })

  it('treats a schema-less version 2 file as schema 2 and keeps branches and connections', () => {
    const result = ok(migrate(V2_FLOW))
    expect(result.report.from_version).toBe(2)
    expect(result.flow.blocks).toEqual(V2_FLOW.blocks)
    expect(result.flow.name).toBe('Old branched')
    expect(result.flow.created_at).toBe('2025-06-01T00:00:00Z')
  })

  it('treats a file with no version at all as schema 1', () => {
    expect(ok(migrate({ blocks: [] })).report.from_version).toBe(1)
  })

  it('uses schema_version over the legacy version when both are present', () => {
    const result = ok(migrate({ ...V2_FLOW, version: 1, schema_version: 3 }))
    expect(result.report.from_version).toBe(3)
  })

  it('refuses a flow from a newer schema with a recoverable error', () => {
    const result = migrate({ ...V1_FLOW, schema_version: CURRENT_FLOW_SCHEMA_VERSION + 1 })
    expect(result).toEqual({ ok: false, code: 'newer_schema', error: NEWER_SCHEMA_ERROR })
    expect(NEWER_SCHEMA_ERROR).toContain('This flow was saved by a newer version of BlockFlow')
  })

  it.each([['3'], [2.5], [0], [-1], [null], [{}]])(
    'warns and falls back to the legacy version for an invalid schema_version %j',
    (schemaVersion) => {
      const result = ok(migrate({ ...V2_FLOW, schema_version: schemaVersion }))
      expect(result.report.from_version).toBe(2)
      expect(result.report.warnings.join(' ')).toMatch(/schema version/i)
    },
  )
})

describe('step 3 to 4: loader item lists', () => {
  const registered = (type: string) => ['videoLoader', 'uploadImageToTmpfiles', 'sink'].includes(type)
  const migrate4 = (blocks: unknown[]) => ok(migrateSavedFlow({ name: 'f', version: 2, schema_version: 3, blocks }, { isRegistered: registered }))

  it('turns the single-video config keys into an ordered item list', () => {
    const result = migrate4([{
      type: 'videoLoader',
      label: 'My clip',
      config: { local_url: '/outputs/20261101_clip.mp4', remote_url: 'https://tmpfiles.org/dl/1/clip.mp4', uploaded_fingerprint: '12:ab' },
    }])
    expect(result.flow.blocks[0]).toEqual({
      type: 'videoLoader',
      label: 'My clip',
      config: { items: [{ id: 'legacy-video-0', label: '20261101_clip.mp4', local: '/outputs/20261101_clip.mp4', url: 'https://tmpfiles.org/dl/1/clip.mp4', status: 'ready' }] },
    })
  })

  it('turns the image uploads map into items, in branches too, and keeps other config', () => {
    const result = migrate4([{
      type: 'sink',
      branches: [[{
        type: 'uploadImageToTmpfiles',
        config: { uploads_v2: { a: { local: '/outputs/a.png' }, b: { local: '/outputs/b.png', url: 'https://t/b.png' } }, other: 1 },
      }]],
    }])
    expect(result.flow.blocks[0].branches![0][0].config).toEqual({
      other: 1,
      items: [
        { id: 'legacy-image-0', label: 'a.png', local: '/outputs/a.png', status: 'ready' },
        { id: 'legacy-image-1', label: 'b.png', local: '/outputs/b.png', url: 'https://t/b.png', status: 'ready' },
      ],
    })
  })

  it('leaves loaders that already have items, other blocks and empty loaders as they are', () => {
    const items = [{ id: 'x', label: 'x.mp4', local: '/outputs/x.mp4', status: 'ready' }]
    const blocks = [
      { type: 'videoLoader', config: { items, local_url: '/outputs/old.mp4' } },
      { type: 'sink', config: { local_url: '/outputs/keep.mp4' } },
      { type: 'videoLoader' },
      { type: 'videoLoader', config: { local_url: '', remote_url: '' } },
    ]
    const result = migrate4(blocks)
    expect(result.flow.blocks[0].config).toEqual({ items, local_url: '/outputs/old.mp4' })
    expect(result.flow.blocks[1].config).toEqual({ local_url: '/outputs/keep.mp4' })
    expect(result.flow.blocks[2]).toEqual({ type: 'videoLoader' })
    expect(result.flow.blocks[3].config).toEqual({ items: [] })
  })

  it('migrates an old schema-1 flow all the way, so old flows still restore their video', () => {
    const result = ok(migrateSavedFlow({ version: 1, blocks: [{ type: 'videoLoader', config: { local_url: '/outputs/v.mp4' } }] }, { isRegistered: registered }))
    expect(result.flow.schema_version).toBe(6)
    expect(result.flow.blocks[0].config).toEqual({ items: [{ id: 'legacy-video-0', label: 'v.mp4', local: '/outputs/v.mp4', status: 'ready' }] })
  })
})

describe('step 4 to 5: references move from generation blocks into loaders', () => {
  const GEN = new Set(['imageToVideo', 'imageToImage', 'omniReferenceToVideo', 'uploadImageToTmpfiles', 'omniReferenceLoader', 'textToImage', 'imageViewer', 'videoLoader'])
  const outputs: Record<string, string[]> = {
    textToImage: ['image'], uploadImageToTmpfiles: ['image', 'text'], videoLoader: ['video'], imageToImage: ['image'],
    imageToVideo: ['video'], omniReferenceToVideo: ['video'], omniReferenceLoader: ['video', 'image', 'audio'],
  }
  const migrate5 = (blocks: unknown[]) =>
    ok(migrateSavedFlow({ name: 'f', version: 2, schema_version: 4, blocks }, { isRegistered: (t) => GEN.has(t), outputKinds: (t) => outputs[t] ?? [] }))
  const ref = (id: string, kind = 'image', extra: Record<string, unknown> = {}) => ({ id, kind, role: 'reference', local: `/outputs/${id}`, label: id, status: 'ready', ...extra })
  const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, local: `/outputs/${id}`, status: 'ready', ...extra })

  it('inserts an Image Loader holding the references, in order, directly upstream', () => {
    const result = migrate5([
      { type: 'imageToImage', label: 'Restyle', config: { prompt: 'p', model: 'm', references: [ref('b.png', 'image', { size_bytes: 9 }), ref('a.png')] } },
    ])
    expect(result.flow.blocks).toEqual([
      { type: 'uploadImageToTmpfiles', config: { items: [item('b.png', { size_bytes: 9 }), item('a.png')] } },
      { type: 'imageToImage', label: 'Restyle', config: { prompt: 'p', model: 'm' } },
    ])
    expect(result.report.warnings).toEqual(['Moved 2 references from "Restyle" into a new Image Loader before it.'])
  })

  it('keeps Omni references by kind in an Omni Reference Loader; voices become audio after the audio, without names', () => {
    const result = migrate5([{ type: 'omniReferenceToVideo', config: { prompt: 'Ava says hi @Ava', references: [
      ref('v.mp4', 'video'), ref('ava.mp3', 'voice', { name: 'Ava' }), ref('i.png'), ref('s.mp3', 'audio'), ref('j.png'),
    ] } }])
    expect(result.flow.blocks[0]).toEqual({ type: 'omniReferenceLoader', config: {
      video_items: [item('v.mp4')],
      image_items: [item('i.png'), item('j.png')],
      audio_items: [item('s.mp3'), item('ava.mp3')],
    } })
    expect(result.flow.blocks[1]).toEqual({ type: 'omniReferenceToVideo', config: { prompt: 'Ava says hi @Ava' } })
    expect(result.report.warnings).toEqual([
      'Moved 5 references from "Omni Reference to Video" into a new Omni Reference Loader before it.',
      'Voices are now audio: moved 1 voice clip into Audio in "Omni Reference Loader".',
      'Voice mentions in prompts (such as @Name) are not rewritten. Use the audio mention instead.',
    ])
  })

  it('renumbers sources across the tree, including branches and several generation blocks', () => {
    const result = migrate5([
      { type: 'textToImage' }, // 0
      { type: 'imageToVideo', config: { references: [ref('f.png')] }, branches: [[ // 1
        { type: 'imageViewer', sources: { image: 0 } }, // 2
        { type: 'imageToImage', config: { references: [ref('r.png')] } }, // 3
      ]] },
      { type: 'imageViewer', source_modes: { image: 'custom' }, source_selections: { image: [0, 3] } }, // 4
    ])
    const [t2i, loader1, i2v, viewer] = result.flow.blocks
    expect([t2i.type, loader1.type, i2v.type, viewer.type]).toEqual(['textToImage', 'uploadImageToTmpfiles', 'imageToVideo', 'imageViewer'])
    // new order: 0 t2i, 1 loader, 2 i2v, 3 viewer(branch), 4 loader(branch), 5 i2i(branch), 6 viewer
    const branch = i2v.branches![0]
    expect(branch.map((b) => b.type)).toEqual(['imageViewer', 'uploadImageToTmpfiles', 'imageToImage'])
    expect(branch[0].sources).toEqual({ image: 0 })
    expect(viewer.source_selections).toEqual({ image: [0, 5] })
    // i2v had the Text to Image upstream feeding its images: it keeps reading both, upstream first.
    expect(i2v.source_modes).toEqual({ image: 'custom' })
    expect(i2v.source_selections).toEqual({ image: [0, 1] })
    // The branch Image to Image read the closest image producer, the viewer? No: viewers output nothing,
    // so it read Text to Image (index 0); it keeps it and adds its loader.
    expect(branch[2].source_selections).toEqual({ image: [0, 4] })
  })

  it('a block with no upstream producer simply reads its new loader', () => {
    const result = migrate5([{ type: 'imageToVideo', config: { references: [ref('f.png')] } }])
    expect(result.flow.blocks[1]).toEqual({ type: 'imageToVideo', config: {} })
  })

  it('keeps an explicit source and appends the loader; all-mode needs no change', () => {
    const result = migrate5([
      { type: 'textToImage' }, { type: 'textToImage' },
      { type: 'imageToImage', sources: { image: 0 }, config: { references: [ref('x.png')] } },
      { type: 'imageToImage', source_modes: { image: 'all' }, config: { references: [ref('y.png')] } },
    ])
    const blocks = result.flow.blocks
    expect(blocks.map((b) => b.type)).toEqual(['textToImage', 'textToImage', 'uploadImageToTmpfiles', 'imageToImage', 'uploadImageToTmpfiles', 'imageToImage'])
    expect(blocks[3].sources).toBeUndefined()
    expect(blocks[3].source_modes).toEqual({ image: 'custom' })
    expect(blocks[3].source_selections).toEqual({ image: [0, 2] })
    expect(blocks[5].source_modes).toEqual({ image: 'all' })
    expect(blocks[5].source_selections).toBeUndefined()
  })

  it('disables the new loader of a disabled block, and leaves blocks without references alone', () => {
    const result = migrate5([
      { type: 'imageToImage', disabled: true, config: { references: [ref('x.png')] } },
      { type: 'imageToImage', config: { prompt: 'keep', references: [] } },
      { type: 'textToImage', config: { references: [ref('odd.png')] } },
    ])
    expect(result.flow.blocks.map((b) => [b.type, b.disabled ?? false])).toEqual([
      ['uploadImageToTmpfiles', true], ['imageToImage', true], ['imageToImage', false], ['textToImage', false],
    ])
    expect(result.flow.blocks[2].config).toEqual({ prompt: 'keep' })
    // A text-only block never had a reference list; unknown keys are not touched.
    expect(result.flow.blocks[3].config).toEqual({ references: [ref('odd.png')] })
  })

  it('is idempotent and never loses a reference', () => {
    const first = migrate5([{ type: 'omniReferenceToVideo', config: { references: [ref('a.png'), ref('b.mp4', 'video')] } }])
    const again = ok(migrateSavedFlow(first.flow, { isRegistered: (t) => GEN.has(t), outputKinds: (t) => outputs[t] ?? [] }))
    expect(again.flow).toEqual(first.flow)
    const config = first.flow.blocks[0].config as Record<string, unknown[]>
    expect(config.image_items.length + config.video_items.length).toBe(2)
  })
})

describe('migration steps', () => {
  it.each(FLOW_MIGRATIONS.map((m) => [m.from, m] as const))(
    'step from %i is pure (does not mutate its input) and idempotent',
    (_from, step) => {
      const input = deepFreeze(structuredClone({ ...V2_FLOW, schema_version: step.from }) as unknown as SavedFlow)
      const once = step.migrate(input)
      expect(once.schema_version).toBe(step.to)
      expect(once.blocks).toEqual(V2_FLOW.blocks)
      expect(step.migrate(once)).toEqual(once)
    },
  )

  it('the full pipeline does not mutate the caller’s object', () => {
    const input = deepFreeze(structuredClone(V2_FLOW))
    expect(() => migrate(input)).not.toThrow()
    expect(input).toEqual(V2_FLOW)
  })

  it('is idempotent: migrating a migrated flow changes nothing', () => {
    const first = ok(migrate({ ...V2_FLOW, blocks: [...V2_FLOW.blocks, { type: 'comfyGen', config: { a: 1 } }] }))
    const second = ok(migrate(first.flow))
    expect(second.flow).toEqual(first.flow)
    expect(second.report.from_version).toBe(6)
    expect(second.report.unsupported).toEqual(first.report.unsupported)
  })

  it('never drops blocks, labels, disabled flags, config, connections or branches', () => {
    const flow = {
      version: 2,
      blocks: [
        { type: 'comfyGen', label: 'Gen', disabled: true, config: { workflow: { a: [1, { b: null }] } } },
        {
          type: 'src',
          sources: { prompt: 0 },
          source_modes: { prompt: 'closest' },
          source_selections: { image: [0] },
          branches: [[{ type: 'loraTrain', label: 'Train', config: { trigger_word: 'zzz' } }]],
        },
      ],
    }
    const result = ok(migrate(flow))
    expect(result.flow.blocks).toEqual(flow.blocks)
  })
})

describe('unsupported and removed block types', () => {
  it.each(Object.entries(LEGACY_BLOCKS))('%s is reported with its legacy label and reason', (type, info) => {
    const config = { prompt: `prompt for ${type}`, nested: { list: [1, 'two', null] } }
    const result = ok(migrate({ version: 1, blocks: [{ type, config }] }))
    expect(result.flow.blocks).toEqual([{ type, config }])
    expect(result.report.unsupported).toEqual([{ type, label: info.label, reason: info.reason }])
  })

  it('reports unknown types with a generic reason and the saved label', () => {
    const result = ok(migrate({ blocks: [{ type: 'mysteryBlock', label: 'Mine' }] }))
    expect(result.report.unsupported).toEqual([{ type: 'mysteryBlock', label: 'Mine', reason: UNKNOWN_BLOCK_REASON }])
  })

  it('finds unsupported blocks inside branches', () => {
    const result = ok(migrate({ version: 2, blocks: [{ type: 'src', branches: [[{ type: 'upscale' }]] }] }))
    expect(result.report.unsupported.map((u) => u.type)).toEqual(['upscale'])
  })

  it('keeps unknown extra fields on blocks and warns only for supported blocks', () => {
    const result = ok(
      migrate({
        blocks: [
          { type: 'comfyGen', future: { a: 1 } },
          { type: 'src', future: true },
        ],
      }),
    )
    expect(result.flow.blocks[0]).toEqual({ type: 'comfyGen', future: { a: 1 } })
    expect(result.report.warnings).toEqual(['Ignored unknown fields on block 2 ("src"): future.'])
  })
})

describe('malformed input never throws', () => {
  it.each([
    ['non-JSON text', '{not json'],
    ['JSON array', '[1,2]'],
    ['JSON null', 'null'],
    ['JSON number', '42'],
    ['JSON string', '"flow"'],
    ['an array value', []],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
  ])('%s → recoverable invalid error', (_name, input) => {
    const result = migrate(input)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('invalid')
      expect(result.error.length).toBeGreaterThan(0)
    }
  })

  it.each([
    ['missing blocks', {}],
    ['blocks is an object', { blocks: { 0: { type: 'src' } } }],
    ['blocks is a string', { blocks: 'src' }],
  ])('%s → invalid error', (_name, input) => {
    expect(migrate(input)).toMatchObject({ ok: false, code: 'invalid', error: 'Invalid flow file: missing blocks array' })
  })

  it('empty blocks imports as an empty flow with a warning', () => {
    const result = ok(migrate({ blocks: [] }))
    expect(result.flow.blocks).toEqual([])
    expect(result.report.warnings).toEqual(['This flow has no blocks.'])
  })

  it('skips entries that are not blocks and remaps source indices around them', () => {
    const result = ok(
      migrate({
        blocks: [
          'garbage',
          { type: 'src' },
          { label: 'no type' },
          null,
          { type: 'sink', sources: { image: 1 }, source_selections: { image: [1, 2] } },
        ],
      }),
    )
    expect(result.flow.blocks).toEqual([
      { type: 'src' },
      { type: 'sink', sources: { image: 0 } , source_selections: { image: [0] } },
    ])
    expect(result.report.warnings).toEqual(expect.arrayContaining([
      'Skipped entry 1: it is not a block.',
      'Skipped entry 3: it has no block type.',
      'Skipped entry 4: it is not a block.',
    ]))
  })

  it('drops non-array branches and non-array branch entries with warnings', () => {
    const result = ok(
      migrate({
        blocks: [
          { type: 'src', branches: 'nope' },
          { type: 'src', branches: [[{ type: 'sink' }], { type: 'sink' }, null] },
        ],
      }),
    )
    expect(result.flow.blocks).toEqual([
      { type: 'src' },
      { type: 'src', branches: [[{ type: 'sink' }]] },
    ])
    expect(result.report.warnings.filter((w) => /branch/i.test(w))).toHaveLength(3)
  })

  it('drops self, forward (cyclic) and out-of-range source indices', () => {
    const result = ok(
      migrate({
        blocks: [
          { type: 'src', sources: { image: 0 } },
          { type: 'sink', sources: { image: 5, video: 1, text: 0, bad: 'x', neg: -1, frac: 0.5 } },
          { type: 'sink', sources: { image: 1 }, source_selections: { image: [0, 2, 99, 'a'] } },
        ],
      }),
    )
    expect(result.flow.blocks).toEqual([
      { type: 'src' },
      { type: 'sink', sources: { text: 0 } },
      { type: 'sink', sources: { image: 1 }, source_selections: { image: [0] } },
    ])
    expect(result.report.warnings.length).toBeGreaterThanOrEqual(7)
  })

  it('coerces wrong field types with warnings instead of throwing', () => {
    const result = ok(
      migrate({
        name: 42,
        created_at: { when: 'now' },
        blocks: [
          {
            type: 'src',
            label: 12,
            disabled: 'yes',
            sources: [0],
            source_modes: { image: 'sometimes', video: 'all' },
            source_selections: 'all',
            config: 'prompt',
          },
        ],
      }),
    )
    expect(result.flow.name).toBe('')
    expect(result.flow.created_at).toBe('')
    expect(result.flow.blocks).toEqual([{ type: 'src', source_modes: { video: 'all' } }])
    expect(result.report.warnings.length).toBeGreaterThanOrEqual(6)
  })

  it('ignores unknown top-level fields', () => {
    const result = ok(migrate({ blocks: [], extra: { anything: true }, version: 'x' }))
    expect(result.flow).toEqual({ name: '', version: 1, schema_version: 6, created_at: '', blocks: [] })
  })

  it('refuses absurdly deep branch nesting instead of overflowing the stack', () => {
    let chain: unknown[] = [{ type: 'src' }]
    for (let i = 0; i < MAX_FLOW_DEPTH + 5; i++) chain = [{ type: 'src', branches: [chain] }]
    expect(migrate({ blocks: chain })).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('accepts a JSON string and an object identically', () => {
    expect(migrate(JSON.stringify(V2_FLOW))).toEqual(migrate(V2_FLOW))
  })

  it('handles cyclic object input without throwing', () => {
    const cyclic: Record<string, unknown> = { blocks: [] }
    cyclic.self = cyclic
    expect(migrate(cyclic)).toMatchObject({ ok: false, code: 'invalid' })
  })
})
