/**
 * The inverse of input resolution: which blocks read a given block's output.
 * Uses the same closest / all / custom rules as `resolveInputs`, so the two
 * are checked against each other here.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { PipelineProvider, usePipeline } from './pipeline-context'
import { PipelineTabsProvider } from './tabs-context'
import { PORT_IMAGE, registerBlockDef } from './registry'
import { selectedSourceIds } from './source-resolution'
import { walkBlocks } from './tree-utils'

beforeAll(() => {
  registerBlockDef({
    type: 'dc_src', label: 'Source', description: '', size: 'sm', canStart: true,
    inputs: [], outputs: [{ name: 'image', kind: PORT_IMAGE }], component: () => null,
  })
  registerBlockDef({
    type: 'dc_sink', label: 'Sink', description: '', size: 'sm', canStart: false,
    inputs: [{ name: 'image', kind: PORT_IMAGE, required: false }], outputs: [], component: () => null,
  })
})

let tab = 0
function setup(blocks: unknown[]) {
  const flowJson = JSON.stringify({ name: 't', version: 2, schema_version: 3, created_at: '', blocks })
  const tabId = `dc-${++tab}`
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PipelineTabsProvider>
      <PipelineProvider tabId={tabId} flowJson={flowJson}>{children}</PipelineProvider>
    </PipelineTabsProvider>
  )
  const { result } = renderHook(() => usePipeline(), { wrapper })
  const ids = [...walkBlocks(result.current.pipeline.blocks)].map((b) => b.id)
  return { api: () => result.current, ids }
}

const consumerIds = (api: ReturnType<typeof usePipeline>, id: string) =>
  api.getDownstreamConsumers(id, 'image').map((c) => c.blockId)

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

describe('selectedSourceIds', () => {
  const block = (extra: Record<string, unknown> = {}) => ({ id: 'x', type: 'dc_sink', ...extra })
  it('closest reads the last producer, or the explicit source', () => {
    expect(selectedSourceIds(block(), 'image', ['a', 'b'])).toEqual(['b'])
    expect(selectedSourceIds(block({ sources: { image: 'a' } }), 'image', ['a', 'b'])).toEqual(['a'])
    expect(selectedSourceIds(block(), 'image', [])).toEqual([])
  })
  it('all reads every producer in order; custom reads the selection', () => {
    expect(selectedSourceIds(block({ sourceModes: { image: 'all' } }), 'image', ['a', 'b'])).toEqual(['a', 'b'])
    expect(selectedSourceIds(block({ sourceModes: { image: 'custom' }, sourceSelections: { image: ['a'] } }), 'image', ['a', 'b']))
      .toEqual(['a'])
    expect(selectedSourceIds(block({ sourceModes: { image: 'custom' } }), 'image', ['a'])).toEqual([])
  })
})

describe('getDownstreamConsumers', () => {
  it('closest: only the nearest producer feeds the sink', () => {
    const { api, ids } = setup([{ type: 'dc_src' }, { type: 'dc_src' }, { type: 'dc_sink', label: 'My sink' }])
    expect(consumerIds(api(), ids[0])).toEqual([])
    expect(api().getDownstreamConsumers(ids[1], 'image')).toEqual([
      { blockId: ids[2], type: 'dc_sink', label: 'My sink', portName: 'image' },
    ])
    expect(api().getPortSources(ids[2], 'image').map((p) => p.blockId)).toEqual([ids[1]])
  })

  it('closest with an explicit source points at the chosen producer', () => {
    const { api, ids } = setup([{ type: 'dc_src' }, { type: 'dc_src' }, { type: 'dc_sink', sources: { image: 0 } }])
    expect(consumerIds(api(), ids[0])).toEqual([ids[2]])
    expect(consumerIds(api(), ids[1])).toEqual([])
  })

  it('all: every upstream producer feeds the sink', () => {
    const { api, ids } = setup([{ type: 'dc_src' }, { type: 'dc_src' }, { type: 'dc_sink', source_modes: { image: 'all' } }])
    expect(consumerIds(api(), ids[0])).toEqual([ids[2]])
    expect(consumerIds(api(), ids[1])).toEqual([ids[2]])
    expect(api().getPortSources(ids[2], 'image').map((p) => p.blockId)).toEqual([ids[0], ids[1]])
  })

  it('custom: only selected producers feed the sink', () => {
    const { api, ids } = setup([
      { type: 'dc_src' }, { type: 'dc_src' },
      { type: 'dc_sink', source_modes: { image: 'custom' }, source_selections: { image: [0] } },
    ])
    expect(consumerIds(api(), ids[0])).toEqual([ids[2]])
    expect(consumerIds(api(), ids[1])).toEqual([])
  })

  it('branches: a producer before a fork feeds sinks on the trunk and on each branch', () => {
    const { api, ids } = setup([
      { type: 'dc_src', branches: [[{ type: 'dc_sink', label: 'Branch sink' }]] },
      { type: 'dc_sink', label: 'Trunk sink' },
    ])
    // depth-first: 0 src, 1 branch sink, 2 trunk sink
    expect(consumerIds(api(), ids[0]).sort()).toEqual([ids[1], ids[2]].sort())
  })

  it('a producer on one branch does not feed the other branch', () => {
    const { api, ids } = setup([
      { type: 'dc_src', branches: [[{ type: 'dc_src' }, { type: 'dc_sink' }], [{ type: 'dc_sink' }]] },
    ])
    // 0 src, 1 branch-0 src, 2 branch-0 sink, 3 branch-1 sink
    expect(consumerIds(api(), ids[1])).toEqual([ids[2]])
    expect(consumerIds(api(), ids[0])).toEqual([ids[3]])
  })

  it('skips disabled sinks, sinks under a disabled fork, and disabled producers', () => {
    const { api, ids } = setup([
      { type: 'dc_src' },
      { type: 'dc_sink', disabled: true },
      { type: 'dc_src', disabled: true, branches: [[{ type: 'dc_sink', source_modes: { image: 'all' } }]] },
      { type: 'dc_sink', source_modes: { image: 'all' } },
    ])
    // 0 src, 1 disabled sink, 2 disabled fork, 3 sink under it, 4 trunk sink
    expect(consumerIds(api(), ids[0])).toEqual([ids[4]])
    expect(consumerIds(api(), ids[2])).toEqual([])
  })

  it('agrees with resolveInputs for every mode', () => {
    const { api, ids } = setup([
      { type: 'dc_src' }, { type: 'dc_src' },
      { type: 'dc_sink' },
      { type: 'dc_sink', source_modes: { image: 'all' } },
      { type: 'dc_sink', source_modes: { image: 'custom' }, source_selections: { image: [0] } },
    ])
    for (const sink of ids.slice(2)) {
      const sources = api().getPortSources(sink, 'image').map((p) => p.blockId)
      for (const src of ids.slice(0, 2)) {
        expect(consumerIds(api(), src).includes(sink)).toBe(sources.includes(src))
      }
    }
  })
})
