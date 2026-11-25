/**
 * The viewer strips (Image, Video and Audio Viewer) render at most the latest
 * 30 outputs, with Show older to reveal more; the "n / N" counter keeps the
 * true total, and selecting a revealed output still drives the footer's
 * Download link (whose tooltip is the file path). Strip thumbnails load lazily: images with
 * `loading="lazy"`, videos with `preload="none"` and no source until they
 * scroll into view, then their metadata and first frame. The stored history
 * is capped, oldest dropped, so a Loop cannot grow it without bound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import '@/components/pipeline/custom_blocks/_register'
import { blockDef as imageViewer } from '@/components/pipeline/custom_blocks/generated/image_viewer'
import { blockDef as videoViewer } from '@/components/pipeline/custom_blocks/generated/video_viewer'
import { blockDef as audioViewer } from '@/components/pipeline/custom_blocks/generated/audio_viewer'
import { PipelineProvider } from '@/lib/pipeline/pipeline-context'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { blockProps } from '@/test-utils/byok-harness'

let tab = 0
const observers: FakeObserver[] = []

class FakeObserver {
  targets: Element[] = []
  constructor(private callback: IntersectionObserverCallback) { observers.push(this) }
  observe(el: Element) { this.targets.push(el) }
  unobserve(el: Element) { this.targets = this.targets.filter((t) => t !== el) }
  disconnect() { this.targets = [] }
  /** Report every observed element as on screen. */
  showAll() {
    const entries = this.targets.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry)
    this.callback(entries, this as unknown as IntersectionObserver)
  }
}

beforeEach(() => {
  sessionStorage.clear()
  observers.length = 0
  vi.stubGlobal('IntersectionObserver', FakeObserver)
})
afterEach(() => vi.unstubAllGlobals())

function mount(def: typeof imageViewer, port: string, urls: string[]) {
  const tabId = `vs-${++tab}`
  const wrap = (children: ReactNode) => (
    <PipelineTabsProvider><PipelineProvider tabId={tabId}>{children}</PipelineProvider></PipelineTabsProvider>
  )
  const props = blockProps(`viewer-${tab}`, { [port]: urls })
  const Comp = def.component
  const view = render(wrap(<Comp {...props} />))
  const show = (next: string[]) => view.rerender(wrap(<Comp {...props} inputs={{ [port]: [...next] }} />))
  return { ...view, show }
}

const outputs = (n: number, ext: string, from = 0) => Array.from({ length: n }, (_, i) => `/outputs/o${from + i}.${ext}`)

const cases = [
  { name: 'Image Viewer', def: imageViewer, port: 'image', ext: 'png', tag: 'img', select: 'Select image' },
  { name: 'Video Viewer', def: videoViewer, port: 'video', ext: 'mp4', tag: 'video', select: 'Select video' },
] as const

describe.each(cases)('$name strip', ({ def, port, ext, tag, select }) => {
  const stripItems = () => screen.queryAllByRole('button', { name: new RegExp(`^${select} `) })
  const stripMedia = () =>
    stripItems().map((b) => b.querySelector(tag)).filter(Boolean) as HTMLElement[]

  it('renders at most 30 media elements for 200 outputs; the count keeps the total', () => {
    const { container } = mount(def, port, outputs(200, ext))
    expect(screen.getByTestId('viewer-counter')).toHaveTextContent('200 / 200')
    expect(stripItems()).toHaveLength(30)
    // the strip plus the one large frame
    expect(container.querySelectorAll(tag).length).toBeLessThanOrEqual(31)
    expect(stripMedia()).toHaveLength(30)
    // the newest 30, still numbered by their place in the whole history
    expect(stripItems()[0]).toHaveAccessibleName(`${select} 171`)
    expect(stripItems()[29]).toHaveAccessibleName(`${select} 200`)
  })

  it('Show older reveals 30 more at a time, and a revealed output can be selected', () => {
    mount(def, port, outputs(75, ext))
    fireEvent.click(screen.getByRole('button', { name: /show older/i }))
    expect(stripItems()).toHaveLength(60)
    fireEvent.click(screen.getByRole('button', { name: /show older/i }))
    expect(stripItems()).toHaveLength(75)
    expect(screen.queryByRole('button', { name: /show older/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: `${select} 2` }))
    expect(within(screen.getByTestId('viewer-footer')).getByRole('link', { name: `Download o1.${ext}` }))
      .toHaveAttribute('title', `/outputs/o1.${ext}`)
    expect(screen.getByTestId('viewer-counter')).toHaveTextContent('2 / 75')
  })

  it('stores at most 200 outputs, dropping the oldest', () => {
    const { show } = mount(def, port, outputs(150, ext))
    show(outputs(100, ext, 150))
    expect(screen.getByTestId('viewer-counter')).toHaveTextContent('200 / 200')
    expect(within(screen.getByTestId('viewer-footer')).getByRole('link', { name: `Download o249.${ext}` }))
      .toHaveAttribute('title', `/outputs/o249.${ext}`)
  })
})

describe('strip thumbnails load lazily', () => {
  it('Image Viewer: strip images use loading="lazy"', () => {
    mount(imageViewer, 'image', outputs(5, 'png'))
    const thumbs = screen.getAllByRole('button', { name: /^Select image / }).map((b) => b.querySelector('img')!)
    expect(thumbs.every((img) => img.getAttribute('loading') === 'lazy')).toBe(true)
  })

  it('Video Viewer: strip videos load nothing until visible, then their metadata', () => {
    mount(videoViewer, 'video', outputs(5, 'mp4'))
    const thumbs = () => screen.getAllByRole('button', { name: /^Select video / }).map((b) => b.querySelector('video')!)
    expect(thumbs()).toHaveLength(5)
    expect(thumbs().every((v) => v.getAttribute('preload') === 'none' && !v.getAttribute('src'))).toBe(true)
    act(() => observers.forEach((o) => o.showAll()))
    expect(thumbs().every((v) => v.getAttribute('preload') === 'metadata')).toBe(true)
    expect(thumbs()[0].getAttribute('src')).toBe('/outputs/o0.mp4#t=0.1')
  })
})

describe('Audio Viewer strip', () => {
  const listed = () => screen.queryAllByRole('button').filter((b) => /^#\d/.test(b.textContent ?? ''))

  it('lists at most 30 files for 200 outputs, with Show older', () => {
    mount(audioViewer, 'audio', outputs(200, 'mp3'))
    expect(listed()).toHaveLength(30)
    expect(listed()[0].textContent).toBe('#171o170.mp3')
    fireEvent.click(screen.getByRole('button', { name: /show older/i }))
    expect(listed()).toHaveLength(60)
    fireEvent.click(listed()[0])
    expect(screen.getByTestId('viewer-footer')).toHaveTextContent('/outputs/o140.mp3')
  })
})
