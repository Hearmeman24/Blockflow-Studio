import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { exportFlow, importFlow, importFlowWithReport, type SavedBlock } from './flow-io'
import { NEWER_SCHEMA_ERROR } from './flow-migrations'
import { LEGACY_BLOCKS } from './legacy-blocks'
import { registerBlockDef } from './registry'
import type { Pipeline } from './types'

beforeAll(() => {
  registerBlockDef({
    type: 'fio_src',
    label: 'Fio Source',
    description: '',
    size: 'sm',
    inputs: [],
    outputs: [{ name: 'image', kind: 'image' }],
    canStart: true,
    configKeys: ['prompt'],
    component: () => null,
  } as unknown as Parameters<typeof registerBlockDef>[0])
  registerBlockDef({
    type: 'fio_sink',
    label: 'Fio Sink',
    description: '',
    size: 'sm',
    inputs: [{ name: 'image', kind: 'image', required: false }],
    outputs: [],
    canStart: false,
    component: () => null,
  } as unknown as Parameters<typeof registerBlockDef>[0])
})

beforeEach(() => {
  sessionStorage.clear()
})

function importOk(input: unknown) {
  const result = importFlowWithReport(input)
  if (!result.ok) throw new Error(result.error)
  return result
}

describe('exportFlow', () => {
  it('always writes the current schema_version (6) and keeps the legacy version meaning', () => {
    const linear: Pipeline = { id: 'p', blocks: [{ id: 'a', type: 'fio_src' }] }
    const branched: Pipeline = {
      id: 'p',
      blocks: [{ id: 'a', type: 'fio_src', branches: [[{ id: 'b', type: 'fio_sink' }]] }],
    }
    expect(exportFlow(linear, 'L')).toMatchObject({ schema_version: 6, version: 1, name: 'L' })
    expect(exportFlow(branched, 'B')).toMatchObject({ schema_version: 6, version: 2 })
    expect(exportFlow({ id: 'p', blocks: [] }, 'E')).toMatchObject({ schema_version: 6, blocks: [] })
  })
})

describe('importFlowWithReport', () => {
  it('imports a schema-less v1 flow and writes its config to sessionStorage', () => {
    const result = importOk({
      name: 'Old',
      version: 1,
      created_at: 'x',
      blocks: [{ type: 'fio_src', config: { prompt: 'hello' } }, { type: 'fio_sink', sources: { image: 0 } }],
    })
    const [src, sink] = result.pipeline.blocks
    expect(src.type).toBe('fio_src')
    expect(sessionStorage.getItem(`block_${src.id}_prompt`)).toBe('"hello"')
    expect(sink.sources).toEqual({ image: src.id })
    expect(result.report).toEqual({ from_version: 1, to_version: 6, unsupported: [], warnings: [] })
  })

  it('imports a schema-less v2 flow with branches', () => {
    const result = importOk({
      version: 2,
      blocks: [{ type: 'fio_src', branches: [[{ type: 'fio_sink', sources: { image: 0 } }], []] }],
    })
    const root = result.pipeline.blocks[0]
    expect(root.branches).toHaveLength(2)
    expect(root.branches![0][0].sources).toEqual({ image: root.id })
    expect(root.branches![1]).toEqual([])
    expect(result.report.from_version).toBe(2)
  })

  it.each(Object.keys(LEGACY_BLOCKS))('keeps removed type %s as an unsupported block with full data', (type) => {
    const saved: SavedBlock = {
      type,
      label: `Old ${type}`,
      disabled: true,
      sources: { image: 0 },
      config: { prompt: 'keep me', workflow: { '3': { inputs: { seed: 7 } } }, list: [null, 1] },
    }
    const result = importOk({ version: 1, blocks: [{ type: 'fio_src' }, saved] })
    const block = result.pipeline.blocks[1]
    expect(block.type).toBe(type)
    expect(block.label).toBe(`Old ${type}`)
    expect(block.disabled).toBe(true)
    expect(block.sources).toEqual({ image: result.pipeline.blocks[0].id })
    expect(block.preserved).toEqual({ config: saved.config })
    // Config of an unsupported block is held on the block, not scattered into sessionStorage.
    expect(sessionStorage.getItem(`block_${block.id}_prompt`)).toBeNull()
    expect(result.report.unsupported).toEqual([
      { type, label: `Old ${type}`, reason: LEGACY_BLOCKS[type].reason },
    ])
  })

  it('round-trips unsupported block data byte-for-byte through import → export', () => {
    const unsupported: SavedBlock[] = [
      {
        type: 'comfyGen',
        label: 'My Gen',
        disabled: true,
        sources: { prompt: 0 },
        source_modes: { prompt: 'custom' },
        source_selections: { prompt: [0] },
        config: {
          workflow: { '3': { class_type: 'KSampler', inputs: { seed: 1, cfg: 7.5 } } },
          prompt: 'ünïcødé ✓ "quoted"\nnew line',
          nothing: null,
          deep: [[[{ a: [true, false] }]]],
        },
        branches: [[{ type: 'loraTrain', config: { trigger_word: 'zzz' }, future_field: { x: 1 } } as SavedBlock]],
      },
    ]
    const original = {
      name: 'RT',
      version: 2,
      schema_version: 3,
      created_at: '2026-01-01T00:00:00Z',
      blocks: [{ type: 'fio_src' }, ...unsupported],
    }
    const result = importOk(JSON.stringify(original))
    const exported = exportFlow(result.pipeline, 'RT')
    expect(JSON.stringify(exported.blocks.slice(1))).toBe(JSON.stringify(unsupported))
  })

  it('re-imports an exported unsupported block without growing warnings', () => {
    const first = importOk({ blocks: [{ type: 'mysteryBlock', config: { text: 'x' } }] })
    const second = importOk(exportFlow(first.pipeline, 'again'))
    expect(second.pipeline.blocks[0].preserved).toEqual({ config: { text: 'x' } })
    expect(second.report.warnings).toEqual([])
  })

  it('refuses a newer schema without writing anything', () => {
    const result = importFlowWithReport({
      schema_version: 7,
      blocks: [{ type: 'fio_src', config: { prompt: 'future' } }],
    })
    expect(result).toEqual({ ok: false, code: 'newer_schema', error: NEWER_SCHEMA_ERROR })
    expect(sessionStorage.length).toBe(0)
  })

  it.each([
    ['non-JSON', '{'],
    ['array', '[]'],
    ['missing blocks', '{"name":"x"}'],
    ['null', 'null'],
  ])('returns a recoverable error for %s input', (_name, input) => {
    const result = importFlowWithReport(input)
    expect(result.ok).toBe(false)
  })

  it('does not throw when sessionStorage rejects writes', () => {
    const original = sessionStorage.setItem
    sessionStorage.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    try {
      expect(() => importOk({ blocks: [{ type: 'fio_src', config: { prompt: 'x' } }] })).not.toThrow()
    } finally {
      sessionStorage.setItem = original
    }
  })
})

describe('importFlow (throwing wrapper)', () => {
  it('returns the pipeline for a valid flow', () => {
    expect(importFlow(JSON.stringify({ blocks: [{ type: 'fio_src' }] })).blocks).toHaveLength(1)
  })

  it('throws the recoverable error message for invalid input', () => {
    expect(() => importFlow('{"schema_version": 9, "blocks": []}')).toThrow(NEWER_SCHEMA_ERROR)
  })
})
