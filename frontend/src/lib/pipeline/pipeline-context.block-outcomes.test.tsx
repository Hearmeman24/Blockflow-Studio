/**
 * How each block ends a run, and how an iterator's items end.
 *
 * A cancel that interrupts a block leaves it `cancelled` (shown as
 * "Cancelled", not pulsing), never `running`. A block found running after a
 * reload with nothing to finish it ends idle with a visible note. An iterator
 * item whose chain fails is marked failed with the block's message, the next
 * item still runs, and only outputs a block made for that item are collected.
 * Each iterator keeps its own progress, and Continue re-runs only the items
 * that did not complete.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
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
import { PORT_IMAGE, PORT_TEXT, registerBlockDef, type BlockComponentProps } from './registry'
import { PipelineTabsProvider } from './tabs-context'
import { walkBlocks } from './tree-utils'

/** A block waiting inside execute, by block id: finish it with `release` or `fail`. */
const waiting = new Map<string, { resolve: () => void; reject: (e: Error) => void }>()
/** The inputs of every execution, by block id. */
const calls = new Map<string, Array<Record<string, unknown>>>()
const signals = new Map<string, AbortSignal>()
/** Items an iterator emits, by block id (default a, b, c). */
const itemsFor = new Map<string, unknown[]>()

function ref(blockId: string, n: number) {
  return { kind: 'image-ref', local: `/outputs/${blockId}-${n}.png`, meta: { job_id: `job-${blockId}-${n}`, provider: 'kie', model: 'm', cost: null } }
}

function GenBlock({ blockId, setOutput, registerExecute }: BlockComponentProps) {
  useEffect(() => {
    registerExecute(async (inputs, signal) => {
      const mine = [...(calls.get(blockId) ?? []), inputs]
      calls.set(blockId, mine)
      signals.set(blockId, signal)
      await new Promise<void>((resolve, reject) => waiting.set(blockId, { resolve, reject }))
      setOutput('image', ref(blockId, mine.length))
    })
  })
  return null
}

function IterBlock({ blockId, setOutput, registerExecute }: BlockComponentProps) {
  useEffect(() => {
    registerExecute(async () => {
      calls.set(blockId, [...(calls.get(blockId) ?? []), {}])
      setOutput('items', itemsFor.get(blockId) ?? ['a', 'b', 'c'])
    })
  })
  return null
}

beforeAll(() => {
  registerBlockDef({
    type: 'bo_gen', label: 'Gen', description: '', size: 'sm', canStart: true,
    inputs: [{ name: 'prompt', kind: PORT_TEXT, required: false }], outputs: [{ name: 'image', kind: PORT_IMAGE }],
    configKeys: [], component: GenBlock,
  })
  registerBlockDef({
    type: 'bo_iter', label: 'Iter', description: '', size: 'sm', canStart: true, iterator: true,
    inputs: [{ name: 'prompt', kind: PORT_TEXT, required: false }], outputs: [{ name: 'items', kind: PORT_TEXT }],
    configKeys: [], component: IterBlock,
  })
})

const captured: { api: ReturnType<typeof usePipeline> | null } = { api: null }
function Canvas() {
  const api = usePipeline()
  useEffect(() => { captured.api = api })
  return <>{[...walkBlocks(api.pipeline.blocks)].map((block, i) => <BlockCard key={block.id} block={block} displayNumber={String(i + 1)} />)}</>
}

let tab = 0
function renderProvider(tabId: string, flowJson?: string) {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PipelineTabsProvider>
        <PipelineProvider tabId={tabId} flowJson={flowJson}>
          <BlockLayoutProvider><Canvas /></BlockLayoutProvider>
        </PipelineProvider>
      </PipelineTabsProvider>
    </SWRConfig>,
  )
}

function renderFlow(blocks: unknown[]): string[] {
  renderProvider(`bo-${++tab}`, JSON.stringify({ name: 'bo', version: 1, schema_version: 6, created_at: '', blocks }))
  return [...walkBlocks(captured.api!.pipeline.blocks)].map((b) => b.id)
}

