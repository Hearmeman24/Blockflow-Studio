/**
 * The run lifecycle of a tab: one run phase per tab, which the tab bar and the
 * blocks both read. A run that is cancelled and unwinds late never touches the
 * run that replaced it; a cancel ends every wait; a reload that finds jobs in
 * flight shows the tab running until the last of them ends; loop mode stops on
 * any cancel or error.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { SWRConfig } from 'swr'

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/api', () => ({
  saveRun: vi.fn(() => Promise.resolve({ ok: true })),
  fetchFlow: vi.fn(),
  fetchFlows: vi.fn(() => Promise.resolve({ ok: true, flows: [] })),
  saveFlowToDisk: vi.fn(),
}))

import { BlockCard } from '@/components/pipeline/block-card'
import { resumeGeneration, cancelResumedGeneration } from '@/lib/byok/run-generation'
import type { JobSnapshot } from '@/lib/types'
import { BlockLayoutProvider } from './block-layout-context'
import { savePendingJobRun } from './job-pending'
import { PipelineProvider, usePipeline } from './pipeline-context'
import { PORT_IMAGE, registerBlockDef, type BlockComponentProps } from './registry'
import { PipelineTabsProvider, usePipelineTabs } from './tabs-context'
import { walkBlocks } from './tree-utils'

/** Blocks waiting inside execute, by block id; calling the entry lets the block finish. */
const waiting = new Map<string, () => void>()
const signals = new Map<string, AbortSignal>()
const executions = new Map<string, number>()
const failing = new Set<string>()

function GenBlock({ blockId, setOutput, registerExecute }: BlockComponentProps) {
  useEffect(() => {
    registerExecute(async (_inputs, signal) => {
      executions.set(blockId, (executions.get(blockId) ?? 0) + 1)
      signals.set(blockId, signal)
      await new Promise<void>((resolve) => waiting.set(blockId, resolve))
      waiting.delete(blockId)
      if (failing.has(blockId)) throw new Error('provider said no')
      setOutput('image', { kind: 'image-ref', local: `/outputs/${blockId}.png` })
    })
  })
  return null
}

/** Mimics a generation block after a reload: rejoins its pending job and reports the block's status. */
function ResumeBlock({ blockId, setExecutionStatus }: BlockComponentProps) {
  useEffect(() => {
    const resumed = resumeGeneration({ blockId, pollIntervalMs: 5 })
    if (!resumed) return
    setExecutionStatus?.('running')
    let active = true
    resumed.promise
      .then((job) => { if (active) setExecutionStatus?.(job.status === 'COMPLETED' ? 'completed' : 'error', job.status) })
      .catch((err) => {
        if (!active) return
        if (err instanceof DOMException && err.name === 'AbortError') {
          cancelResumedGeneration(blockId, resumed.jobId)
          setExecutionStatus?.('idle')
          return
        }
        setExecutionStatus?.('error', String(err))
      })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId])
  return null
}

beforeAll(() => {
  registerBlockDef({
    type: 'lc_gen', label: 'Gen', description: '', size: 'sm', canStart: true,
    inputs: [], outputs: [{ name: 'image', kind: PORT_IMAGE }], configKeys: [], component: GenBlock,
  })
  // A block with no execute function: the runner passes through it and yields two frames.
  registerBlockDef({
    type: 'lc_pass', label: 'Pass', description: '', size: 'sm', canStart: true,
    inputs: [], outputs: [{ name: 'image', kind: PORT_IMAGE }], configKeys: [], component: () => null,
  })
  registerBlockDef({
    type: 'lc_resume', label: 'Resumed Gen', description: '', size: 'sm', canStart: true,
    inputs: [], outputs: [{ name: 'image', kind: PORT_IMAGE }], configKeys: [], component: ResumeBlock,
  })
})

type PipelineApi = ReturnType<typeof usePipeline>
type TabsApi = ReturnType<typeof usePipelineTabs>
const apis = new Map<string, PipelineApi>()
const tabsApi: { current: TabsApi | null } = { current: null }

