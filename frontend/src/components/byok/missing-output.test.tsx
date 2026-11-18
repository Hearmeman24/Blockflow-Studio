/**
 * A generation block whose output nothing reads shows a non-blocking warning
 * with a one-click action that adds the matching viewer after it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { SWRConfig } from 'swr'

const toastMock = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))
vi.mock('@/lib/api', () => ({
  saveRun: vi.fn(() => Promise.resolve({ ok: true })),
  fetchFlow: vi.fn(),
  fetchFlows: vi.fn(() => Promise.resolve({ ok: true, flows: [] })),
  saveFlowToDisk: vi.fn(),
}))

import '@/components/pipeline/custom_blocks/_register'
import { BlockCard } from '@/components/pipeline/block-card'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'
import { BlockLayoutProvider } from '@/lib/pipeline/block-layout-context'
import { PipelineProvider, usePipeline } from '@/lib/pipeline/pipeline-context'
import { findRunBlockers } from '@/lib/pipeline/run-blockers'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { walkBlocks } from '@/lib/pipeline/tree-utils'
import { jobSnapshot, stubGenerationFetch } from '@/test-utils/byok-harness'

const captured: { api: ReturnType<typeof usePipeline> | null } = { api: null }
function Canvas() {
  const api = usePipeline()
  useEffect(() => {
    captured.api = api
  })
  return <>{[...walkBlocks(api.pipeline.blocks)].map((block, i) => <BlockCard key={block.id} block={block} displayNumber={String(i + 1)} />)}</>
}

let tab = 0
function renderFlow(blocks: unknown[]) {
  const flowJson = JSON.stringify({ name: 'o', version: 1, schema_version: 5, created_at: '', blocks })
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PipelineTabsProvider>
        <PipelineProvider tabId={`mo-${++tab}`} flowJson={flowJson}>
          <BlockLayoutProvider><Canvas /></BlockLayoutProvider>
        </PipelineProvider>
      </PipelineTabsProvider>
    </SWRConfig>,
  )
}

const t2v = { type: 'textToVideo', config: { provider: 'kie', model: 'seedance-2', prompt: 'a lighthouse' } }

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  toastMock.error.mockReset()
  stubGenerationFetch({ catalog: CATALOG_BOTH, jobs: [jobSnapshot({ status: 'COMPLETED', outputs: [{ kind: 'video', url: 'https://cdn/o.mp4' }] })] })
})
afterEach(() => vi.unstubAllGlobals())

describe('missing output block', () => {
  it('shows a header warning badge whose panel adds a Video Viewer right after the block', async () => {
    renderFlow([t2v])
    const badge = await screen.findByRole('button', { name: '1 warning: No output block' })
    expect(badge.querySelector('svg')).not.toBeNull()
    // Not in the block body.
    expect(screen.queryByText(/No output block\. Add a Video Viewer/)).toBeNull()
    fireEvent.click(badge)
    expect(await screen.findByText('No output block. Add a Video Viewer after this block to see the result.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add Video Viewer' }))
    await waitFor(() => expect(captured.api!.pipeline.blocks.map((b) => b.type)).toEqual(['textToVideo', 'videoViewer']))
    await waitFor(() => expect(screen.queryByRole('button', { name: /warning: No output block/ })).toBeNull())
  })

  it('offers an Image Viewer for image blocks and reappears when the viewer is disabled', async () => {
    renderFlow([{ type: 'textToImage', config: { provider: 'kie', model: 'seedream-5-pro' } }, { type: 'imageViewer' }])
    await screen.findAllByRole('combobox', { name: 'Model' })
    expect(screen.queryByTestId('warning-badge')).toBeNull()
    act(() => captured.api!.toggleBlockDisabled(captured.api!.pipeline.blocks[1].id))
    fireEvent.click(await screen.findByRole('button', { name: '1 warning: No output block' }))
    expect(await screen.findByRole('button', { name: 'Add Image Viewer' })).toBeInTheDocument()
  })

  it('does not block Run Pipeline and is not a run blocker', async () => {
    renderFlow([t2v])
    await screen.findByRole('button', { name: '1 warning: No output block' })
    expect(findRunBlockers(captured.api!.pipeline.blocks)).toEqual([])
    let result: { hadError: boolean } | undefined
    await act(async () => { result = await captured.api!.runPipeline() })
    expect(result?.hadError).toBe(false)
    expect(toastMock.error).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '1 warning: No output block' })).toBeInTheDocument()
  })
})
