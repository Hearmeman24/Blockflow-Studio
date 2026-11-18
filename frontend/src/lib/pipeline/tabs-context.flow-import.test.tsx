import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import { useEffect } from 'react'

const toastMock = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

const apiMock = vi.hoisted(() => ({
  saveRun: vi.fn(() => Promise.resolve({ ok: true })),
  fetchFlow: vi.fn(),
  fetchFlows: vi.fn(() => Promise.resolve({ ok: true, flows: [] })),
  saveFlowToDisk: vi.fn(),
}))
vi.mock('@/lib/api', () => apiMock)

import '@/components/pipeline/custom_blocks/_register'
import { PipelineTabsProvider, usePipelineTabs } from './tabs-context'
import { PipelineProvider, usePipeline } from './pipeline-context'
import { registerBlockDef } from './registry'
import type { Pipeline } from './types'
import { NEWER_SCHEMA_ERROR } from './flow-migrations'

beforeAll(() => {
  registerBlockDef({
    type: 'tcfi_src',
    label: 'Src',
    description: '',
    size: 'sm',
    inputs: [],
    outputs: [{ name: 'text', kind: 'text' }],
    canStart: true,
    component: () => null,
  } as unknown as Parameters<typeof registerBlockDef>[0])
})

type TabsApi = ReturnType<typeof usePipelineTabs>
// Latest context values, captured after each commit.
const pipelines: Record<string, Pipeline> = {}
const latest = {} as { tabs: TabsApi }

function Probe({ tabId }: { tabId: string }) {
  const { pipeline } = usePipeline()
  useEffect(() => {
    pipelines[tabId] = pipeline
  }, [tabId, pipeline])
  return null
}

function Harness() {
  const api = usePipelineTabs()
  useEffect(() => {
    latest.tabs = api
  })
  return (
    <>
      {api.tabs.map((tab) => (
        <PipelineProvider key={tab.id} tabId={tab.id} flowJson={tab.flowJson}>
          <Probe tabId={tab.id} />
        </PipelineProvider>
      ))}
    </>
  )
}

async function mount() {
  render(
    <PipelineTabsProvider>
      <Harness />
    </PipelineTabsProvider>,
  )
  // Wait for sessionStorage hydration to replace the SSR placeholder tab.
  await waitFor(() => expect(latest.tabs.tabs[0].id).not.toBe('__ssr__'))
}

const flow = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({
  name: 'f',
  version: 1,
  created_at: '',
  blocks,
  ...extra,
})

function pipelineOf(index: number): Pipeline {
  return pipelines[latest.tabs.tabs[index].id]
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  for (const key of Object.keys(pipelines)) delete pipelines[key]
  toastMock.warning.mockReset()
  toastMock.error.mockReset()
  apiMock.fetchFlow.mockReset()
})

describe('openFlowInActiveTab', () => {
  it('imports the flow and surfaces unsupported blocks once', async () => {
    await mount()
    apiMock.fetchFlow.mockResolvedValue({
      ok: true,
      name: 'Legacy',
      flow: flow([{ type: 'tcfi_src' }, { type: 'comfyGen' }, { type: 'loraTrain', label: 'Mine' }]),
    })
    await act(async () => {
      await latest.tabs.openFlowInActiveTab('Legacy')
    })
    expect(pipelineOf(0).blocks.map((b) => b.type)).toEqual(['tcfi_src', 'comfyGen', 'loraTrain'])
    expect(latest.tabs.tabs[0].label).toBe('Legacy')
    expect(toastMock.warning).toHaveBeenCalledTimes(1)
    expect(toastMock.warning).toHaveBeenCalledWith('2 blocks in this flow are no longer supported', expect.objectContaining({
      description: 'ComfyUI Gen, Mine. Remove or disable them before running.',
    }))
  })

  it('refuses a newer-schema flow, keeps the canvas and the tab name, and shows the error', async () => {
    await mount()
    apiMock.fetchFlow.mockResolvedValueOnce({ ok: true, name: 'Current', flow: flow([{ type: 'tcfi_src', label: 'Keep' }]) })
    await act(async () => {
      await latest.tabs.openFlowInActiveTab('Current')
    })
    apiMock.fetchFlow.mockResolvedValueOnce({ ok: true, name: 'Future', flow: flow([{ type: 'tcfi_src' }], { schema_version: 7 }) })
    await act(async () => {
      await expect(latest.tabs.openFlowInActiveTab('Future')).rejects.toThrow(NEWER_SCHEMA_ERROR)
    })
    expect(pipelineOf(0).blocks.map((b) => b.label)).toEqual(['Keep'])
    expect(latest.tabs.tabs[0].label).toBe('Current')
    expect(toastMock.error).toHaveBeenCalledWith('Could not open the flow', { description: NEWER_SCHEMA_ERROR })
  })

  it('does not toast for a clean flow', async () => {
    await mount()
    apiMock.fetchFlow.mockResolvedValue({ ok: true, name: 'Clean', flow: flow([{ type: 'tcfi_src' }]) })
    await act(async () => {
      await latest.tabs.openFlowInActiveTab('Clean')
    })
    expect(toastMock.warning).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalled()
  })
})