const api = () => captured.api!
const status = (id: string) => api().blockStates.get(id)?.status
const isWaiting = (id: string) => waitFor(() => expect(waiting.has(id)).toBe(true))
const release = (id: string) => act(async () => {
  const w = waiting.get(id)!
  waiting.delete(id)
  w.resolve()
})
const fail = (id: string) => act(async () => {
  const w = waiting.get(id)!
  waiting.delete(id)
  w.reject(new Error(`${id} said no`))
})

function startRun(opts?: { continueFromExisting?: boolean }) {
  let done!: Promise<{ hadError: boolean }>
  act(() => { done = api().runPipeline(opts) })
  return done
}
async function finish(done: Promise<{ hadError: boolean }>) {
  let result!: { hadError: boolean }
  await act(async () => { result = await done })
  return result
}
async function cancelRun(done: Promise<{ hadError: boolean }>) {
  let result!: { hadError: boolean }
  await act(async () => {
    api().cancelPipeline()
    result = await done
  })
  waiting.clear()
  return result
}

/** The card of the block shown with this display number (1-based). */
function card(displayNumber: number): HTMLElement {
  const button = screen.getAllByTestId('block-card-select').find((b) => b.textContent === String(displayNumber))!
  return button.closest('[data-slot="card"]') as HTMLElement
}
const badge = (displayNumber: number) => within(card(displayNumber)).getByTestId('block-status-badge')

function savedRuns(): RunEntry[] {
  return vi.mocked(saveRun).mock.calls.map((c) => c[0] as RunEntry)
}
function lastSavedRun(): RunEntry {
  const runs = savedRuns()
  expect(runs.length).toBeGreaterThan(0)
  return runs[runs.length - 1]
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  waiting.clear()
  calls.clear()
  signals.clear()
  itemsFor.clear()
  vi.mocked(saveRun).mockClear()
})
afterEach(() => vi.unstubAllGlobals())

// ---- A cancel ends every interrupted block ----

describe('a cancelled block', () => {
  it('cancelled during the first block: the block is cancelled, shows "Cancelled" and stops pulsing', async () => {
    const [gen, next] = renderFlow([{ type: 'bo_gen' }, { type: 'bo_gen' }])
    const done = startRun()
    await isWaiting(gen)
    expect(badge(1).textContent).toBe('Running')
    expect(badge(1).className).toContain('animate-pulse')

    await cancelRun(done)
    expect(signals.get(gen)!.aborted).toBe(true)
    expect(status(gen)).toBe('cancelled')
    expect(status(next)).toBe('idle')
    expect(badge(1).textContent).toBe('Cancelled')
    expect(badge(1).className).not.toContain('animate-pulse')
    expect(badge(1).className).not.toMatch(/(?:^|\s)(?:bg|text)-(?:red-|destructive)/)
    const persisted = JSON.parse(sessionStorage.getItem(`pipeline_runtime_v2_bo-${tab}`)!)
    expect(new Map(persisted.blockStates).get(gen)).toMatchObject({ status: 'cancelled' })
  })

  it('cancelled mid-chain: finished blocks stay completed, the interrupted one is cancelled, later ones idle', async () => {
    const [a, b, c] = renderFlow([{ type: 'bo_gen' }, { type: 'bo_gen' }, { type: 'bo_gen' }])
    const done = startRun()
    await isWaiting(a)
    await release(a)
    await isWaiting(b)
    await cancelRun(done)
    expect([status(a), status(b), status(c)]).toEqual(['completed', 'cancelled', 'idle'])
  })

  it('cancelled during parallel branches: every branch block that was running is cancelled', async () => {
    const [root, left, right] = renderFlow([{ type: 'bo_gen', branches: [[{ type: 'bo_gen' }], [{ type: 'bo_gen' }]] }])
    const done = startRun()
    await isWaiting(root)
    await release(root)
    await isWaiting(left)
    await isWaiting(right)
    await cancelRun(done)
    expect([status(root), status(left), status(right)]).toEqual(['completed', 'cancelled', 'cancelled'])
  })

  it('cancelled inside an iterator item: the item block is cancelled, the iterator shows its item count', async () => {
    const [iter, gen] = renderFlow([{ type: 'bo_iter' }, { type: 'bo_gen' }])
    const done = startRun()
    await isWaiting(gen)
    await release(gen)
    await waitFor(() => expect(calls.get(gen)).toHaveLength(2))
    await cancelRun(done)
    expect(status(gen)).toBe('cancelled')
    expect(status(iter)).toBe('completed')
    expect(badge(1).textContent).toBe('1/3 items completed')
    expect(badge(2).textContent).toBe('Cancelled')
  })

  it('Continue after a cancel runs the cancelled block again and keeps the finished one', async () => {
    const [a, b] = renderFlow([{ type: 'bo_gen' }, { type: 'bo_gen' }])
    const done = startRun()
    await isWaiting(a)
    await release(a)
    await isWaiting(b)
    await cancelRun(done)

    const continued = startRun({ continueFromExisting: true })
    await isWaiting(b)
    expect(calls.get(a)).toHaveLength(1)
    expect(status(b)).toBe('running')
    await release(b)
    expect(await finish(continued)).toEqual({ hadError: false })
    expect([status(a), status(b)]).toEqual(['completed', 'completed'])
  })

  it('a cancelled run that unwinds after a newer run started leaves the newer run\'s block running', async () => {
    const [gen] = renderFlow([{ type: 'bo_gen' }])
    const first = startRun()
    await isWaiting(gen)
    let second!: Promise<{ hadError: boolean }>
    await act(async () => {
      api().cancelPipeline()
      second = api().runPipeline()
      await first
    })
    expect(calls.get(gen)).toHaveLength(2)
    expect(status(gen)).toBe('running')
    expect(badge(1).textContent).toBe('Running')
    await release(gen)
    await finish(second)
    expect(status(gen)).toBe('completed')
  })
})

