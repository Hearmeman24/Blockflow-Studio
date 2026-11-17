/**
 * The run saved to history describes the pipeline that ran.
 *
 * `block_results` and `flow_snapshot` are both built from the blocks the run
 * started with, so they line up one to one whatever the user adds, removes or
 * edits while the run is in flight. Each block's settings are saved as they
 * were when that block started; a block that never started keeps its settings
 * from the start of the run. Keys a block lists in `resultConfigKeys` hold its
 * own result and are read when the run is saved.
 *
 * A cancelled run is saved only when a block finished a generation in that
 * run, as `partial`, and never holds a block result with status `running`.
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

/** A generation block whose every call emits a new image, so repeated outputs can be told apart. */
const genCalls = new Map<string, number>()
function numberedRef(blockId: string, n: number) {
  return { kind: 'image-ref', local: `/outputs/${blockId}-${n}.png`, meta: { job_id: `job-${blockId}-${n}`, provider: 'kie', model: 'm', cost: null } }
}
function NumberedGenBlock({ blockId, setOutput, registerExecute }: BlockComponentProps) {
  useEffect(() => {
    registerExecute(async () => {
      await new Promise<void>((resolve) => waiting.set(blockId, resolve))
      waiting.delete(blockId)
      const n = (genCalls.get(blockId) ?? 0) + 1
      genCalls.set(blockId, n)
      setOutput('image', numberedRef(blockId, n))
    })
  })
  return null
}

/** Stands in for a loader: emits an image no generation job made. */
function PlainImageBlock({ blockId, setOutput, registerExecute }: BlockComponentProps) {
  useEffect(() => {
    registerExecute(async () => {
      setOutput('image', { kind: 'image-ref', local: `/outputs/${blockId}.png` })
    })
  })
  return null
}

