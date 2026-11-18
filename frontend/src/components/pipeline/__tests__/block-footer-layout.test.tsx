/**
 * Every block's body is a full-height flex column, so a footer strip
 * (BlockFooter, `mt-auto`) sits on the card's bottom edge instead of floating
 * mid-card. Checked through the real BlockCard and the real loader blocks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SWRConfig } from 'swr'
import '@/components/pipeline/custom_blocks/_register'
import { BlockCard } from '@/components/pipeline/block-card'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'
import { BlockLayoutProvider } from '@/lib/pipeline/block-layout-context'
import { PipelineProvider, usePipeline } from '@/lib/pipeline/pipeline-context'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { stubGenerationFetch } from '@/test-utils/byok-harness'

function Canvas() {
  const { pipeline } = usePipeline()
  return <>{pipeline.blocks.map((b, i) => <BlockCard key={b.id} block={b} displayNumber={String(i + 1)} />)}</>
}

let tab = 0
function renderBlock(type: string) {
  const flowJson = JSON.stringify({ name: 'f', version: 1, schema_version: 5, created_at: '', blocks: [{ type }] })
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PipelineTabsProvider>
        <PipelineProvider tabId={`bf-${++tab}`} flowJson={flowJson}>
          <BlockLayoutProvider><Canvas /></BlockLayoutProvider>
        </PipelineProvider>
      </PipelineTabsProvider>
    </SWRConfig>,
  )
}

const classes = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/)

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  stubGenerationFetch({ catalog: CATALOG_BOTH })
})
afterEach(() => vi.unstubAllGlobals())

describe('footer strips sit on the bottom edge of the card', () => {
  it.each([['uploadImageToTmpfiles'], ['videoLoader'], ['omniReferenceLoader']])('%s', async (type) => {
    const { container } = renderBlock(type)
    await screen.findAllByTestId('loader-footer')
    const body = container.querySelector('[data-slot="block-body"]')!
    expect(classes(body)).toEqual(expect.arrayContaining(['flex', 'flex-1', 'flex-col', '*:flex-1']))
    expect(classes(body.parentElement)).toEqual(expect.arrayContaining(['flex', 'flex-1', 'flex-col']))
    // The body makes the block's root (its only child) a flex column, whatever classes the block sets.
    expect(body.children).toHaveLength(1)
    expect(classes(body)).toEqual(expect.arrayContaining(['*:flex', '*:flex-col']))
    for (const footer of container.querySelectorAll('[data-slot="block-footer"]')) {
      expect(classes(footer)).toContain('mt-auto')
      // A footer pins to the bottom only as an item of a flex column: the root, or a section that is one.
      expect(footer.parentElement === body.firstElementChild || classes(footer.parentElement).includes('flex-col')).toBe(true)
    }
  })
})
