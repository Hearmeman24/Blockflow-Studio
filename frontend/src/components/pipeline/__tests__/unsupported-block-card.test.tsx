import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'

const toastMock = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

import { PipelineProvider, usePipeline } from '@/lib/pipeline/pipeline-context'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { BlockLayoutProvider } from '@/lib/pipeline/block-layout-context'
import { UNKNOWN_BLOCK_REASON } from '@/lib/pipeline/legacy-blocks'
import { BlockCard } from '../block-card'
import { MAX_DISPLAY_CHARS } from '../unsupported-block-card'
import type { Pipeline } from '@/lib/pipeline/types'

// Latest pipeline, captured after each commit.
const current: { pipeline: Pipeline } = { pipeline: { id: 'x', blocks: [] } }

function Canvas({ flow }: { flow: unknown }) {
  const ctx = usePipeline()
  const { importFlowJson, pipeline } = ctx
  useEffect(() => {
    current.pipeline = pipeline
  }, [pipeline])
  useEffect(() => {
    importFlowJson(JSON.stringify(flow))
  }, [flow, importFlowJson])
  return (
    <>
      {ctx.pipeline.blocks.map((block, i) => (
        <BlockCard key={block.id} block={block} displayNumber={String(i + 1)} />
      ))}
    </>
  )
}

let tabCounter = 0
function renderFlow(blocks: unknown[]) {
  const flow = { name: 'f', version: 1, created_at: '', blocks }
  return render(
    <PipelineTabsProvider>
      <PipelineProvider tabId={`ubc-${++tabCounter}`}>
        <BlockLayoutProvider>
          <Canvas flow={flow} />
        </BlockLayoutProvider>
      </PipelineProvider>
    </PipelineTabsProvider>,
  )
}

const writeText = vi.fn()

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  toastMock.success.mockReset()
  toastMock.error.mockReset()
  writeText.mockReset()
  writeText.mockResolvedValue(undefined)
})

// user-event installs its own clipboard stub on setup; install ours afterwards.
function setupUser() {
  const user = userEvent.setup()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  return user
}