function Canvas({ tabId }: { tabId: string }) {
  const api = usePipeline()
  useEffect(() => { apis.set(tabId, api) })
  return <>{[...walkBlocks(api.pipeline.blocks)].map((block, i) => <BlockCard key={block.id} block={block} displayNumber={String(i + 1)} />)}</>
}

function TabsProbe() {
  const api = usePipelineTabs()
  useEffect(() => { tabsApi.current = api })
  return null
}

const flowJson = (blocks: unknown[]) => JSON.stringify({ name: 'lc', version: 1, schema_version: 6, created_at: '', blocks })

let tabCounter = 0
/** Render one provider per entry inside one tab bar; the first tab is active. */
function renderTabs(tabs: Array<{ blocks?: unknown[]; stored?: true }>): string[] {
  const ids = tabs.map(() => `lc-${++tabCounter}`)
  sessionStorage.setItem('pipeline_tabs_v2', JSON.stringify({ tabs: ids.map((id) => ({ id, label: id })), activeTabId: ids[0] }))
  const providers: ReactNode[] = tabs.map((tab, i) => (
    <PipelineProvider key={ids[i]} tabId={ids[i]} flowJson={tab.blocks ? flowJson(tab.blocks) : undefined}>
      <BlockLayoutProvider><Canvas tabId={ids[i]} /></BlockLayoutProvider>
    </PipelineProvider>
  ))
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PipelineTabsProvider>
        <TabsProbe />
        {providers}
      </PipelineTabsProvider>
    </SWRConfig>,
  )
  return ids
}

const api = (tabId: string) => apis.get(tabId)!
const tabs = () => tabsApi.current!
const blockIds = (tabId: string) => [...walkBlocks(api(tabId).pipeline.blocks)].map((b) => b.id)
const tabState = (tabId: string) => tabs().tabRunStates[tabId]
const isWaiting = (blockId: string) => waitFor(() => expect(waiting.has(blockId)).toBe(true))
const release = (blockId: string) => act(async () => { waiting.get(blockId)!() })
const persistedRuntime = (tabId: string) => JSON.parse(sessionStorage.getItem(`pipeline_runtime_v2_${tabId}`) ?? 'null')

function startRun(tabId: string) {
  let done!: Promise<{ hadError: boolean }>
  act(() => { done = api(tabId).runPipeline() })
  return done
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  waiting.clear()
  signals.clear()
  executions.clear()
  failing.clear()
  apis.clear()
  tabsApi.current = null
})
afterEach(() => vi.unstubAllGlobals())

