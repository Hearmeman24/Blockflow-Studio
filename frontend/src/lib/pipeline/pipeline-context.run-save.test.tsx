/**
 * The run saved to history describes the pipeline that ran.
 *
 * `block_results` and `flow_snapshot` are both built from the blocks the run
 * started with, so they line up one to one whatever the user adds, removes or
 * edits while the run is in flight. Each block's settings are saved as they
 * were when that block started; a block that never started keeps its settings
 * from the start of the run. Keys a block lists in `resultConfigKeys` hold its
 * own result and are read when the run is saved.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { SWRConfig } from 'swr'

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/api', () => ({
  saveRun: vi.fn(() => Promise.resolve({ ok: true })),
  fetchFlow: vi.fn(),
  fetchFlows: vi.fn(() => Promise.resolve({ ok: true, flows: [] })),
  saveFlowToDisk: vi.fn(),
}))

import { saveRun } from '@/lib/api'
import { BlockCard } from '@/components/pipeline/block-card'
import type { RunEntry } from '@/lib/types'
import { BlockLayoutProvider } from './block-layout-context'
import { PipelineProvider, usePipeline } from './pipeline-context'
import { PORT_IMAGE, PORT_TEXT, PORT_VIDEO, registerBlockDef, type BlockComponentProps } from './registry'
import { PipelineTabsProvider } from './tabs-context'
import { walkBlocks } from './tree-utils'

/** Blocks waiting inside execute, by block id; calling the entry lets the block finish. */
const waiting = new Map<string, () => void>()

function generatedRef(blockId: string) {
  return { kind: 'image-ref', local: `/outputs/${blockId}.png`, meta: { job_id: `job-${blockId}`, provider: 'kie', model: 'm', cost: null } }
}

/** Stands in for a generation block: waits until released, then emits a generated image. */
function GenBlock({ blockId, setOutput, registerExecute }: BlockComponentProps) {
  useEffect(() => {
    registerExecute(async () => {
      await new Promise<void>((resolve) => waiting.set(blockId, resolve))
      waiting.delete(blockId)
      setOutput('image', generatedRef(blockId))
    })
  })
  return null
}

/** Stands in for the Video Viewer: fails when no video arrives. */
function VideoViewBlock({ registerExecute }: BlockComponentProps) {
  useEffect(() => {
    registerExecute(async (inputs) => {
      if (!inputs.video) throw new Error('No video input')
    })
  })
  return null
}

/** Stands in for the Prompt Writer: writes its result into its own settings while running. */
function WriterBlock({ blockId, setOutput, registerExecute }: BlockComponentProps) {
  useEffect(() => {
    registerExecute(async () => {
      await new Promise<void>((resolve) => waiting.set(blockId, resolve))
      waiting.delete(blockId)
      sessionStorage.setItem(`block_${blockId}_output`, JSON.stringify('written by this run'))
      setOutput('prompt', 'written by this run')
    })
  })
  return null
}

beforeAll(() => {
  registerBlockDef({
    type: 'rs_gen', label: 'Gen', description: '', size: 'sm', canStart: true,
    inputs: [], outputs: [{ name: 'image', kind: PORT_IMAGE }], configKeys: ['prompt'], component: GenBlock,
  })
  registerBlockDef({
    type: 'rs_video_view', label: 'Video View', description: '', size: 'sm', canStart: false,
    inputs: [{ name: 'video', kind: PORT_VIDEO, required: true }], outputs: [], configKeys: [], component: VideoViewBlock,
  })
  registerBlockDef({
    type: 'rs_view', label: 'View', description: '', size: 'sm', canStart: false,
    inputs: [{ name: 'image', kind: PORT_IMAGE, required: false }], outputs: [], configKeys: ['zoom'], component: () => null,
  })
  registerBlockDef({
    type: 'rs_writer', label: 'Writer', description: '', size: 'sm', canStart: true,
    inputs: [], outputs: [{ name: 'prompt', kind: PORT_TEXT }],
    configKeys: ['idea', 'output'], resultConfigKeys: ['output'], component: WriterBlock,
  })
})

const captured: { api: ReturnType<typeof usePipeline> | null } = { api: null }
function Canvas() {
  const api = usePipeline()
  useEffect(() => {
    captured.api = api
  })
  return <>{[...walkBlocks(api.pipeline.blocks)].map((block, i) => <BlockCard key={block.id} block={block} displayNumber={String(i + 1)} />)}</>
}

let tab = 0
function renderFlow(blocks: unknown[]): string[] {
  const flowJson = JSON.stringify({ name: 'rs', version: 1, schema_version: 6, created_at: '', blocks })
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PipelineTabsProvider>
        <PipelineProvider tabId={`rs-${++tab}`} flowJson={flowJson}>
          <BlockLayoutProvider><Canvas /></BlockLayoutProvider>
        </PipelineProvider>
      </PipelineTabsProvider>
    </SWRConfig>,
  )
  return [...walkBlocks(captured.api!.pipeline.blocks)].map((b) => b.id)
}

const api = () => captured.api!
const edit = (blockId: string, key: string, value: unknown) =>
  act(() => sessionStorage.setItem(`block_${blockId}_${key}`, JSON.stringify(value)))
const isWaiting = (blockId: string) => waitFor(() => expect(waiting.has(blockId)).toBe(true))
const release = (blockId: string) => act(async () => { waiting.get(blockId)!() })

/** Start a run without waiting for it; `done` settles when the run has ended. */
function startRun() {
  let done!: Promise<{ hadError: boolean }>
  act(() => { done = api().runPipeline() })
  return done
}

