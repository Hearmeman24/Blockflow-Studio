import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { MasonryGrid } from './masonry-grid'

/** A ResizeObserver that reports one fixed width for every observed element. */
function stubWidth(width: number) {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: ResizeObserverCallback) {}
    observe() {
      this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver)
    }
    unobserve() {}
    disconnect() {}
  })
}

function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduced && query.includes('prefers-reduced-motion'),
    media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  }))
}

afterEach(() => vi.unstubAllGlobals())

const items = (aspects: number[]) => aspects.map((aspect, i) => ({
  key: `k${i}`,
  aspect,
  render: ({ reportAspect }: { reportAspect: (a: number) => void }) => (
    <button type="button" onClick={() => reportAspect(0.5)}>tile {i}</button>
  ),
}))

const cell = (i: number) => screen.getByText(`tile ${i}`).closest('[data-masonry-cell]') as HTMLElement

describe('MasonryGrid', () => {
  it('positions tiles by the masonry layout for the measured width', () => {
    stubWidth(856) // 2 columns of 424 px with an 8 px gap
    stubReducedMotion(false)
    const { container } = render(<MasonryGrid items={items([1, 0.5, 2])} label="Artifacts" />)
    expect(cell(0).style.transform).toBe('translate3d(0px, 0px, 0)')
    expect(cell(1).style.transform).toBe('translate3d(432px, 0px, 0)')
    expect(cell(2).style.transform).toBe('translate3d(0px, 432px, 0)')
    expect(cell(1).style.height).toBe('848px')
    const list = container.querySelector('[role="list"]') as HTMLElement
    expect(list).toHaveAttribute('aria-label', 'Artifacts')
    expect(list.style.height).toBe('848px')
  })

  it("corrects a tile's height when its real aspect ratio is reported", () => {
    stubWidth(856)
    stubReducedMotion(false)
    render(<MasonryGrid items={items([1])} label="Artifacts" />)
    expect(cell(0).style.height).toBe('424px')
    act(() => screen.getByText('tile 0').click())
    expect(cell(0).style.height).toBe('848px')
  })

  it('animates entrance with a stagger, but not with reduced motion', async () => {
    stubWidth(416)
    stubReducedMotion(false)
    const enter = (i: number) => cell(i).querySelector('[data-masonry-enter]') as HTMLElement
    const { unmount } = render(<MasonryGrid items={items([1, 1])} label="Artifacts" />)
    expect(enter(1).style.transitionDelay).toBe('40ms')
    expect(enter(1).className).toMatch(/motion-safe:transition/)
    await waitFor(() => expect(cell(1).className).toMatch(/motion-safe:transition/))
    unmount()
    stubReducedMotion(true)
    render(<MasonryGrid items={items([1, 1])} label="Artifacts" />)
    expect(enter(1).style.transitionDelay).toBe('')
    expect(enter(1)).toHaveAttribute('data-entered', 'true')
    expect(enter(1).className).not.toMatch(/blur|transition/)
    expect(cell(1).className).not.toMatch(/transition/)
  })

  it('does not glide tiles into place from nowhere before the first measurement', async () => {
    stubWidth(856)
    stubReducedMotion(false)
    render(<MasonryGrid items={items([1])} label="Artifacts" />)
    // Right after mounting the cells take their place without a transition…
    expect(cell(0).className).not.toMatch(/transition/)
    // …and glide on later changes (resize, filters).
    await waitFor(() => expect(cell(0).className).toMatch(/motion-safe:transition-\[transform,width,height\]/))
  })
})
