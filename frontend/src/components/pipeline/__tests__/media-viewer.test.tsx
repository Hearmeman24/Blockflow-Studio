/**
 * Image Viewer and Video Viewer are built around the output: the media takes
 * its own shape across the block (no fixed box around it), the "n / N"
 * counter and an "Open full screen" button sit on the media, and one thin
 * bottom row holds the earlier outputs, the cost, Clear and an icon Download
 * link (the file path is its tooltip). The full-screen view is a Dialog that
 * shares the block's selection: arrows and buttons browse, Esc closes and
 * focus returns to the pop-out button. A video in the block pauses while the
 * full-screen view is open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'
import '@/components/pipeline/custom_blocks/_register'
import { blockDef as imageViewer } from '@/components/pipeline/custom_blocks/generated/image_viewer'
import { blockDef as videoViewer } from '@/components/pipeline/custom_blocks/generated/video_viewer'
import { stepSelection } from '@/components/pipeline/media-lightbox'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'
import { PipelineProvider } from '@/lib/pipeline/pipeline-context'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { blockProps, stubGenerationFetch } from '@/test-utils/byok-harness'

let tab = 0
beforeEach(() => {
  sessionStorage.clear()
  stubGenerationFetch({ catalog: CATALOG_BOTH })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mount(def: typeof imageViewer, port: string, value: unknown) {
  const Comp = def.component
  const tabId = `mv-${++tab}`
  const wrap = (children: ReactNode) => (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PipelineTabsProvider><PipelineProvider tabId={tabId}>{children}</PipelineProvider></PipelineTabsProvider>
    </SWRConfig>
  )
  const props = blockProps(`mv-block-${tab}`, { [port]: value })
  const view = render(wrap(<Comp {...props} />))
  return { ...view, show: (next: unknown) => view.rerender(wrap(<Comp {...props} inputs={{ [port]: next }} />)) }
}

const cases = [
  { name: 'Image Viewer', def: imageViewer, port: 'image', ext: 'png', noun: 'image', select: 'Select image' },
  { name: 'Video Viewer', def: videoViewer, port: 'video', ext: 'mp4', noun: 'video', select: 'Select video' },
] as const

/** The large media element in the block (not a strip thumbnail). */
function blockMedia(noun: string): HTMLElement {
  const frame = screen.getByTestId('media-frame')
  return frame.querySelector(noun === 'image' ? 'img' : 'video') as HTMLElement
}

/** Fires the event that tells the frame the media's natural size. */
function reportSize(noun: string, el: HTMLElement, width: number, height: number) {
  if (noun === 'image') {
    Object.defineProperty(el, 'naturalWidth', { configurable: true, value: width })
    Object.defineProperty(el, 'naturalHeight', { configurable: true, value: height })
    fireEvent.load(el)
  } else {
    Object.defineProperty(el, 'videoWidth', { configurable: true, value: width })
    Object.defineProperty(el, 'videoHeight', { configurable: true, value: height })
    fireEvent.loadedMetadata(el)
  }
}

describe('stepSelection', () => {
  it.each([
    [0, -1, 3, 0],
    [0, 1, 3, 1],
    [1, 1, 3, 2],
    [2, 1, 3, 2],
    [2, -1, 3, 1],
    [0, 1, 1, 0],
    [0, -1, 0, 0],
    [7, -1, 3, 1],
  ])('from %i by %i of %i -> %i', (from, delta, length, to) => {
    expect(stepSelection(from, delta, length)).toBe(to)
  })
})