describe('one run phase per tab', () => {
  it('the tab bar and the provider agree while a run is in flight and after it ends', async () => {
    const [tab] = renderTabs([{ blocks: [{ type: 'lc_gen' }] }])
    const [gen] = blockIds(tab)
    const done = startRun(tab)
    await isWaiting(gen)
    expect(api(tab).isRunning).toBe(true)
    expect(api(tab).runningBlockId).toBe(gen)
    expect(tabState(tab)).toBe('running')
    expect(persistedRuntime(tab)).toMatchObject({ isRunning: true, runningBlockId: gen })

    await release(gen)
    await act(async () => { await done })
    expect(api(tab).isRunning).toBe(false)
    expect(api(tab).runningBlockId).toBeNull()
    expect(tabState(tab)).toBe('done')
    expect(persistedRuntime(tab)).toMatchObject({ isRunning: false, runningBlockId: null })
  })

  it('cancel aborts the signal the running block was given, and the run ends in done', async () => {
    const [tab] = renderTabs([{ blocks: [{ type: 'lc_gen' }] }])
    const [gen] = blockIds(tab)
    const done = startRun(tab)
    await isWaiting(gen)

    act(() => { api(tab).cancelPipeline() })
    expect(signals.get(gen)!.aborted).toBe(true)
    // While the cancelled run unwinds, the tab offers Run again (as before).
    expect(api(tab).isRunning).toBe(false)
    await act(async () => { await done })
    expect(tabState(tab)).toBe('done')
  })

  it('an old run unwinding after a cancel leaves the newer run running and locked', async () => {
    const [tab] = renderTabs([{ blocks: [{ type: 'lc_gen' }] }])
    const [gen] = blockIds(tab)
    const first = startRun(tab)
    await isWaiting(gen)

    let second!: Promise<{ hadError: boolean }>
    await act(async () => {
      api(tab).cancelPipeline()
      second = api(tab).runPipeline()
      await first
    })

    expect(executions.get(gen)).toBe(2)
    expect(api(tab).isRunning).toBe(true)
    expect(tabState(tab)).toBe('running')
    expect(signals.get(gen)!.aborted).toBe(false)
    // The newer run still holds the lock: a third start is refused.
    await act(async () => { await api(tab).runPipeline() })
    expect(executions.get(gen)).toBe(2)

    await release(gen)
    await act(async () => { await second })
    expect(api(tab).isRunning).toBe(false)
    expect(tabState(tab)).toBe('done')
  })

  it('a cancel ends the wait after a block with no execute function', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const [tab] = renderTabs([{ blocks: [{ type: 'lc_pass' }, { type: 'lc_gen' }] }])
    const [pass, gen] = blockIds(tab)
    let settled = false
    const done = startRun(tab)
    void done.then(() => { settled = true })
    await waitFor(() => expect(api(tab).blockStates.get(pass)?.status).toBe('completed'))

    act(() => { api(tab).cancelPipeline() })
    await waitFor(() => expect(settled).toBe(true))
    expect(executions.get(gen)).toBeUndefined()
    expect(tabState(tab)).toBe('done')
  })

  it('two tabs run at once; cancelling one leaves the other running', async () => {
    const [a, b] = renderTabs([{ blocks: [{ type: 'lc_gen' }] }, { blocks: [{ type: 'lc_gen' }] }])
    const [genA] = blockIds(a)
    const [genB] = blockIds(b)
    const doneA = startRun(a)
    const doneB = startRun(b)
    await isWaiting(genA)
    await isWaiting(genB)

    await act(async () => {
      tabs().cancelTabPipeline(a)
      await doneA
    })
    expect(tabState(a)).toBe('done')
    expect(signals.get(genA)!.aborted).toBe(true)
    expect(signals.get(genB)!.aborted).toBe(false)
    expect(api(b).isRunning).toBe(true)
    expect(tabState(b)).toBe('running')

    await release(genB)
    await act(async () => { await doneB })
    expect(tabState(b)).toBe('done')
  })

  it('importing a flow during a run keeps the tab running until that run ends', async () => {
    const [tab] = renderTabs([{ blocks: [{ type: 'lc_gen' }] }])
    const [gen] = blockIds(tab)
    const done = startRun(tab)
    await isWaiting(gen)

    act(() => { api(tab).importFlowJson(flowJson([{ type: 'lc_pass' }])) })
    expect(api(tab).isRunning).toBe(true)
    expect(tabState(tab)).toBe('running')

    await release(gen)
    await act(async () => { await done })
    expect(api(tab).isRunning).toBe(false)
    expect(tabState(tab)).toBe('done')
  })

  it('removing a tab mid-run cancels it, and the unwinding run does not bring its state back', async () => {
    const [a, b] = renderTabs([{ blocks: [{ type: 'lc_gen' }] }, { blocks: [{ type: 'lc_gen' }] }])
    const [genA] = blockIds(a)
    const done = startRun(a)
    await isWaiting(genA)
    await waitFor(() => expect(tabState(a)).toBe('running'))

    await act(async () => {
      tabs().removeTab(a)
      await done
    })
    expect(signals.get(genA)!.aborted).toBe(true)
    expect(a in tabs().tabRunStates).toBe(false)
    expect(tabs().tabs.map((t) => t.id)).toEqual([b])
  })
})

// ---- After a reload ----

type JobStatus = JobSnapshot['status']
const jobStatus = new Map<string, JobStatus>()
const cancelled: string[] = []