// ---- Messages ----

describe('status messages', () => {
  it('a completed block with no message shows "Done" and no note', async () => {
    const [gen] = renderFlow([{ type: 'bo_gen' }])
    const done = startRun()
    await isWaiting(gen)
    await release(gen)
    await finish(done)
    expect(badge(1).textContent).toBe('Done')
    expect(within(card(1)).queryByTestId('block-status-note')).toBeNull()
  })

  it('after an iteration the iterator shows how many items completed', async () => {
    const [iter, gen] = renderFlow([{ type: 'bo_iter' }, { type: 'bo_gen' }])
    const done = startRun()
    for (let i = 0; i < 3; i++) {
      await isWaiting(gen)
      await release(gen)
    }
    await finish(done)
    expect(api().blockStates.get(iter)?.statusMessage).toBe('3/3 items completed')
    expect(badge(1).textContent).toBe('3/3 items completed')
  })
})

describe('after a reload', () => {
  function storeTab(tabId: string, states: Array<[string, unknown]>, isRunning = false) {
    sessionStorage.setItem(`pipeline_v2_${tabId}`, JSON.stringify({
      id: 'default', blocks: states.map(([id]) => ({ id, type: 'bo_gen' })),
    }))
    sessionStorage.setItem(`pipeline_runtime_v2_${tabId}`, JSON.stringify({ blockStates: states, isRunning, runningBlockId: null }))
  }

  it('a block left running with no job pending ends idle and shows the interrupted note', async () => {
    const tabId = `bo-${++tab}`
    storeTab(tabId, [['g1', { status: 'completed', outputs: { image: 'x' } }], ['g2', { status: 'running', outputs: {} }]])
    renderProvider(tabId)
    expect(status('g1')).toBe('completed')
    expect(status('g2')).toBe('idle')
    expect(api().isRunning).toBe(false)
    expect(within(card(2)).getByTestId('block-status-note').textContent).toMatch(/Run tracking was interrupted/)
    expect(badge(2).textContent).toBe('Idle')
    expect(within(card(1)).queryByTestId('block-status-note')).toBeNull()
  })

  it('a status this build does not know, from an older or newer build, loads as idle', async () => {
    const tabId = `bo-${++tab}`
    storeTab(tabId, [
      ['g1', { status: 'paused', outputs: { image: 'x' } }],
      ['g2', { status: 42, outputs: {} }],
      ['g3', { status: 'cancelled', outputs: {} }],
    ])
    renderProvider(tabId)
    expect(status('g1')).toBe('idle')
    expect(api().blockStates.get('g1')?.outputs).toEqual({ image: 'x' })
    expect(status('g2')).toBe('idle')
    expect(status('g3')).toBe('cancelled')
    expect(badge(1).textContent).toBe('Idle')
    expect(badge(3).textContent).toBe('Cancelled')
  })

  it('error text stored on a block that is not in error is dropped', async () => {
    const tabId = `bo-${++tab}`
    storeTab(tabId, [['g1', { status: 'completed', outputs: {}, error: 'stale' }], ['g2', { status: 'error', outputs: {}, error: 'boom' }]])
    renderProvider(tabId)
    expect(api().blockStates.get('g1')?.error).toBeUndefined()
    expect(api().blockStates.get('g2')?.error).toBe('boom')
  })
})