/** An iterator: the rest of the chain runs once per item. */
function IterBlock({ setOutput, registerExecute }: BlockComponentProps) {
  useEffect(() => {
    registerExecute(async () => {
      setOutput('items', ['a', 'b', 'c'])
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
  registerBlockDef({
    type: 'rs_gen_n', label: 'Numbered Gen', description: '', size: 'sm', canStart: true,
    inputs: [], outputs: [{ name: 'image', kind: PORT_IMAGE }], configKeys: [], component: NumberedGenBlock,
  })
  registerBlockDef({
    type: 'rs_plain', label: 'Plain Image', description: '', size: 'sm', canStart: true,
    inputs: [], outputs: [{ name: 'image', kind: PORT_IMAGE }], configKeys: [], component: PlainImageBlock,
  })
  registerBlockDef({
    type: 'rs_iter', label: 'Iter', description: '', size: 'sm', canStart: true, iterator: true,
    inputs: [], outputs: [{ name: 'items', kind: PORT_TEXT }], configKeys: [], component: IterBlock,
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
function startRun(opts?: { continueFromExisting?: boolean }) {
  let done!: Promise<{ hadError: boolean }>
  act(() => { done = api().runPipeline(opts) })
  return done
}

/** Cancel the run in flight and wait for it to end. Blocks left waiting never finish. */
async function cancelRun(done: Promise<{ hadError: boolean }>) {
  let result!: { hadError: boolean }
  await act(async () => {
    api().cancelPipeline()
    result = await done
  })
  waiting.clear()
  return result
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
  genCalls.clear()
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

describe('a cancelled run', () => {
  const statuses = () => savedRun().block_results.map((b) => b.status)

  it('is not saved when it is cancelled during the first block', async () => {
    const [gen] = renderFlow([{ type: 'rs_gen', config: { prompt: 'a cat' } }, { type: 'rs_view' }])
    const done = startRun()
    await isWaiting(gen)
    expect(await cancelRun(done)).toEqual({ hadError: false })

    expect(saveRun).not.toHaveBeenCalled()
  })

  it('is saved as partial, with the finished generation, when cancelled after a generation finished', async () => {
    const [first, second] = renderFlow([
      { type: 'rs_gen', config: { prompt: 'first' } }, { type: 'rs_gen', config: { prompt: 'second' } }, { type: 'rs_view' },
    ])
    const done = startRun()
    await isWaiting(first)
    await release(first)
    await isWaiting(second)
    expect(await cancelRun(done)).toEqual({ hadError: false })

    const run = savedRun()
    expect(run.status).toBe('partial')
    expect(statuses()).toEqual(['completed', 'cancelled', 'idle'])
    expect(run.block_results[0].outputs.image).toEqual({ kind: 'image', value: generatedRef(first) })
    expect(run.block_results[1].outputs).toEqual({})
    expect(snapshotTypes()).toEqual(['rs_gen', 'rs_gen', 'rs_view'])
  })

  it('is not saved when the only finished output was not made by a generation', async () => {
    const [, gen] = renderFlow([{ type: 'rs_plain' }, { type: 'rs_gen', config: { prompt: 'a cat' } }])
    const done = startRun()
    await isWaiting(gen)
    await cancelRun(done)

    expect(saveRun).not.toHaveBeenCalled()
  })

  it('marks every branch that was running as cancelled', async () => {
    const [root, left, right] = renderFlow([
      { type: 'rs_gen', config: { prompt: 'root' }, branches: [[{ type: 'rs_gen' }], [{ type: 'rs_gen' }]] },
    ])
    const done = startRun()
    await isWaiting(root)
    await release(root)
    await isWaiting(left)
    await isWaiting(right)
    await cancelRun(done)

    expect(savedRun().status).toBe('partial')
    expect(statuses()).toEqual(['completed', 'cancelled', 'cancelled'])
  })

  it('keeps a branch that finished before the cancel', async () => {
    const [root, left, right] = renderFlow([
      { type: 'rs_gen', config: { prompt: 'root' }, branches: [[{ type: 'rs_gen' }], [{ type: 'rs_gen' }]] },
    ])
    const done = startRun()
    await isWaiting(root)
    await release(root)
    await isWaiting(left)
    await isWaiting(right)
    await release(left)
    await cancelRun(done)

    expect(statuses()).toEqual(['completed', 'completed', 'cancelled'])
    expect(savedRun().block_results[1].outputs.image.value).toEqual(generatedRef(left))
  })

  it('cancelled mid-iteration keeps the finished items once and does not count the cancelled item', async () => {
    const [iter, gen] = renderFlow([{ type: 'rs_iter' }, { type: 'rs_gen_n' }])
    const done = startRun()
    await isWaiting(gen)
    await release(gen)
    await waitFor(() => expect(genCalls.get(gen)).toBe(1))
    await isWaiting(gen)
    await cancelRun(done)

    const run = savedRun()
    expect(run.status).toBe('partial')
    expect(statuses()).toEqual(['completed', 'cancelled'])
    expect(run.block_results[1].outputs.image.value).toEqual(numberedRef(gen, 1))
    expect(api().blockStates.get(iter)?.statusMessage).toBe('1/3 items completed')
  })

  it('cancelled mid-iteration keeps a generation that finished inside the cancelled item', async () => {
    const [, first, second] = renderFlow([{ type: 'rs_iter' }, { type: 'rs_gen_n' }, { type: 'rs_gen_n' }])
    const done = startRun()
    await isWaiting(first)
    await release(first)
    await isWaiting(second)
    await release(second)
    await waitFor(() => expect(genCalls.get(second)).toBe(1))
    await isWaiting(first)
    await release(first)
    await isWaiting(second)
    await cancelRun(done)

    const run = savedRun()
    expect(statuses()).toEqual(['completed', 'completed', 'cancelled'])
    expect(run.block_results[1].outputs.image.value).toEqual([numberedRef(first, 1), numberedRef(first, 2)])
    expect(run.block_results[2].outputs.image.value).toEqual(numberedRef(second, 1))
  })

  it('is not saved when the first item of an iteration is cancelled', async () => {
    const [, gen] = renderFlow([{ type: 'rs_iter' }, { type: 'rs_gen_n' }])
    const done = startRun()
    await isWaiting(gen)
    await cancelRun(done)

    expect(saveRun).not.toHaveBeenCalled()
  })

  it('a cancelled Continue run is not saved when it only holds output carried over from the earlier run', async () => {
    const [first, second] = renderFlow([{ type: 'rs_gen', config: { prompt: 'first' } }, { type: 'rs_gen', config: { prompt: 'second' } }])
    const done = startRun()
    await isWaiting(first)
    await release(first)
    await isWaiting(second)
    await cancelRun(done)
    expect(saveRun).toHaveBeenCalledTimes(1)
    vi.mocked(saveRun).mockClear()

    const continued = startRun({ continueFromExisting: true })
    await isWaiting(second)
    expect(waiting.has(first)).toBe(false)
    await cancelRun(continued)

    expect(saveRun).not.toHaveBeenCalled()
  })

  it('a cancelled Continue run is saved when it finished a generation of its own', async () => {
    const [first, second, third] = renderFlow([
      { type: 'rs_gen', config: { prompt: 'first' } }, { type: 'rs_gen', config: { prompt: 'second' } }, { type: 'rs_gen', config: { prompt: 'third' } },
    ])
    const done = startRun()
    await isWaiting(first)
    await release(first)
    await isWaiting(second)
    await cancelRun(done)
    vi.mocked(saveRun).mockClear()

    const continued = startRun({ continueFromExisting: true })
    await isWaiting(second)
    await release(second)
    await isWaiting(third)
    await cancelRun(continued)

    expect(savedRun().status).toBe('partial')
    expect(statuses()).toEqual(['completed', 'completed', 'cancelled'])
    expect(savedRun().block_results[1].outputs.image.value).toEqual(generatedRef(second))
  })

  it('a run that was not cancelled is saved as before, after an earlier run was cancelled', async () => {
    const [gen] = renderFlow([{ type: 'rs_gen', config: { prompt: 'a cat' } }])
    const cancelled = startRun()
    await isWaiting(gen)
    await cancelRun(cancelled)
    expect(saveRun).not.toHaveBeenCalled()

    const done = startRun()
    await isWaiting(gen)
    await release(gen)
    await act(async () => { expect(await done).toEqual({ hadError: false }) })

    expect(savedRun().status).toBe('completed')
    expect(statuses()).toEqual(['completed'])
  })
})