describe('openFlowInNewTab', () => {
  it('opens a tab with the unsupported block kept and reports it', async () => {
    await mount()
    apiMock.fetchFlow.mockResolvedValue({ ok: true, name: 'Old', flow: flow([{ type: 'upscale', config: { model: 'x' } }]) })
    await act(async () => {
      await latest.tabs.openFlowInNewTab('Old')
    })
    expect(latest.tabs.tabs).toHaveLength(2)
    expect(pipelineOf(1).blocks[0]).toMatchObject({ type: 'upscale', preserved: { config: { model: 'x' } } })
    expect(toastMock.warning).toHaveBeenCalledTimes(1)
  })

  it('does not create a tab for a refused flow', async () => {
    await mount()
    apiMock.fetchFlow.mockResolvedValue({ ok: true, name: 'Bad', flow: { name: 'no blocks' } })
    await act(async () => {
      await expect(latest.tabs.openFlowInNewTab('Bad')).rejects.toThrow('Invalid flow file: missing blocks array')
    })
    expect(latest.tabs.tabs).toHaveLength(1)
    expect(toastMock.error).toHaveBeenCalledTimes(1)
  })
})

describe('restoreFlowSnapshot (run restore)', () => {
  it('checks the saved references and reports how many could not be found, keeping the flow intact', async () => {
    await mount()
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const refs = JSON.parse(String(init.body)).references as Array<{ local?: string }>
      return new Response(JSON.stringify({ ok: true, results: refs.map((r, index) => ({ index, status: r.local === '/outputs/ok.png' ? 'ok' : 'missing_local', detail: '' })) }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const items = ['ok.png', 'gone1.png', 'gone2.png'].map((l, i) => ({ id: `i${i}`, label: l, local: `/outputs/${l}`, status: 'ready' }))
    let tabId: string | null = null
    act(() => {
      tabId = latest.tabs.restoreFlowSnapshot('Run', flow([
        { type: 'uploadImageToTmpfiles', config: { items } },
        { type: 'imageToImage' },
        { type: 'uploadImageToTmpfiles', config: { items: [{ id: 'r', label: 'gone3.png', local: '/outputs/gone3.png', status: 'ready' }] } },
        { type: 'imageToImage' },
      ], { schema_version: 5 }))
    })
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledWith('3 references in this run could not be found', expect.objectContaining({
      description: 'They are marked on their blocks. Replace or remove them before running.',
    })))
    expect(fetchMock).toHaveBeenCalledWith('/api/generation/check-references', expect.objectContaining({ method: 'POST' }))
    expect(pipelines[tabId!].blocks.map((b) => b.type)).toEqual(['uploadImageToTmpfiles', 'imageToImage', 'uploadImageToTmpfiles', 'imageToImage'])
    vi.unstubAllGlobals()
  })

  it('opens the snapshot with a removed block kept and reports it once', async () => {
    await mount()
    let tabId: string | null = null
    act(() => {
      tabId = latest.tabs.restoreFlowSnapshot('My Run', flow([
        { type: 'tcfi_src' },
        { type: 'comfyGen', config: { prompt: 'a cat', workflow: { '1': {} } } },
      ]))
    })
    expect(tabId).not.toBeNull()
    expect(latest.tabs.activeTabId).toBe(tabId)
    const restored = pipelines[tabId!]
    expect(restored.blocks[1]).toMatchObject({
      type: 'comfyGen',
      preserved: { config: { prompt: 'a cat', workflow: { '1': {} } } },
    })
    expect(toastMock.warning).toHaveBeenCalledWith('1 block in this run is no longer supported', expect.objectContaining({
      description: 'ComfyUI Gen. Remove or disable it before running.',
    }))
  })

  it.each([
    ['null snapshot', null],
    ['empty object', {}],
    ['newer schema', flow([], { schema_version: 7 })],
  ])('returns null and opens nothing for %s', async (_name, snapshot) => {
    await mount()
    let tabId: string | null = 'x'
    act(() => {
      tabId = latest.tabs.restoreFlowSnapshot('Bad Run', snapshot)
    })
    expect(tabId).toBeNull()
    expect(latest.tabs.tabs).toHaveLength(1)
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error.mock.calls[0][0]).toBe('Could not open the run')
  })
})