// ---- Iteration ----

describe('an iterator item that fails', () => {
  async function runItems(gen: string, outcomes: Array<'ok' | 'fail'>) {
    for (const outcome of outcomes) {
      await isWaiting(gen)
      if (outcome === 'ok') await release(gen)
      else await fail(gen)
    }
  }

  it('fails at item 2 of 3: marked failed with the message, item 3 still runs, the stale output is not collected', async () => {
    const [iter, gen] = renderFlow([{ type: 'bo_iter' }, { type: 'bo_gen' }])
    const done = startRun()
    await isWaiting(gen)
    await release(gen)
    await isWaiting(gen)
    const items = () => api().iterationStates.get(iter)!.items
    await fail(gen)
    await waitFor(() => expect(items()[1].status).toBe('error'))
    expect(items()[1].error).toBe(`Error: ${gen} said no`)
    expect(items()[0].status).toBe('completed')
    await isWaiting(gen)
    await release(gen)
    expect(await finish(done)).toEqual({ hadError: true })

    expect(calls.get(gen)!.map((i) => i.prompt)).toEqual(['a', 'b', 'c'])
    expect(api().blockStates.get(gen)?.outputs.image).toEqual([ref(gen, 1), ref(gen, 3)])
    expect(api().blockStates.get(iter)?.statusMessage).toBe('2/3 items completed')
    const run = lastSavedRun()
    expect(run.status).toBe('partial')
    expect(run.block_results[1].status).toBe('completed')
    expect(run.block_results[1].outputs.image.value).toEqual([ref(gen, 1), ref(gen, 3)])
  })

  it('fails at item 1: the next items run and are collected', async () => {
    const [iter, gen] = renderFlow([{ type: 'bo_iter' }, { type: 'bo_gen' }])
    const done = startRun()
    await runItems(gen, ['fail', 'ok', 'ok'])
    await finish(done)
    expect(api().blockStates.get(gen)?.outputs.image).toEqual([ref(gen, 2), ref(gen, 3)])
    expect(api().blockStates.get(iter)?.statusMessage).toBe('2/3 items completed')
  })

  it('fails at the last item: the earlier items are collected once and the block is saved as error', async () => {
    const [, gen] = renderFlow([{ type: 'bo_iter' }, { type: 'bo_gen' }])
    const done = startRun()
    await runItems(gen, ['ok', 'ok', 'fail'])
    await finish(done)
    const run = lastSavedRun()
    expect(run.status).toBe('partial')
    expect(run.block_results[1].status).toBe('error')
    expect(run.block_results[1].outputs.image.value).toEqual([ref(gen, 1), ref(gen, 2)])
  })

  it('fails in every item: nothing is collected and the run reports an error', async () => {
    const [iter, gen] = renderFlow([{ type: 'bo_iter' }, { type: 'bo_gen' }])
    const done = startRun()
    await runItems(gen, ['fail', 'fail', 'fail'])
    expect(await finish(done)).toEqual({ hadError: true })
    expect(api().blockStates.get(gen)?.outputs.image).toBeUndefined()
    expect(api().blockStates.get(iter)?.statusMessage).toBe('0/3 items completed')
    // The saved status keeps the rule as written: the iterator itself completed.
    expect(lastSavedRun().status).toBe('partial')
  })

  it('a block after the failing one did not run for that item, so its previous output is not collected again', async () => {
    const [, first, second] = renderFlow([{ type: 'bo_iter' }, { type: 'bo_gen' }, { type: 'bo_gen' }])
    const done = startRun()
    await runItems(first, ['ok'])
    await runItems(second, ['ok'])
    await runItems(first, ['fail'])
    await runItems(first, ['ok'])
    await runItems(second, ['ok'])
    await finish(done)
    expect(api().blockStates.get(first)?.outputs.image).toEqual([ref(first, 1), ref(first, 3)])
    expect(api().blockStates.get(second)?.outputs.image).toEqual([ref(second, 1), ref(second, 2)])
  })
})