describe('UnsupportedBlockCard', () => {
  it('renders instead of nothing, with label, type, reason and an accessible name', () => {
    renderFlow([{ type: 'comfyGen', label: 'My old gen' }])
    const card = screen.getByRole('group', { name: 'Unsupported block: My old gen' })
    expect(within(card).getByText('My old gen')).toBeInTheDocument()
    expect(within(card).getByText('comfyGen')).toBeInTheDocument()
    expect(within(card).getByText('ComfyUI generation was removed in this version.')).toBeInTheDocument()
    // Warning is conveyed in text, not colour alone.
    expect(within(card).getByText('Unsupported block')).toBeInTheDocument()
  })

  it('uses the legacy label when the block was not renamed', () => {
    renderFlow([{ type: 'loraTrain' }])
    expect(screen.getByRole('group', { name: 'Unsupported block: LoRA Train' })).toBeInTheDocument()
  })

  it('uses the generic reason for unknown types', () => {
    renderFlow([{ type: 'mysteryBlock' }])
    expect(screen.getByText(UNKNOWN_BLOCK_REASON)).toBeInTheDocument()
  })

  it('shows saved prompt text read-only and copies the full text', async () => {
    const user = setupUser()
    renderFlow([{ type: 'seedance', config: { prompt: 'a red fox\nin snow ✓', negative_prompt: 'blurry', mode: 'pro' } }])
    const prompt = screen.getByRole('textbox', { name: 'Saved Prompt' }) as HTMLTextAreaElement
    expect(prompt.value).toBe('a red fox\nin snow ✓')
    expect(prompt).toHaveAttribute('readonly')
    expect(screen.getByRole('textbox', { name: 'Saved Negative prompt' })).toHaveValue('blurry')
    expect(screen.queryByText('pro')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Copy Prompt' }))
    expect(writeText).toHaveBeenCalledWith('a red fox\nin snow ✓')
    expect(toastMock.success).toHaveBeenCalledWith('Copied to clipboard')
  })

  it('reports a failed copy instead of throwing', async () => {
    const user = setupUser()
    writeText.mockRejectedValue(new Error('denied'))
    renderFlow([{ type: 'seedance', config: { prompt: 'x' } }])
    await user.click(screen.getByRole('button', { name: 'Copy Prompt' }))
    expect(toastMock.error).toHaveBeenCalledWith('Could not copy to the clipboard')
  })

  it('truncates huge text for display but copies all of it', async () => {
    const user = setupUser()
    const huge = 'y'.repeat(MAX_DISPLAY_CHARS + 500)
    renderFlow([{ type: 'comfyGen', config: { prompt: huge } }])
    const prompt = screen.getByRole('textbox', { name: 'Saved Prompt' }) as HTMLTextAreaElement
    expect(prompt.value).toHaveLength(MAX_DISPLAY_CHARS)
    expect(screen.getByText(/Showing the first/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy Prompt' }))
    expect(writeText.mock.calls[0][0]).toHaveLength(MAX_DISPLAY_CHARS + 500)
  })

  it.each([
    ['null values', { prompt: null, text: undefined }],
    ['nested objects', { prompt: { a: { b: [1, 2, { c: 'd' }] } } }],
    ['numbers and booleans', { prompt: 3, text: true }],
    ['array of mixed values', { prompts: [null, 1, { x: 1 }, ['nested']] }],
  ])('does not throw on odd config values (%s)', (_name, config) => {
    expect(() => renderFlow([{ type: 'comfyGen', config }])).not.toThrow()
    expect(screen.getByRole('group', { name: 'Unsupported block: ComfyUI Gen' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('says how many saved settings are kept', () => {
    renderFlow([{ type: 'comfyGen', config: { a: 1, b: 2, prompt: 'p' } }])
    expect(screen.getByText('Its 3 saved settings are kept and saved with the flow.')).toBeInTheDocument()
  })

  it('Remove block removes it through the normal block-removal path', async () => {
    const user = setupUser()
    renderFlow([{ type: 'comfyGen' }, { type: 'loraTrain' }])
    expect(current.pipeline.blocks).toHaveLength(2)
    await user.click(within(screen.getByRole('group', { name: 'Unsupported block: ComfyUI Gen' })).getByRole('button', { name: 'Remove block' }))
    expect(current.pipeline.blocks.map((b) => b.type)).toEqual(['loraTrain'])
    expect(screen.queryByRole('group', { name: 'Unsupported block: ComfyUI Gen' })).toBeNull()
  })

  it('can be disabled and re-enabled so it no longer blocks a run', async () => {
    const user = setupUser()
    renderFlow([{ type: 'comfyGen' }])
    await user.click(screen.getByRole('button', { name: 'Disable block' }))
    expect(current.pipeline.blocks[0].disabled).toBe(true)
    expect(screen.getByText(/Disabled\. It is skipped when the pipeline runs\./)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Enable block' }))
    expect(current.pipeline.blocks[0].disabled).toBe(false)
  })

  it('is keyboard reachable: the card, copy and remove actions take focus in order', async () => {
    const user = setupUser()
    renderFlow([{ type: 'seedance', config: { prompt: 'p' } }])
    const card = screen.getByRole('group', { name: 'Unsupported block: Seedance 2 (PiAPI)' })
    act(() => card.focus())
    expect(card).toHaveFocus()
    const focusOrder: (string | null)[] = []
    for (let i = 0; i < 5; i++) {
      await user.tab()
      focusOrder.push(document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? null)
    }
    expect(focusOrder).toEqual(expect.arrayContaining(['Disable block', 'Remove block', 'Saved Prompt', 'Copy Prompt']))
  })

  it('Enter on Remove block removes it', async () => {
    const user = setupUser()
    renderFlow([{ type: 'comfyGen' }])
    act(() => screen.getByRole('button', { name: 'Remove block' }).focus())
    await user.keyboard('{Enter}')
    expect(current.pipeline.blocks).toHaveLength(0)
  })
})