describe.each(cases)('$name in the block', ({ def, port, ext, noun, select }) => {
  const url = (n: string) => `/outputs/${n}.${ext}`

  it('takes the media\'s own aspect ratio, a wide one and a tall one, with no fixed-height box', () => {
    mount(def, port, [url('wide')])
    const frame = screen.getByTestId('media-frame')
    reportSize(noun, blockMedia(noun), 2100, 900)
    expect(Number(frame.style.getPropertyValue('--media-ratio'))).toBeCloseTo(2100 / 900, 4)
    expect(frame.className).toContain('aspect-(--media-ratio)')
    // The width follows the ratio, capped so a tall item cannot make the card enormous.
    expect(frame.className).toMatch(/w-\[min\(100%,calc\(\S+\*var\(--media-ratio\)\)\)\]/)
    // No fixed or minimum height on the frame or its wrappers up to the block root.
    for (let el: HTMLElement | null = frame; el && !el.hasAttribute('data-viewer-root'); el = el.parentElement) {
      expect(el.className).not.toMatch(/(^|\s)(min-)?h-(\[|\d)/)
    }
    reportSize(noun, blockMedia(noun), 1080, 1920)
    expect(Number(frame.style.getPropertyValue('--media-ratio'))).toBeCloseTo(1080 / 1920, 4)
  })

  it('overlays the counter and the pop-out button on the media', () => {
    mount(def, port, [url('a'), url('b'), url('c')])
    const frame = screen.getByTestId('media-frame')
    expect(within(frame).getByTestId('viewer-counter')).toHaveTextContent('3 / 3')
    expect(within(frame).getByRole('button', { name: 'Open full screen' })).toBeInTheDocument()
  })

  it('shows no counter for a single output', () => {
    mount(def, port, [url('a')])
    expect(screen.queryByTestId('viewer-counter')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open full screen' })).toBeInTheDocument()
  })

  it('has one bottom row: thumbnails, cost, Clear and an icon Download link with the path as its tooltip', () => {
    const meta = { job_id: 'job-1', provider: 'kie', model: 'm', cost: { amount: 40, unit: 'credits', usd_equivalent: 0.2 } }
    const kind = noun === 'image' ? 'image-ref' : 'video-ref'
    mount(def, port, [
      { kind, local: url('a'), meta },
      { kind, local: url('b'), meta },
    ])
    const footer = screen.getByTestId('viewer-footer')
    expect(within(footer).getAllByRole('button', { name: new RegExp(`^${select} `) })).toHaveLength(2)
    expect(within(footer).getByTestId('output-cost')).toHaveTextContent('40 credits')
    expect(within(footer).getByRole('button', { name: 'Clear' })).toBeInTheDocument()
    const link = within(footer).getByRole('link', { name: `Download b.${ext}` })
    expect(link).toHaveAttribute('href', url('b'))
    expect(link).toHaveAttribute('title', url('b'))
    expect(link.textContent).toBe('')
    expect(link.querySelector('svg')).not.toBeNull()
    // The path is a tooltip, not a visible line.
    expect(within(footer).queryByText(url('b'))).toBeNull()
  })

  it('Clear in the bottom row empties the viewer back to its waiting state', () => {
    mount(def, port, [url('a'), url('b')])
    fireEvent.click(within(screen.getByTestId('viewer-footer')).getByRole('button', { name: 'Clear' }))
    expect(screen.getByText(`Waiting for ${noun} input…`)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open full screen' })).toBeNull()
    expect(screen.queryByTestId('media-frame')).toBeNull()
  })

  it('keeps the waiting state when empty: no frame, no pop-out, no row', () => {
    mount(def, port, [])
    expect(screen.getByText(`Waiting for ${noun} input…`)).toBeInTheDocument()
    expect(screen.queryByTestId('media-frame')).toBeNull()
    expect(screen.queryByTestId('viewer-footer')).toBeNull()
  })

  it('marks a previous-run item and dims it', () => {
    const { show, container } = mount(def, port, [url('a')])
    show([])
    expect(within(screen.getByTestId('media-frame')).getByText('Previous run')).toBeInTheDocument()
    expect(container.querySelector('[data-viewer-root]')!.className).toContain('opacity-40')
  })
})

describe.each(cases)('$name full screen', ({ def, port, ext, noun, select }) => {
  const url = (n: string) => `/outputs/${n}.${ext}`
  const shownIn = (root: HTMLElement) => root.querySelector(noun === 'image' ? 'img' : 'video')!.getAttribute('src')

  it('opens a dialog showing the selected item, with Download and Close', async () => {
    const user = userEvent.setup()
    mount(def, port, [url('a'), url('b'), url('c')])
    fireEvent.click(screen.getByRole('button', { name: `${select} 2` }))
    await user.click(screen.getByRole('button', { name: 'Open full screen' }))
    const dialog = screen.getByRole('dialog')
    expect(shownIn(within(dialog).getByTestId('lightbox-media'))).toBe(url('b'))
    expect(within(dialog).getByRole('link', { name: `Download b.${ext}` })).toHaveAttribute('href', url('b'))
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(within(dialog).getByText(`b.${ext}`)).toBeInTheDocument()
    expect(within(dialog).getByText('2 / 3')).toBeInTheDocument()
  })

  it('sizes the full-screen media to its own aspect ratio within the free space (player controls span only the picture)', async () => {
    const user = userEvent.setup()
    mount(def, port, [url('tall')])
    await user.click(screen.getByRole('button', { name: 'Open full screen' }))
    const area = within(screen.getByRole('dialog')).getByTestId('lightbox-media')
    const frame = within(area).getByTestId('lightbox-frame')
    reportSize(noun, frame.querySelector(noun === 'image' ? 'img' : 'video') as HTMLElement, 1080, 1920)
    expect(Number(frame.style.getPropertyValue('--media-ratio'))).toBeCloseTo(1080 / 1920, 4)
    expect(frame.className).toContain('aspect-(--media-ratio)')
    expect(frame.className).toContain('w-[min(100cqw,calc(100cqh*var(--media-ratio)))]')
    expect(area.className).toContain('[container-type:size]')
  })

  it('Esc closes it and focus returns to the pop-out button', async () => {
    const user = userEvent.setup()
    mount(def, port, [url('a')])
    const popOut = screen.getByRole('button', { name: 'Open full screen' })
    await user.click(popOut)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(popOut).toHaveFocus()
  })

  it('the Close button closes it too', async () => {
    const user = userEvent.setup()
    mount(def, port, [url('a')])
    await user.click(screen.getByRole('button', { name: 'Open full screen' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Left and Right browse, stop at the ends, and the block follows after closing', async () => {
    const user = userEvent.setup()
    mount(def, port, [url('a'), url('b'), url('c')])
    await user.click(screen.getByRole('button', { name: 'Open full screen' }))
    const dialog = screen.getByRole('dialog')
    expect(shownIn(within(dialog).getByTestId('lightbox-media'))).toBe(url('c'))
    await user.keyboard('{ArrowRight}')
    expect(shownIn(within(dialog).getByTestId('lightbox-media'))).toBe(url('c'))
    await user.keyboard('{ArrowLeft}')
    expect(shownIn(within(dialog).getByTestId('lightbox-media'))).toBe(url('b'))
    await user.keyboard('{ArrowLeft}')
    await user.keyboard('{ArrowLeft}')
    expect(shownIn(within(dialog).getByTestId('lightbox-media'))).toBe(url('a'))
    await user.keyboard('{Escape}')
    expect(blockMedia(noun).getAttribute('src')).toContain(url('a'))
    expect(screen.getByTestId('viewer-counter')).toHaveTextContent('1 / 3')
  })

  it('the previous and next buttons and the thumbnails change the selection', async () => {
    const user = userEvent.setup()
    mount(def, port, [url('a'), url('b'), url('c')])
    await user.click(screen.getByRole('button', { name: 'Open full screen' }))
    const dialog = screen.getByRole('dialog')
    const next = within(dialog).getByRole('button', { name: `Next ${noun}` })
    const prev = within(dialog).getByRole('button', { name: `Previous ${noun}` })
    expect(next).toBeDisabled()
    await user.click(prev)
    expect(shownIn(within(dialog).getByTestId('lightbox-media'))).toBe(url('b'))
    expect(next).toBeEnabled()
    await user.click(within(dialog).getByRole('button', { name: `${select} 1` }))
    expect(shownIn(within(dialog).getByTestId('lightbox-media'))).toBe(url('a'))
    expect(prev).toBeDisabled()
    await user.click(next)
    expect(shownIn(within(dialog).getByTestId('lightbox-media'))).toBe(url('b'))
    await user.keyboard('{Escape}')
    expect(screen.getByTestId('viewer-counter')).toHaveTextContent('2 / 3')
  })

  it('has no previous or next buttons for a single output', async () => {
    const user = userEvent.setup()
    mount(def, port, [url('a')])
    await user.click(screen.getByRole('button', { name: 'Open full screen' }))
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: `Next ${noun}` })).toBeNull()
  })
})

describe('Video Viewer full screen playback', () => {
  it('pauses the video in the block while open, and plays the full-screen one with native controls', async () => {
    const user = userEvent.setup()
    const pause = vi.mocked(HTMLMediaElement.prototype.pause)
    mount(videoViewer, 'video', ['/outputs/v.mp4'])
    const inBlock = blockMedia('video')
    pause.mockClear()
    await user.click(screen.getByRole('button', { name: 'Open full screen' }))
    expect(pause.mock.contexts).toContain(inBlock)
    const video = within(screen.getByTestId('lightbox-media')).getByLabelText('Generated video 1') as HTMLVideoElement
    expect(video).toHaveAttribute('controls')
    expect(video).toHaveAttribute('src', '/outputs/v.mp4')
    expect(video).not.toBe(inBlock)
  })
})