describe('several iterators', () => {
  it('sibling iterators in parallel branches each keep their own progress', async () => {
    const [root, iterA, genA, iterB, genB] = renderFlow([
      { type: 'bo_gen', branches: [[{ type: 'bo_iter' }, { type: 'bo_gen' }], [{ type: 'bo_iter' }, { type: 'bo_gen' }]] },
    ])
    itemsFor.set(iterA, ['a1', 'a2'])
    itemsFor.set(iterB, ['b1', 'b2', 'b3'])
    const done = startRun()
    await isWaiting(root)
    await release(root)
    await isWaiting(genA)
    await isWaiting(genB)
    expect(api().iterationStates.get(iterA)).toMatchObject({ blockId: iterA, totalCount: 2, currentIndex: 0 })
    expect(api().iterationStates.get(iterB)).toMatchObject({ blockId: iterB, totalCount: 3, currentIndex: 0 })
    expect(within(card(2)).getByText('Iterating: 1/2')).toBeTruthy()
    expect(within(card(4)).getByText('Iterating: 1/3')).toBeTruthy()

    await release(genB)
    await isWaiting(genB)
    expect(api().iterationStates.get(iterA)!.currentIndex).toBe(0)
    expect(api().iterationStates.get(iterB)!.currentIndex).toBe(1)
    await release(genA)
    await isWaiting(genA)
    await release(genA)
    await release(genB)
    await isWaiting(genB)
    await release(genB)
    await finish(done)
    expect(api().blockStates.get(genA)?.outputs.image).toEqual([ref(genA, 1), ref(genA, 2)])
    expect(api().blockStates.get(genB)?.outputs.image).toEqual([ref(genB, 1), ref(genB, 2), ref(genB, 3)])
    expect(api().iterationStates.size).toBe(0)
  })

  it('a nested iterator does not overwrite the outer one\'s progress', async () => {
    const [outer, inner, gen] = renderFlow([{ type: 'bo_iter' }, { type: 'bo_iter' }, { type: 'bo_gen' }])
    itemsFor.set(outer, ['o1', 'o2'])
    itemsFor.set(inner, ['i1', 'i2'])
    const done = startRun()
    await isWaiting(gen)
    expect(api().iterationStates.get(outer)).toMatchObject({ totalCount: 2, currentIndex: 0 })
    expect(api().iterationStates.get(inner)).toMatchObject({ totalCount: 2, currentIndex: 0 })
    for (let i = 0; i < 4; i++) {
      await isWaiting(gen)
      await release(gen)
    }
    await finish(done)
    expect(calls.get(gen)).toHaveLength(4)
    expect(calls.get(inner)).toHaveLength(2)
  })
})

