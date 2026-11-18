/**
 * The upstream prompt switch of the generation blocks. It turns on by itself
 * when a prompt source becomes wired upstream (no source -> a source), keeps a
 * choice the user makes afterwards, and goes back to the block's own prompt box
 * when the source is removed. While it is on, the block shows where the prompt
 * comes from instead of the prompt box.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
import { exportFlow } from '@/lib/pipeline/flow-io'
import { PipelineProvider, usePipeline } from '@/lib/pipeline/pipeline-context'
import { getBlockDef } from '@/lib/pipeline/registry'
import { findRunBlockers } from '@/lib/pipeline/run-blockers'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { walkBlocks } from '@/lib/pipeline/tree-utils'
import { blockProps, jobSnapshot, latestExecute, renderGenerationBlock, stubGenerationFetch } from '@/test-utils/byok-harness'

const DONE = jobSnapshot({ status: 'COMPLETED', outputs: [{ kind: 'image', url: 'https://cdn/out.png' }] })

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
  const flowJson = JSON.stringify({ name: 'u', version: 1, schema_version: 6, created_at: '', blocks })
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PipelineTabsProvider>
        <PipelineProvider tabId={`up-${++tab}`} flowJson={flowJson}>
          <BlockLayoutProvider><Canvas /></BlockLayoutProvider>
        </PipelineProvider>
      </PipelineTabsProvider>
    </SWRConfig>,
  )
}

const api = () => captured.api!
const blockIdOf = (type: string) => api().pipeline.blocks.find((b) => b.type === type)!.id
const t2i = (config: Record<string, unknown> = {}) => ({ type: 'textToImage', config: { provider: 'kie', model: 'seedream-5-pro', ...config } })
const SWITCH = 'Use the upstream prompt'

async function generationBlock() {
  return within((await screen.findAllByTestId('generation-block'))[0])
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  toastMock.error.mockReset()
  stubGenerationFetch({ catalog: CATALOG_BOTH })
})
afterEach(() => vi.unstubAllGlobals())

describe('upstream prompt switch in a pipeline', () => {
  it('a generation block added after a Prompt Writer starts with the switch on and names the source', async () => {
    renderFlow([{ type: 'promptWriter' }])
    await waitFor(() => expect(captured.api).not.toBeNull())
    act(() => { api().insertBlockAdjacent(blockIdOf('promptWriter'), 'after', 'textToImage') })
    const block = await generationBlock()
    expect(await block.findByText('Uses the prompt from 1 · Prompt Writer')).toBeInTheDocument()
    expect(block.getByRole('switch', { name: SWITCH })).toBeChecked()
    // The prompt box and everything that belongs to it is gone while the switch is on.
    expect(block.queryByRole('textbox', { name: 'Generation Prompt' })).toBeNull()
    expect(block.queryByRole('button', { name: 'Saved generation prompts' })).toBeNull()
    expect(block.queryByText(/characters$/)).toBeNull()
    await waitFor(() => expect(sessionStorage.getItem(`block_${blockIdOf('textToImage')}_use_upstream_prompt`)).toBe('true'))
  })

  it('inserting a Prompt Writer before an existing block turns it on; off keeps the own prompt; removal and re-adding', async () => {
    const user = userEvent.setup()
    renderFlow([t2i({ prompt: 'my own words' })])
    let block = await generationBlock()
    expect(await block.findByRole('textbox', { name: 'Generation Prompt' })).toHaveValue('my own words')
    expect(block.queryByRole('switch', { name: SWITCH })).toBeNull()

    act(() => { api().insertBlockAdjacent(blockIdOf('textToImage'), 'before', 'promptWriter') })
    block = await generationBlock()
    expect(await block.findByText('Uses the prompt from 1 · Prompt Writer')).toBeInTheDocument()
    expect(block.queryByRole('textbox', { name: 'Generation Prompt' })).toBeNull()

    // The user turns it off: their own prompt comes back, and the choice is kept.
    await user.click(block.getByRole('switch', { name: SWITCH }))
    expect(await block.findByRole('textbox', { name: 'Generation Prompt' })).toHaveValue('my own words')
    expect(block.getByRole('switch', { name: SWITCH })).not.toBeChecked()
    expect(exportFlow(api().pipeline, 'f').blocks.find((b) => b.type === 'textToImage')?.config?.use_upstream_prompt).toBe(false)

    // Source removed: back to the block's own prompt box, no switch.
    act(() => { api().removeBlock(blockIdOf('promptWriter')) })
    await waitFor(() => expect(block.queryByRole('switch', { name: SWITCH })).toBeNull())
    expect(block.getByRole('textbox', { name: 'Generation Prompt' })).toHaveValue('my own words')

    // Source added again: a new transition, so the switch turns on again.
    act(() => { api().insertBlockAdjacent(blockIdOf('textToImage'), 'before', 'promptFromTxt') })
    expect(await block.findByText('Uses the prompt from 1 · Prompt From Txt')).toBeInTheDocument()
    expect(block.getByRole('switch', { name: SWITCH })).toBeChecked()
  })

  it('a flow saved with the switch off and a source already wired stays off', async () => {
    renderFlow([{ type: 'promptWriter' }, t2i({ prompt: 'kept', use_upstream_prompt: false })])
    const block = await generationBlock()
    expect(await block.findByRole('textbox', { name: 'Generation Prompt' })).toHaveValue('kept')
    expect(block.getByRole('switch', { name: SWITCH })).not.toBeChecked()
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(block.getByRole('switch', { name: SWITCH })).not.toBeChecked()
  })

  it('a flow saved with the switch on stays on', async () => {
    renderFlow([{ type: 'promptWriter' }, t2i({ prompt: 'kept', use_upstream_prompt: true })])
    const block = await generationBlock()
    expect(await block.findByText('Uses the prompt from 1 · Prompt Writer')).toBeInTheDocument()
  })

  it('a Prompt Writer that has not run yet does not block Run Pipeline for an empty prompt', async () => {
    renderFlow([{ type: 'promptWriter' }, t2i()])
    const block = await generationBlock()
    await block.findByText('Uses the prompt from 1 · Prompt Writer')
    expect(findRunBlockers(api().pipeline.blocks)).toEqual([])
    expect(block.queryByText('Fix before running')).toBeNull()
  })
})

describe('upstream prompt at run time', () => {
  function mountT2I(id: string, values: Record<string, unknown>, producer = true) {
    for (const [k, v] of Object.entries(values)) sessionStorage.setItem(`block_${id}_${k}`, JSON.stringify(v))
    const props = { ...blockProps(id), hasUpstreamProducer: vi.fn(() => producer) }
    renderGenerationBlock(getBlockDef('textToImage')!.component, props)
    return props
  }

  it('a reload (stored choice off, source wired) keeps the switch off', async () => {
    mountT2I('r1', { provider: 'kie', model: 'seedream-5-pro', prompt: 'mine', use_upstream_prompt: false })
    expect(await screen.findByRole('textbox', { name: 'Generation Prompt' })).toHaveValue('mine')
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.getByRole('switch', { name: SWITCH })).not.toBeChecked()
    expect(sessionStorage.getItem('block_r1_use_upstream_prompt')).toBe('false')
  })

  it('sends the upstream text it is given, not the own prompt kept in state', async () => {
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH, jobs: [DONE] })
    const props = mountT2I('r2', { provider: 'kie', model: 'seedream-5-pro', prompt: 'mine' })
    await screen.findByText('Uses the prompt from the upstream block')
    await act(async () => { await latestExecute(props)({ text: 'written upstream' }, new AbortController().signal) })
    expect(harness.requests('/api/generation/submit')[0]).toMatchObject({ params: { prompt: 'written upstream' } })
  })

  it('an empty upstream prompt is a readable error that says where it came from', async () => {
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH })
    const props = mountT2I('r3', { provider: 'kie', model: 'seedream-5-pro', prompt: 'mine' })
    await screen.findByText('Uses the prompt from the upstream block')
    await expect(latestExecute(props)({ text: '   ' }, new AbortController().signal))
      .rejects.toThrow('The prompt from the upstream block is empty. Check that block, or turn off "Use the upstream prompt" and write one here.')
    expect(harness.requests('/api/generation/submit')).toHaveLength(0)
  })

  it('an over-long upstream prompt is a readable error with the limit', async () => {
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH })
    const props = mountT2I('r4', { provider: 'kie', model: 'seedream-5-pro' })
    await screen.findByText('Uses the prompt from the upstream block')
    await expect(latestExecute(props)({ text: 'x'.repeat(5001) }, new AbortController().signal))
      .rejects.toThrow('The prompt from the upstream block is 5,001 characters; Seedream 5 Pro on Kie takes up to 5,000. Shorten it in that block, or turn off "Use the upstream prompt".')
    expect(harness.requests('/api/generation/submit')).toHaveLength(0)
  })

  it('switching off sends the own prompt again', async () => {
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH, jobs: [DONE] })
    const user = userEvent.setup()
    const props = mountT2I('r5', { provider: 'kie', model: 'seedream-5-pro', prompt: 'mine' })
    await user.click(await screen.findByRole('switch', { name: SWITCH }))
    expect(await screen.findByRole('textbox', { name: 'Generation Prompt' })).toHaveValue('mine')
    await act(async () => { await latestExecute(props)({ text: 'written upstream' }, new AbortController().signal) })
    expect(harness.requests('/api/generation/submit')[0]).toMatchObject({ params: { prompt: 'mine' } })
  })
})
