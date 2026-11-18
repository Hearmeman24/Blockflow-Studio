/**
 * An Image Loader holding more images than the downstream model takes: the
 * loader warns, and Run Pipeline is refused with a message that names the
 * loader. Real blocks rendered through BlockCard, the real pipeline runner,
 * fetch mocked at the HTTP boundary with the real catalog fixtures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
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
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { stubGenerationFetch, type Harness } from '@/test-utils/byok-harness'

const images = ['a.png', 'b.png', 'c.png'].map((label, i) => ({ id: `i${i}`, label, local: `/outputs/${label}`, status: 'ready' }))

const captured: { api: ReturnType<typeof usePipeline> | null } = { api: null }
function Canvas() {
  const api = usePipeline()
  useEffect(() => {
    captured.api = api
  })
  return (
    <>
      {api.pipeline.blocks.map((block, i) => <BlockCard key={block.id} block={block} displayNumber={String(i + 1)} />)}
    </>
  )
}

let harness: Harness
let tab = 0
function renderFlow(model: string) {
  const flowJson = JSON.stringify({
    name: 'limits', version: 1, schema_version: 5, created_at: '',
    blocks: [
      { type: 'uploadImageToTmpfiles', label: 'Product shots', config: { items: images } },
      { type: 'imageToVideo', config: { provider: 'kie', model, prompt: 'slow push in' } },
    ],
  })
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PipelineTabsProvider>
        <PipelineProvider tabId={`lli-${++tab}`} flowJson={flowJson}>
          <BlockLayoutProvider>
            <Canvas />
          </BlockLayoutProvider>
        </PipelineProvider>
      </PipelineTabsProvider>
    </SWRConfig>,
  )
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  toastMock.error.mockReset()
  harness = stubGenerationFetch({ catalog: CATALOG_BOTH })
})
afterEach(() => vi.unstubAllGlobals())

describe('loader over the downstream limit', () => {
  it('warns in the loader and refuses the run, naming the loader', async () => {
    renderFlow('kling-4.0-flash')
    expect(await screen.findByText('3 images, but Image to Video · Kling 4.0 Flash takes up to 1. Nothing was removed.')).toBeInTheDocument()
    // The generation block names the loader to fix it in.
    expect(await screen.findByText('Kling 4.0 Flash on Kie accepts at most 1 image; remove 2. Fix it in "Product shots".')).toBeInTheDocument()

    let result: { hadError: boolean } | undefined
    await act(async () => { result = await captured.api!.runPipeline() })
    expect(result?.hadError).toBe(true)
    expect(toastMock.error).toHaveBeenCalledWith(
      'Pipeline not started: "Product shots" holds 3 images; Image to Video · Kling 4.0 Flash takes up to 1. Fix it, then run again.',
    )
    expect(harness.requests('/api/generation/validate')).toHaveLength(0)
    expect(harness.requests('/api/generation/submit')).toHaveLength(0)
  })

  it('names the loader from the generation block too, if its execute is reached', async () => {
    renderFlow('kling-4.0-flash')
    await screen.findByText('3 images, but Image to Video · Kling 4.0 Flash takes up to 1. Nothing was removed.')
    const i2v = captured.api!.pipeline.blocks[1].id
    const loader = captured.api!.pipeline.blocks[0].id
    // Bypass the pre-run guard: emit the loader's images and call the block directly.
    act(() => captured.api!.setBlockOutput(loader, 'image', images.map((i) => ({ kind: 'image-ref', local: i.local, name: i.label }))))
    const inputs = captured.api!.getInputsForBlock(i2v)
    expect(Array.isArray(inputs.image) && inputs.image).toHaveLength(3)
    const { getRunBlockers, clearRunBlockers } = await import('@/lib/pipeline/run-blockers')
    expect(getRunBlockers(loader)).not.toEqual([])
    clearRunBlockers(loader)
    // The loader only republishes when its problems change, so this run starts.
    let result: { hadError: boolean } | undefined
    await act(async () => { result = await captured.api!.runPipeline() })
    expect(result?.hadError).toBe(true)
    await waitFor(() => expect(screen.getByText(/The images come from "Product shots"; fix it there\./)).toBeInTheDocument())
    expect(harness.requests('/api/generation/submit')).toHaveLength(0)
  })

  it('counts frame slots, not the ledger image count, in Image to Video', async () => {
    renderFlow('seedance-2.5')
    await waitFor(() => expect(screen.getByTestId('loader-footer')).toHaveTextContent('3 of 2 · Seedance 2.5'))
    expect(screen.getByText('3 images, but Image to Video · Seedance 2.5 takes up to 2. Nothing was removed.')).toBeInTheDocument()
  })
})
