/**
 * Block card layout: the border and header chip come from the block's role,
 * the card is as tall as its content (auto and expanded layouts; reduced keeps
 * its fixed height), and a media loader narrows to the md width while no media
 * section holds more than two items.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SWRConfig } from 'swr'
import '@/components/pipeline/custom_blocks/_register'
import { BlockCard } from '@/components/pipeline/block-card'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'
import { OMNI_LOADER_KEYS } from '@/lib/byok/loader-items'
import { BlockLayoutProvider, type BlockLayoutMode } from '@/lib/pipeline/block-layout-context'
import { blockRoleStyle } from '@/lib/pipeline/block-role'
import { PipelineProvider, usePipeline } from '@/lib/pipeline/pipeline-context'
import { registerBlockDef, type BlockComponentProps, type NodeSize } from '@/lib/pipeline/registry'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { useMediaItemCount } from '@/lib/pipeline/use-media-item-count'
import type { PipelineBlock } from '@/lib/pipeline/types'
import { stubGenerationFetch } from '@/test-utils/byok-harness'

const LAYOUT_KEY = 'pipeline_block_layout_mode_v1'
const WIDTH: Record<NodeSize, string> = { sm: 'w-[280px]', md: 'w-[360px]', lg: 'w-[440px]', huge: 'w-[540px]' }

/** Item counts per media section that the stub loader reports, by block id. */
const counts: Record<string, number[]> = {}

function StubLoader({ blockId, setMediaItemCount }: BlockComponentProps) {
  useMediaItemCount(setMediaItemCount, counts[blockId] ?? [])
  return <div>stub loader</div>
}

beforeAll(() => {
  for (const size of ['sm', 'md', 'lg', 'huge'] as const) {
    registerBlockDef({
      type: `layoutStub_${size}`, label: `Stub ${size}`, description: 'stub', size, role: 'video',
      canStart: true, inputs: [], outputs: [], component: () => <div>stub</div>,
    })
    registerBlockDef({
      type: `layoutLoader_${size}`, label: `Loader ${size}`, description: 'stub', size, role: 'loader',
      canStart: true, inputs: [], outputs: [{ name: 'image', kind: 'image' }], component: StubLoader,
    })
  }
  registerBlockDef({
    type: 'layoutInferred', label: 'Inferred', description: 'stub', size: 'sm',
    canStart: true, inputs: [{ name: 'text', kind: 'text' }], outputs: [{ name: 'text', kind: 'text' }], component: () => null,
  })
})

let tab = 0
function renderCard(block: PipelineBlock, mode: BlockLayoutMode = 'expanded') {
  sessionStorage.setItem(LAYOUT_KEY, mode)
  return render(
    <PipelineTabsProvider>
      <PipelineProvider tabId={`layout-${++tab}`}>
        <BlockLayoutProvider>
          <BlockCard block={block} displayNumber="1" />
        </BlockLayoutProvider>
      </PipelineProvider>
    </PipelineTabsProvider>,
  )
}

const card = (container: HTMLElement) => container.querySelector('[data-slot="card"]') as HTMLElement
const classes = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/)

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

describe('role colour on the block card', () => {
  it('colours the border by role, not by size, and shows the role chip next to the title', () => {
    for (const size of ['sm', 'huge'] as const) {
      const { container, unmount } = renderCard({ id: `r-${size}`, type: `layoutStub_${size}` })
      const el = card(container)
      expect(el).toHaveAttribute('data-role', 'video')
      expect(classes(el)).toContain(blockRoleStyle('video').border)
      for (const old of ['border-emerald-500/25', 'border-violet-500/25', 'border-amber-500/25']) expect(classes(el)).not.toContain(old)
      const chip = el.querySelector('[data-slot="card-header"] [data-slot="block-role-tile"]')
      expect(chip).toHaveAttribute('data-role', 'video')
      unmount()
    }
  })

  it('uses the port-inferred role for a block that declares none, also when disabled', () => {
    const { container } = renderCard({ id: 'inf', type: 'layoutInferred', disabled: true })
    expect(card(container)).toHaveAttribute('data-role', 'prompt')
    expect(classes(card(container))).toContain(blockRoleStyle('prompt').border)
  })

  it('keeps the selection ring separate from the role colour', () => {
    const { container } = renderCard({ id: 'sel', type: 'layoutStub_sm' })
    expect(classes(card(container)).some((c) => c.startsWith('ring-'))).toBe(false)
  })
})