describe('Continue after an iteration', () => {
  it('after an item failed, runs only that item again and keeps the others', async () => {
    const [iter, gen] = renderFlow([{ type: 'bo_iter' }, { type: 'bo_gen' }])
    const done = startRun()
    await isWaiting(gen)
    await release(gen)
    await isWaiting(gen)
    await fail(gen)
    await isWaiting(gen)
    await release(gen)
    await finish(done)
    expect(calls.get(gen)).toHaveLength(3)

    const continued = startRun({ continueFromExisting: true })
    await isWaiting(gen)
    expect(calls.get(iter)).toHaveLength(1)
    // The item, not the whole list.
    expect(calls.get(gen)![3].prompt).toBe('b')
    await release(gen)
    expect(await finish(continued)).toEqual({ hadError: false })
    expect(calls.get(gen)).toHaveLength(4)
    expect(api().blockStates.get(gen)?.outputs.image).toEqual([ref(gen, 1), ref(gen, 4), ref(gen, 3)])
    expect(api().blockStates.get(iter)?.statusMessage).toBe('3/3 items completed')
    expect(lastSavedRun().status).toBe('completed')
  })

  it('after the last item failed, the block gets that item, not the whole list at once', async () => {
    const [iter, gen] = renderFlow([{ type: 'bo_iter' }, { type: 'bo_gen' }])
    const done = startRun()
    for (const outcome of ['ok', 'ok', 'fail'] as const) {
      await isWaiting(gen)
      if (outcome === 'ok') await release(gen)
      else await fail(gen)
    }
    await finish(done)
    expect(status(gen)).toBe('error')

    const continued = startRun({ continueFromExisting: true })
    await isWaiting(gen)
    expect(calls.get(gen)![3].prompt).toBe('c')
    await release(gen)
    await finish(continued)
    expect(calls.get(gen)).toHaveLength(4)
    expect(calls.get(iter)).toHaveLength(1)
    expect(api().blockStates.get(gen)?.outputs.image).toEqual([ref(gen, 1), ref(gen, 2), ref(gen, 4)])
  })

  it('with no record of the last iteration (as after a reload), runs every item rather than the whole list once', async () => {
    const [iter, gen] = renderFlow([{ type: 'bo_iter' }, { type: 'bo_gen' }])
    const done = startRun()
    for (const outcome of ['ok', 'ok', 'fail'] as const) {
      await isWaiting(gen)
      if (outcome === 'ok') await release(gen)
      else await fail(gen)
    }
    await finish(done)
    // Resetting a block forgets the recorded items.
    act(() => { api().resetRuntimeFromBlock(gen) })

    const continued = startRun({ continueFromExisting: true })
    for (let i = 0; i < 3; i++) {
      await isWaiting(gen)
      await release(gen)
    }
    await finish(continued)
    expect(calls.get(gen)!.slice(3).map((i) => i.prompt)).toEqual(['a', 'b', 'c'])
    expect(calls.get(iter)).toHaveLength(1)
  })

  it('a nested iterator re-run inside an outer item runs its own items, not another outer item\'s', async () => {
    const [outer, inner, gen] = renderFlow([{ type: 'bo_iter' }, { type: 'bo_iter' }, { type: 'bo_gen' }])
    itemsFor.set(outer, ['o1', 'o2'])
    itemsFor.set(inner, ['i1', 'i2'])
    const done = startRun()
    // Outer item 1: both inner items fail, so the outer item fails. Outer item 2 completes.
    for (const outcome of ['fail', 'fail', 'ok', 'ok'] as const) {
      await isWaiting(gen)
      if (outcome === 'ok') await release(gen)
      else await fail(gen)
    }
    await finish(done)
    expect(api().blockStates.get(outer)?.statusMessage).toBe('1/2 items completed')

    const continued = startRun({ continueFromExisting: true })
    for (let i = 0; i < 2; i++) {
      await isWaiting(gen)
      await release(gen)
    }
    await finish(continued)
    expect(calls.get(gen)).toHaveLength(6)
    expect(calls.get(inner)).toHaveLength(3)
    expect(api().blockStates.get(outer)?.statusMessage).toBe('2/2 items completed')
  })

  it('after a cancel mid-iteration, runs the cancelled item and the ones not reached', async () => {
    const [, gen] = renderFlow([{ type: 'bo_iter' }, { type: 'bo_gen' }])
    const done = startRun()
    await isWaiting(gen)
    await release(gen)
    await isWaiting(gen)
    await cancelRun(done)

    const continued = startRun({ continueFromExisting: true })
    await isWaiting(gen)
    expect(calls.get(gen)![2].prompt).toBe('b')
    await release(gen)
    await isWaiting(gen)
    expect(calls.get(gen)![3].prompt).toBe('c')
    await release(gen)
    await finish(continued)
    expect(api().blockStates.get(gen)?.outputs.image).toEqual([ref(gen, 1), ref(gen, 3), ref(gen, 4)])
  })

  it('when every item completed, runs nothing again', async () => {
    const [iter, gen] = renderFlow([{ type: 'bo_iter' }, { type: 'bo_gen' }])
    const done = startRun()
    for (let i = 0; i < 3; i++) {
      await isWaiting(gen)
      await release(gen)
    }
    await finish(done)
    const continued = startRun({ continueFromExisting: true })
    await finish(continued)
    expect(calls.get(gen)).toHaveLength(3)
    expect(calls.get(iter)).toHaveLength(1)
    expect(api().blockStates.get(gen)?.outputs.image).toEqual([ref(gen, 1), ref(gen, 2), ref(gen, 3)])
  })
})