type SavedBlock = { type: string; config?: Record<string, unknown> }
function savedRun(): RunEntry & { flow_snapshot: { blocks: SavedBlock[] } } {
  const calls = vi.mocked(saveRun).mock.calls
  expect(calls).toHaveLength(1)
  return calls[0][0] as RunEntry & { flow_snapshot: { blocks: SavedBlock[] } }
}
const snapshotTypes = () => savedRun().flow_snapshot.blocks.map((b) => b.type)
const resultTypes = () => savedRun().block_results.map((b) => b.block_type)

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  waiting.clear()
  vi.mocked(saveRun).mockClear()
})
afterEach(() => vi.unstubAllGlobals())

describe('the saved run', () => {
  it('keeps the generated output when a later block fails, and is saved as partial', async () => {
    const [gen] = renderFlow([{ type: 'rs_gen', config: { prompt: 'a cat' } }, { type: 'rs_video_view' }])
    const done = startRun()
    await isWaiting(gen)
    await release(gen)
    await act(async () => { expect(await done).toEqual({ hadError: true }) })

    const run = savedRun()
    expect(run.status).toBe('partial')
    expect(run.block_results.map((b) => [b.block_index, b.block_type, b.status])).toEqual([
      [0, 'rs_gen', 'completed'], [1, 'rs_video_view', 'error'],
    ])
    expect(run.block_results[0].outputs.image).toEqual({ kind: 'image', value: generatedRef(gen) })
  })

  it('does not include a block added while the run was in flight', async () => {
    const [gen] = renderFlow([{ type: 'rs_gen', config: { prompt: 'a cat' } }, { type: 'rs_video_view' }])
    const done = startRun()
    await isWaiting(gen)
    act(() => { api().insertBlockAdjacent(gen, 'after', 'rs_view') })
    expect(api().pipeline.blocks.map((b) => b.type)).toEqual(['rs_gen', 'rs_view', 'rs_video_view'])
    await release(gen)
    await act(async () => { await done })

    expect(snapshotTypes()).toEqual(['rs_gen', 'rs_video_view'])
    expect(resultTypes()).toEqual(snapshotTypes())
    expect(savedRun().block_results.map((b) => b.block_index)).toEqual([0, 1])
  })

  it('still includes a block removed while the run was in flight, with its settings', async () => {
    const [gen, view] = renderFlow([{ type: 'rs_gen', config: { prompt: 'a cat' } }, { type: 'rs_view', config: { zoom: 2 } }])
    const done = startRun()
    await isWaiting(gen)
    act(() => { api().removeBlock(view) })
    expect(api().pipeline.blocks.map((b) => b.type)).toEqual(['rs_gen'])
    await release(gen)
    await act(async () => { await done })

    expect(snapshotTypes()).toEqual(['rs_gen', 'rs_view'])
    expect(resultTypes()).toEqual(snapshotTypes())
    expect(savedRun().flow_snapshot.blocks[1].config).toEqual({ zoom: 2 })
  })

  it('saves the settings a block started with, not an edit made while it was running', async () => {
    const [gen] = renderFlow([{ type: 'rs_gen', config: { prompt: 'the prompt that ran' } }])
    const done = startRun()
    await isWaiting(gen)
    edit(gen, 'prompt', 'edited for the next run')
    await release(gen)
    await act(async () => { await done })

    expect(savedRun().flow_snapshot.blocks[0].config).toEqual({ prompt: 'the prompt that ran' })
  })

  it('saves an edit made before a block started, and ignores one made after it finished', async () => {
    const [first, second] = renderFlow([
      { type: 'rs_gen', config: { prompt: 'first' } }, { type: 'rs_gen', config: { prompt: 'second' } },
    ])
    const done = startRun()
    await isWaiting(first)
    edit(second, 'prompt', 'second, edited before it ran')
    await release(first)
    await isWaiting(second)
    edit(first, 'prompt', 'first, edited after it ran')
    await release(second)
    await act(async () => { expect(await done).toEqual({ hadError: false }) })

    expect(savedRun().status).toBe('completed')
    expect(savedRun().flow_snapshot.blocks.map((b) => b.config)).toEqual([
      { prompt: 'first' }, { prompt: 'second, edited before it ran' },
    ])
  })

  it('keeps the run-start settings of a block that never started', async () => {
    const [gen, , never] = renderFlow([
      { type: 'rs_gen', config: { prompt: 'a cat' } }, { type: 'rs_video_view' }, { type: 'rs_gen', config: { prompt: 'never ran' } },
    ])
    const done = startRun()
    await isWaiting(gen)
    edit(never, 'prompt', 'edited mid-run')
    await release(gen)
    await act(async () => { await done })

    expect(savedRun().block_results.map((b) => b.status)).toEqual(['completed', 'error', 'idle'])
    expect(savedRun().flow_snapshot.blocks[2].config).toEqual({ prompt: 'never ran' })
  })

  it('saves a result the block wrote into its own settings during the run', async () => {
    const [writer] = renderFlow([{ type: 'rs_writer', config: { idea: 'a fox', output: 'the previous result' } }])
    const done = startRun()
    await isWaiting(writer)
    edit(writer, 'idea', 'edited for the next run')
    await release(writer)
    await act(async () => { await done })

    expect(savedRun().flow_snapshot.blocks[0].config).toEqual({ idea: 'a fox', output: 'written by this run' })
  })

  it('saves the flow with the current schema version and the run name', async () => {
    const [gen] = renderFlow([{ type: 'rs_gen', config: { prompt: 'a cat' } }])
    const done = startRun()
    await isWaiting(gen)
    await release(gen)
    await act(async () => { await done })

    expect(savedRun().flow_snapshot).toMatchObject({ name: 'Pipeline Run', schema_version: 6, version: 1 })
  })
})