describe('card height follows the content', () => {
  it.each(['auto', 'expanded'] as const)('%s layout: no fixed minimum height, enabled or disabled', (mode) => {
    for (const size of ['sm', 'md', 'lg', 'huge'] as const) {
      for (const disabled of [false, true]) {
        const { container, unmount } = renderCard({ id: `h-${size}`, type: `layoutStub_${size}`, disabled }, mode)
        const el = card(container)
        expect(classes(el).filter((c) => c.startsWith('min-h-')), `${size} ${disabled}`).toEqual([])
        expect(classes(el).filter((c) => /^h-\[/.test(c)), `${size} ${disabled}`).toEqual([])
        expect(classes(el)).toContain(WIDTH[size])
        unmount()
      }
    }
  })

  it('auto layout keeps the viewport cap and scrolls inside', () => {
    const { container } = renderCard({ id: 'cap', type: 'layoutStub_lg' }, 'auto')
    expect(classes(card(container))).toEqual(expect.arrayContaining(['max-h-[85vh]', 'overflow-hidden']))
    expect(classes(container.querySelector('[data-slot="card-content"]'))).toContain('overflow-y-auto')
  })

  it('reduced layout is unchanged: fixed height per size', () => {
    const fixed = { sm: '220px', md: '320px', lg: '460px', huge: '580px' }
    for (const size of ['sm', 'md', 'lg', 'huge'] as const) {
      const { container, unmount } = renderCard({ id: `rd-${size}`, type: `layoutStub_${size}` }, 'reduced')
      expect(classes(card(container))).toEqual(expect.arrayContaining([`min-h-[${fixed[size]}]`, `h-[${fixed[size]}]`, 'overflow-hidden']))
      unmount()
    }
  })
})

describe('media loader width steps with its content', () => {
  it.each([
    ['empty', [], 'md'],
    ['one item', [1], 'md'],
    ['two items in each section', [2, 2, 0], 'md'],
    ['three items in one section', [0, 3, 1], 'huge'],
  ] as const)('huge loader, %s', (_name, sectionCounts, expected) => {
    counts.w = [...sectionCounts]
    const { container } = renderCard({ id: 'w', type: 'layoutLoader_huge' })
    expect(classes(card(container))).toContain(WIDTH[expected])
    expect(classes(card(container))).not.toContain(WIDTH[expected === 'md' ? 'huge' : 'md'])
  })

  it('never widens a loader past its declared size', () => {
    counts.sm = [5]
    const { container: wide } = renderCard({ id: 'sm', type: 'layoutLoader_sm' })
    expect(classes(card(wide))).toContain(WIDTH.sm)
    counts.sm = [1]
    const { container: narrow } = renderCard({ id: 'sm', type: 'layoutLoader_sm' })
    expect(classes(card(narrow))).toContain(WIDTH.sm)
  })

  it('blocks that do not report media keep their declared width', () => {
    const { container } = renderCard({ id: 'plain', type: 'layoutStub_huge' })
    expect(classes(card(container))).toContain(WIDTH.huge)
  })
})

describe('the real loaders report their media', () => {
  afterEach(() => vi.unstubAllGlobals())

  function Canvas() {
    const { pipeline } = usePipeline()
    return <>{pipeline.blocks.map((b, i) => <BlockCard key={b.id} block={b} displayNumber={String(i + 1)} />)}</>
  }

  function renderFlow(type: string, config?: Record<string, unknown>) {
    stubGenerationFetch({ catalog: CATALOG_BOTH })
    sessionStorage.setItem(LAYOUT_KEY, 'expanded')
    const flowJson = JSON.stringify({ name: 'f', version: 1, schema_version: 6, created_at: '', blocks: [{ type, ...(config ? { config } : {}) }] })
    return render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <PipelineTabsProvider>
          <PipelineProvider tabId={`real-${++tab}`} flowJson={flowJson}>
            <BlockLayoutProvider><Canvas /></BlockLayoutProvider>
          </PipelineProvider>
        </PipelineTabsProvider>
      </SWRConfig>,
    )
  }

  const items = (n: number, kind: string) => Array.from({ length: n }, (_, i) => ({
    id: `${kind}-${i}`, label: `${kind}-${i}`, local: `/outputs/${kind}-${i}.png`, status: 'ready',
  }))

  it('Omni Reference Loader (huge) is narrow with two images, wide with three', async () => {
    const { container, unmount } = renderFlow('omniReferenceLoader', { [OMNI_LOADER_KEYS.image]: items(2, 'image') })
    await screen.findAllByTestId('loader-item')
    expect(classes(card(container))).toContain(WIDTH.md)
    unmount()

    const wide = renderFlow('omniReferenceLoader', { [OMNI_LOADER_KEYS.image]: items(3, 'image') })
    await screen.findAllByTestId('loader-item')
    expect(classes(card(wide.container))).toContain(WIDTH.huge)
  })
})