describe('loadWorkspace', () => {
  it('loads mixed tabs (clean, legacy, unknown) and reports once for the whole workspace', async () => {
    await mount()
    apiMock.fetchFlow.mockResolvedValue({
      ok: true,
      flow: {
        tabs: [
          { label: 'Clean', flow: flow([{ type: 'tcfi_src' }]) },
          { label: 'Legacy', flow: flow([{ type: 'seedance', config: { prompt: 'p' } }]) },
          { label: 'Unknown', flow: flow([{ type: 'tcfi_src', branches: [[{ type: 'mysteryBlock' }]] }], { version: 2 }) },
        ],
      },
    })
    await act(async () => {
      await latest.tabs.loadWorkspace('w')
    })
    await waitFor(() => expect(latest.tabs.tabs).toHaveLength(3))
    expect(latest.tabs.tabs.map((t) => t.label)).toEqual(['Clean', 'Legacy', 'Unknown'])
    expect(pipelineOf(0).blocks.map((b) => b.type)).toEqual(['tcfi_src'])
    expect(pipelineOf(1).blocks[0]).toMatchObject({ type: 'seedance', preserved: { config: { prompt: 'p' } } })
    expect(pipelineOf(2).blocks[0].branches?.[0][0].type).toBe('mysteryBlock')
    expect(toastMock.warning).toHaveBeenCalledTimes(1)
    expect(toastMock.warning).toHaveBeenCalledWith('2 blocks in this workspace are no longer supported', expect.objectContaining({
      description: 'Seedance 2 (PiAPI), mysteryBlock. Remove or disable them before running.',
    }))
  })

  it('refuses the whole workspace when any tab is from a newer schema, leaving tabs untouched', async () => {
    await mount()
    apiMock.fetchFlow.mockResolvedValue({ ok: true, name: 'Current', flow: flow([{ type: 'tcfi_src', label: 'Keep' }]) })
    await act(async () => {
      await latest.tabs.openFlowInActiveTab('Current')
    })
    await act(async () => {
      await latest.tabs.openFlowInNewTab('Current')
    })
    act(() => latest.tabs.setActiveTabId(latest.tabs.tabs[0].id))
    expect(latest.tabs.tabs).toHaveLength(2)
    apiMock.fetchFlow.mockResolvedValueOnce({
      ok: true,
      flow: { tabs: [{ label: 'A', flow: flow([]) }, { label: 'B', flow: flow([], { schema_version: 9 }) }] },
    })
    await act(async () => {
      await expect(latest.tabs.loadWorkspace('w')).rejects.toThrow(NEWER_SCHEMA_ERROR)
    })
    expect(latest.tabs.tabs).toHaveLength(2)
    expect(pipelineOf(0).blocks[0].label).toBe('Keep')
    expect(toastMock.error).toHaveBeenCalledWith('Could not open the workspace', {
      description: `Tab "B": ${NEWER_SCHEMA_ERROR}`,
    })
  })

  it.each([
    ['not an object', 'nope'],
    ['no tabs', {}],
    ['tabs not a list', { tabs: { a: 1 } }],
    ['empty tabs', { tabs: [] }],
    ['tab entry not an object', { tabs: [null] }],
  ])('rejects a malformed workspace (%s) with an error toast and no changes', async (_name, workspace) => {
    await mount()
    apiMock.fetchFlow.mockResolvedValue({ ok: true, flow: workspace })
    await act(async () => {
      await expect(latest.tabs.loadWorkspace('w')).rejects.toThrow()
    })
    expect(latest.tabs.tabs).toHaveLength(1)
    expect(toastMock.error).toHaveBeenCalledTimes(1)
  })
})