function stubJobStore() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url)
    const cancel = /\/api\/(?:generation\/)?jobs\/([^/]+)\/cancel/.exec(path)
    if (cancel || init?.method === 'POST') {
      cancelled.push(decodeURIComponent(cancel?.[1] ?? path))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const jobId = decodeURIComponent(path.split('/').pop()!)
    const status = jobStatus.get(jobId) ?? 'RUNNING'
    const job = {
      job_id: jobId, source: 'pipeline', provider: 'kie', model: 'm', mode: 'text_to_image', status,
      remote_job_id: null, remote_status: null, progress: null, message: null,
      error: status === 'FAILED' ? { kind: 'provider', message: 'no' } : null,
      outputs: status === 'COMPLETED' ? [{ kind: 'image', url: `https://x/${jobId}.png` }] : [],
      request: {}, created_at: 1, updated_at: 1, completed_at: null, cancel_requested: false,
    }
    return new Response(JSON.stringify({ ok: true, job }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
}

/** Store a tab as a reload finds it: its pipeline, its runtime, and the pending job of each listed block. */
function storeReloadedTab(blocks: Array<{ id: string; type: string }>, pendingJobs: Record<string, string>): void {
  const tabId = `lc-${tabCounter + 1}`
  sessionStorage.setItem(`pipeline_v2_${tabId}`, JSON.stringify({ id: 'default', blocks }))
  sessionStorage.setItem(`pipeline_runtime_v2_${tabId}`, JSON.stringify({
    blockStates: blocks.map((b) => [b.id, { status: b.id in pendingJobs ? 'running' : 'idle', outputs: {} }]),
    isRunning: false,
    runningBlockId: null,
  }))
  for (const [blockId, jobId] of Object.entries(pendingJobs)) {
    savePendingJobRun(blockId, { kind: 'generation', total: 1, submissionFailures: 0, submitted: [{ idx: 0, jobId }], startedAt: Date.now() })
  }
}

describe('after a reload with jobs in flight', () => {
  beforeEach(() => {
    jobStatus.clear()
    cancelled.length = 0
    stubJobStore()
  })

  it('with no pending job the tab is idle', async () => {
    storeReloadedTab([{ id: 'r0', type: 'lc_resume' }], {})
    const [tab] = renderTabs([{ stored: true }])
    await waitFor(() => expect(tabs().tabRunStates[tab]).toBe('idle'))
    expect(api(tab).isRunning).toBe(false)
  })

  it('shows the tab running until the resumed job ends, then re-enables the controls', async () => {
    storeReloadedTab([{ id: 'r1', type: 'lc_resume' }], { r1: 'job-1' })
    const [tab] = renderTabs([{ stored: true }])
    await waitFor(() => expect(tabState(tab)).toBe('running'))
    expect(api(tab).isRunning).toBe(true)

    jobStatus.set('job-1', 'COMPLETED')
    await waitFor(() => expect(api(tab).isRunning).toBe(false))
    expect(tabState(tab)).toBe('done')
    expect(persistedRuntime(tab)).toMatchObject({ isRunning: false, runningBlockId: null })
    await waitFor(() => expect(api(tab).blockStates.get('r1')?.status).toBe('completed'))
  })

  it('with several pending jobs, stays running until the last one ends, failed or not', async () => {
    storeReloadedTab([{ id: 'r1', type: 'lc_resume' }, { id: 'r2', type: 'lc_resume' }], { r1: 'job-1', r2: 'job-2' })
    const [tab] = renderTabs([{ stored: true }])
    await waitFor(() => expect(tabState(tab)).toBe('running'))

    jobStatus.set('job-1', 'FAILED')
    await waitFor(() => expect(api(tab).blockStates.get('r1')?.status).toBe('error'))
    expect(api(tab).isRunning).toBe(true)
    expect(tabState(tab)).toBe('running')

    jobStatus.set('job-2', 'COMPLETED')
    await waitFor(() => expect(api(tab).isRunning).toBe(false))
    expect(tabState(tab)).toBe('done')
  })

  it('Stop cancels the resumed jobs and ends the resume', async () => {
    storeReloadedTab([{ id: 'r1', type: 'lc_resume' }, { id: 'r2', type: 'lc_resume' }], { r1: 'job-1', r2: 'job-2' })
    const [tab] = renderTabs([{ stored: true }])
    await waitFor(() => expect(tabState(tab)).toBe('running'))

    act(() => { tabs().cancelActivePipeline() })
    expect(api(tab).isRunning).toBe(false)
    await waitFor(() => expect(cancelled.sort()).toEqual(['job-1', 'job-2']))
    expect(tabState(tab)).toBe('done')
  })

  it('a run cannot start while the resumed job is in flight', async () => {
    storeReloadedTab([{ id: 'r1', type: 'lc_resume' }, { id: 'g', type: 'lc_gen' }], { r1: 'job-1' })
    const [tab] = renderTabs([{ stored: true }])
    await waitFor(() => expect(tabState(tab)).toBe('running'))

    await act(async () => { await api(tab).runPipeline() })
    expect(executions.get('g')).toBeUndefined()

    jobStatus.set('job-1', 'COMPLETED')
    await waitFor(() => expect(api(tab).isRunning).toBe(false))
  })
})

describe('loop mode', () => {
  it('restarts after each run and counts iterations until stopped', async () => {
    const [tab] = renderTabs([{ blocks: [{ type: 'lc_gen' }] }])
    const [gen] = blockIds(tab)
    act(() => { void tabs().startLoop() })
    await isWaiting(gen)
    expect(tabs().loopingTabs[tab]).toBe(true)
    expect(tabs().loopIterations[tab]).toBe(1)

    await release(gen)
    await isWaiting(gen)
    await waitFor(() => expect(tabs().loopIterations[tab]).toBe(2))
    expect(executions.get(gen)).toBe(2)

    act(() => { tabs().stopLoop(tab) })
    expect(tabs().loopingTabs[tab] ?? false).toBe(false)
    await release(gen)
    await waitFor(() => expect(tabState(tab)).toBe('done'))
    expect(executions.get(gen)).toBe(2)
  })

  it('any cancel of the tab\'s run stops the loop, even one that bypasses the tab bar', async () => {
    const [tab] = renderTabs([{ blocks: [{ type: 'lc_gen' }] }])
    const [gen] = blockIds(tab)
    act(() => { void tabs().startLoop() })
    await isWaiting(gen)

    act(() => { api(tab).cancelPipeline() })
    await waitFor(() => expect(tabState(tab)).toBe('done'))
    expect(tabs().loopingTabs[tab] ?? false).toBe(false)
    await new Promise((r) => setTimeout(r, 20))
    expect(executions.get(gen)).toBe(1)
  })

  it('stops when a run fails', async () => {
    const [tab] = renderTabs([{ blocks: [{ type: 'lc_gen' }] }])
    const [gen] = blockIds(tab)
    act(() => { void tabs().startLoop() })
    await isWaiting(gen)
    await release(gen)
    await isWaiting(gen)
    failing.add(gen)
    await release(gen)

    await waitFor(() => expect(tabs().loopingTabs[tab] ?? false).toBe(false))
    await new Promise((r) => setTimeout(r, 20))
    expect(executions.get(gen)).toBe(2)
    expect(tabState(tab)).toBe('done')
  })

  it('restarts every looping tab whose run ended', async () => {
    const [a, b] = renderTabs([{ blocks: [{ type: 'lc_gen' }] }, { blocks: [{ type: 'lc_gen' }] }])
    const [genA] = blockIds(a)
    const [genB] = blockIds(b)
    act(() => { void tabs().startLoop() })
    act(() => { tabs().setActiveTabId(b) })
    act(() => { void tabs().startLoop() })
    await isWaiting(genA)
    await isWaiting(genB)

    await act(async () => {
      waiting.get(genA)!()
      waiting.get(genB)!()
    })
    await waitFor(() => expect([executions.get(genA), executions.get(genB)]).toEqual([2, 2]))
    expect(tabs().loopIterations).toMatchObject({ [a]: 2, [b]: 2 })
  })
})
