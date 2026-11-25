/**
 * Image Viewer and Video Viewer show the actual cost of the output they
 * display, from the generation metadata on the ref, in their bottom row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'
import '@/components/pipeline/custom_blocks/_register'
import { blockDef as imageViewer } from '@/components/pipeline/custom_blocks/generated/image_viewer'
import { blockDef as videoViewer } from '@/components/pipeline/custom_blocks/generated/video_viewer'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'
import { readGenerationMeta } from '@/lib/image-ref'
import { PipelineProvider } from '@/lib/pipeline/pipeline-context'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { blockProps, stubGenerationFetch } from '@/test-utils/byok-harness'

const cost = (amount: number) => ({ amount, unit: 'credits', usd_equivalent: amount / 200 })
const meta = (job: string, c: ReturnType<typeof cost> | null) => ({ job_id: job, provider: 'kie', model: 'seedance-2', cost: c })

let tab = 0
function wrap(children: ReactNode) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PipelineTabsProvider><PipelineProvider tabId={`vc-${++tab}`}>{children}</PipelineProvider></PipelineTabsProvider>
    </SWRConfig>
  )
}

beforeEach(() => {
  sessionStorage.clear()
  stubGenerationFetch({ catalog: CATALOG_BOTH })
})
afterEach(() => vi.unstubAllGlobals())

describe('generation metadata on refs', () => {
  it('reads it when present and ignores plain refs', () => {
    expect(readGenerationMeta({ kind: 'image-ref', local: '/outputs/a.png', meta: meta('j', cost(10)) })).toEqual(meta('j', cost(10)))
    expect(readGenerationMeta({ kind: 'image-ref', local: '/outputs/a.png' })).toBeNull()
    expect(readGenerationMeta('/outputs/a.png')).toBeNull()
    expect(readGenerationMeta({ meta: { job_id: 'j', cost: { amount: 'x' } } })?.cost).toBeNull()
  })
})

describe('Image Viewer cost', () => {
  it('shows the cost of the displayed image in the footer, with a tooltip naming the provider', async () => {
    const user = userEvent.setup()
    const Comp = imageViewer.component
    render(wrap(<Comp {...blockProps('iv1', { image: { kind: 'image-ref', local: '/outputs/a.png', meta: meta('job-1', cost(205)) } })} />))
    const footer = await screen.findByTestId('viewer-footer')
    expect(within(footer).getByRole('link', { name: 'Download a.png' })).toHaveAttribute('title', '/outputs/a.png')
    const label = within(footer).getByTestId('output-cost')
    expect(label).toHaveTextContent('205 credits')
    await user.hover(label)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Reported by Kie for this job')
  })

  it('shows nothing for an image without a cost (loader images, older outputs)', async () => {
    const Comp = imageViewer.component
    render(wrap(<Comp {...blockProps('iv2', { image: { kind: 'image-ref', local: '/outputs/b.png' } })} />))
    await screen.findByTestId('viewer-footer')
    expect(screen.queryByTestId('output-cost')).toBeNull()
  })

  it('updates when the cost arrives after the output', async () => {
    const Comp = imageViewer.component
    const props = blockProps('iv3', { image: { kind: 'image-ref', local: '/outputs/c.png', meta: meta('job-3', null) } })
    const view = render(wrap(<Comp {...props} />))
    await screen.findByTestId('viewer-footer')
    expect(screen.queryByTestId('output-cost')).toBeNull()
    view.rerender(wrap(<Comp {...props} inputs={{ image: { kind: 'image-ref', local: '/outputs/c.png', meta: meta('job-3', cost(12)) } }} />))
    expect(await screen.findByTestId('output-cost')).toHaveTextContent('12 credits')
  })

  it('with several outputs of one job, shows the job cost and says it covers them all', async () => {
    const user = userEvent.setup()
    const Comp = imageViewer.component
    const m = meta('job-4', cost(40))
    render(wrap(<Comp {...blockProps('iv4', { image: [
      { kind: 'image-ref', local: '/outputs/d1.png', meta: m },
      { kind: 'image-ref', local: '/outputs/d2.png', meta: m },
    ] })} />))
    const label = await screen.findByTestId('output-cost')
    expect(label).toHaveTextContent('40 credits')
    await user.hover(label)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Reported by Kie for this job (2 outputs)')
  })
})

const check = (differs: boolean, report_url: string | null = null) => ({
  expected: { amount: 41, unit: 'credits' }, actual: { amount: 50, unit: 'credits' }, source: 'ledger' as const,
  differs, checked_at: '2026-11-15T10:00:00Z', report_url,
})
const REPORT = 'https://github.com/acme/prices/issues/new?title=Kie%20price'
const imageWith = (price_check: ReturnType<typeof check> | undefined) => ({
  kind: 'image-ref', local: '/outputs/p.png', meta: { ...meta('job-p', cost(50)), ...(price_check ? { price_check } : {}) },
})

describe('generation metadata price check', () => {
  it('carries a valid price_check and drops a malformed one', () => {
    expect(readGenerationMeta(imageWith(check(true, REPORT)))?.price_check).toEqual(check(true, REPORT))
    expect(readGenerationMeta({ meta: { ...meta('j', null), price_check: { differs: true } } })?.price_check).toBeUndefined()
  })
})

describe('Image Viewer price mismatch', () => {
  it('shows a labelled marker beside the cost when the charge differs from the price list', async () => {
    const user = userEvent.setup()
    const Comp = imageViewer.component
    render(wrap(<Comp {...blockProps('ip1', { image: imageWith(check(true)) })} />))
    const footer = await screen.findByTestId('viewer-footer')
    const marker = within(footer).getByTestId('warning-badge')
    expect(marker).toHaveTextContent('Price changed')
    expect(marker.querySelector('svg')).not.toBeNull()
    await user.hover(marker)
    const panel = await screen.findByRole('dialog')
    expect(panel).toHaveTextContent(
      'Kie charged 50 credits; the price list expected 41 credits. Future estimates for this model now use the charged price.')
    expect(within(panel).queryByRole('link')).toBeNull()
  })

  it('offers a report link only when the price check has one, opening in a new tab', async () => {
    const user = userEvent.setup()
    const Comp = imageViewer.component
    render(wrap(<Comp {...blockProps('ip2', { image: imageWith(check(true, REPORT)) })} />))
    await user.hover(await screen.findByTestId('warning-badge'))
    const link = within(await screen.findByRole('dialog')).getByRole('link', { name: 'Report price change' })
    expect(link).toHaveAttribute('href', REPORT)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('shows nothing extra when the charge matches or there is no price check', async () => {
    const Comp = imageViewer.component
    const view = render(wrap(<Comp {...blockProps('ip3', { image: imageWith(check(false, REPORT)) })} />))
    expect(await screen.findByTestId('output-cost')).toHaveTextContent('50 credits')
    expect(screen.queryByTestId('warning-badge')).toBeNull()
    view.unmount()
    render(wrap(<Comp {...blockProps('ip4', { image: imageWith(undefined) })} />))
    expect(await screen.findByTestId('output-cost')).toHaveTextContent('50 credits')
    expect(screen.queryByTestId('warning-badge')).toBeNull()
  })
})

describe('Video Viewer cost', () => {
  it('shows the price mismatch marker for a video whose charge differs', async () => {
    const Comp = videoViewer.component
    render(wrap(<Comp {...blockProps('vp1', { video: {
      kind: 'video-ref', local: '/outputs/p.mp4', meta: { ...meta('job-v', cost(50)), price_check: check(true, REPORT) },
    } })} />))
    const footer = await screen.findByTestId('viewer-footer')
    expect(within(footer).getByTestId('warning-badge')).toHaveTextContent('Price changed')
  })

  it('displays a video ref and its cost', async () => {
    const Comp = videoViewer.component
    render(wrap(<Comp {...blockProps('vv1', { video: { kind: 'video-ref', local: '/outputs/v.mp4', meta: meta('job-5', cost(300)) } })} />))
    const footer = await screen.findByTestId('viewer-footer')
    expect(within(footer).getByRole('link', { name: 'Download v.mp4' })).toHaveAttribute('title', '/outputs/v.mp4')
    expect(within(footer).getByTestId('output-cost')).toHaveTextContent('300 credits')
  })

  it('shows nothing for a video without a cost', async () => {
    const Comp = videoViewer.component
    render(wrap(<Comp {...blockProps('vv2', { video: ['/outputs/old.mp4'] })} />))
    await screen.findByTestId('viewer-footer')
    expect(screen.queryByTestId('output-cost')).toBeNull()
  })
})
