/**
 * ArtifactTile: one run in the Artifacts gallery. Media only; a panel slides up
 * on hover, keyboard focus or a tap with the metadata line and icon actions
 * (Restore, Favorite, Prompt with Copy). Fixtures copy the shape of real runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
const restoreFlowSnapshot = vi.fn()
vi.mock('@/lib/pipeline/tabs-context', () => ({ usePipelineTabs: () => ({ restoreFlowSnapshot }) }))
const toggleRunFavorite = vi.fn()
vi.mock('@/lib/api', () => ({ toggleRunFavorite: (...a: unknown[]) => toggleRunFavorite(...a) }))
const toastSuccess = vi.fn()
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn() } }))

import { ArtifactTile } from './artifact-tile'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'
import type { BlockResult, RunEntry } from '@/lib/types'

const META = {
  job_id: '5de0992c', provider: 'kie', model: 'seedream-5-flash',
  cost: { amount: 3.24, unit: 'credits', usd_equivalent: 0.0162 },
}
const GEN_REF = { kind: 'image-ref', local: '/outputs/byok/5de0992c_1.png', url: 'https://tempfile.aiquickdraw.com/x.png', meta: META }
const LOADER_REF = { kind: 'image-ref', local: '/outputs/loader.png', label: 'loader.png', width: 1072, height: 1136 }
const PROMPT = 'A harsh flash photograph of the woman from Image1.\nSecond line ✨'
const SNAPSHOT = {
  name: 'Pipeline Run',
  blocks: [
    { type: 'uploadImageToTmpfiles', config: { items: [] } },
    { type: 'imageToImage', config: { provider: 'kie', model: 'seedream-5-flash', prompt: PROMPT, use_upstream_prompt: false, params: {} } },
  ],
}
const block = (i: number, type: string, label: string, outputs: BlockResult['outputs'], status = 'completed'): BlockResult =>
  ({ block_index: i, block_type: type, block_label: label, status, outputs })

function makeRun(over: Partial<RunEntry> = {}): RunEntry {
  return {
    id: 'run-1', name: 'Pipeline Run — Nov 15 03:23 PM', status: 'completed', duration_ms: 21000, flow_snapshot: SNAPSHOT,
    block_results: [
      block(0, 'uploadImageToTmpfiles', 'Image Loader', { image: { kind: 'image', value: LOADER_REF } }),
      block(1, 'imageToImage', 'Image to Image', { image: { kind: 'image', value: GEN_REF } }),
      block(2, 'imageViewer', 'Image Viewer', { image: { kind: 'image', value: GEN_REF } }),
    ],
    created_at: new Date(Date.now() - 42 * 60_000).toISOString(),
    favorited: false,
    ...over,
  }
}

function wrap(children: ReactNode) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
}

beforeEach(() => {
  push.mockReset()
  restoreFlowSnapshot.mockReset()
  toggleRunFavorite.mockReset()
  toastSuccess.mockReset()
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    new Response(JSON.stringify(String(url).startsWith('/api/providers/catalog') ? CATALOG_BOTH : {}))))
})
afterEach(() => vi.unstubAllGlobals())

const NAME = 'Pipeline Run — Nov 15 03:23 PM'
const tile = () => screen.getByRole('group', { name: NAME })
const panel = () => screen.getByTestId('artifact-panel')

describe('ArtifactTile media', () => {
  it('shows only the generated image: no badges, details, delete or title row', () => {
    render(wrap(<ArtifactTile run={makeRun()} />))
    expect(screen.getByRole('img', { name: NAME })).toHaveAttribute('src', '/outputs/byok/5de0992c_1.png')
    for (const gone of ['Image Loader', 'Image to Image', 'Image Viewer', 'Details', 'View structured output']) {
      expect(screen.queryByText(gone)).toBeNull()
    }
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
    expect(screen.queryByText('completed')).toBeNull()
  })

  it('reports the real aspect ratio once the image loads', () => {
    const onAspect = vi.fn()
    render(wrap(<ArtifactTile run={makeRun()} onAspect={onAspect} />))
    const img = screen.getByRole('img', { name: NAME })
    Object.defineProperty(img, 'naturalWidth', { value: 1536 })
    Object.defineProperty(img, 'naturalHeight', { value: 2048 })
    fireEvent.load(img)
    expect(onAspect).toHaveBeenCalledWith(0.75)
  })

  it('shows a video with a video mark, playing muted while the panel is open', async () => {
    const play = vi.fn(() => Promise.resolve())
    const pause = vi.fn()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause)
    const user = userEvent.setup()
    const video = { kind: 'video-ref', local: '/outputs/byok/v_1.mp4', url: 'https://cdn/v', meta: { ...META, model: 'seedance-2' } }
    const { container } = render(wrap(<ArtifactTile run={makeRun({ block_results: [block(0, 'textToVideo', 'Text to Video', { video: { kind: 'video', value: video } })] })} />))
    const el = container.querySelector('video')!
    expect(el.getAttribute('src')).toContain('/outputs/byok/v_1.mp4')
    expect(el.muted).toBe(true)
    expect(screen.getByText('Video')).toBeInTheDocument()
    await user.hover(tile())
    expect(play).toHaveBeenCalled()
    await user.unhover(tile())
    expect(pause).toHaveBeenCalled()
  })

  it('shows a compact neutral tile with the run name for audio and runs without visual output', () => {
    const { rerender } = render(wrap(<ArtifactTile run={makeRun({ block_results: [block(0, 'a', 'Audio', { audio: { kind: 'audio', value: { kind: 'audio-ref', local: '/outputs/s.mp3' } } })] })} />))
    expect(screen.getByTestId('artifact-placeholder')).toHaveTextContent(NAME)
    expect(screen.getByLabelText(`Audio for ${NAME}`)).toHaveAttribute('src', '/outputs/s.mp3')
    rerender(wrap(<ArtifactTile run={makeRun({ block_results: [block(0, 'p', 'Prompt', { text: { kind: 'text', value: 'hello' } })] })} />))
    expect(screen.getByTestId('artifact-placeholder')).toHaveTextContent(NAME)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('marks a failed run with icon and text, and puts the error in the panel', async () => {
    const user = userEvent.setup()
    render(wrap(<ArtifactTile run={makeRun({
      status: 'failed',
      block_results: [block(0, 'imageToImage', 'Image to Image', {}, 'error')],
    })} />))
    expect(screen.getByText('Failed')).toBeInTheDocument()
    await user.hover(tile())
    expect(panel()).toHaveTextContent('Image to Image failed.')
  })

  it('shows the generated image of a partial run, marked Partial, and names the block that failed', async () => {
    // Load Character -> Image to Image (done) -> Video Viewer (no video to show).
    const user = userEvent.setup()
    render(wrap(<ArtifactTile run={makeRun({
      status: 'partial',
      block_results: [
        block(0, 'loadCharacter', 'Load Character', { image: { kind: 'image', value: LOADER_REF } }),
        block(1, 'imageToImage', 'Image to Image', { image: { kind: 'image', value: GEN_REF } }),
        block(2, 'videoViewer', 'Video Viewer', {}, 'error'),
      ],
    })} />))
    expect(screen.getByRole('img', { name: NAME })).toHaveAttribute('src', '/outputs/byok/5de0992c_1.png')
    expect(screen.getByText('Partial')).toBeInTheDocument()
    expect(screen.queryByTestId('artifact-placeholder')).toBeNull()
    await user.hover(tile())
    expect(panel()).toHaveTextContent('Video Viewer failed.')
  })
})

describe('ArtifactTile panel', () => {
  it('opens on hover and closes when the pointer leaves', async () => {
    const user = userEvent.setup()
    render(wrap(<ArtifactTile run={makeRun()} />))
    expect(panel()).toHaveAttribute('data-state', 'closed')
    await user.hover(tile())
    expect(panel()).toHaveAttribute('data-state', 'open')
    await user.unhover(tile())
    expect(panel()).toHaveAttribute('data-state', 'closed')
  })

  it('opens on keyboard focus and tabs tile → restore → favourite → prompt → copy; Escape closes', async () => {
    const user = userEvent.setup()
    render(wrap(<ArtifactTile run={makeRun()} />))
    await user.tab()
    expect(tile()).toHaveFocus()
    expect(panel()).toHaveAttribute('data-state', 'open')
    await user.tab()
    expect(screen.getByRole('button', { name: `Restore ${NAME}` })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: `Favorite ${NAME}` })).toHaveFocus()
    await user.tab()
    const toggle = screen.getByRole('button', { name: `Prompt for ${NAME}` })
    expect(toggle).toHaveFocus()
    await user.keyboard('{Enter}')
    await user.tab()
    expect(screen.getByRole('button', { name: `Copy prompt for ${NAME}` })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.keyboard('{Escape}')
    expect(panel()).toHaveAttribute('data-state', 'closed')
  })

  it('shows model, actual cost and relative time on one line', async () => {
    render(wrap(<ArtifactTile run={makeRun()} />))
    expect(await screen.findByText('Seedream 5 Flash · 3.24 credits · 42m ago')).toBeInTheDocument()
  })

  it('leaves the cost out when the run has none', async () => {
    const plain = { ...GEN_REF, meta: { ...META, cost: null } }
    render(wrap(<ArtifactTile run={makeRun({ block_results: [block(0, 'i', 'I', { image: { kind: 'image', value: plain } })] })} />))
    expect(await screen.findByText('Seedream 5 Flash · 42m ago')).toBeInTheDocument()
  })

  it('Restore opens the run in a new tab on the canvas through the existing restore path', async () => {
    restoreFlowSnapshot.mockReturnValue('tab-1')
    const user = userEvent.setup()
    render(wrap(<ArtifactTile run={makeRun()} />))
    await user.hover(tile())
    await user.click(screen.getByRole('button', { name: `Restore ${NAME}` }))
    expect(restoreFlowSnapshot).toHaveBeenCalledWith(NAME, SNAPSHOT)
    expect(push).toHaveBeenCalledWith('/generate')
  })

  it('Favorite toggles through the API and reflects the state in aria-pressed', async () => {
    toggleRunFavorite.mockResolvedValue({ ok: true, favorited: true })
    const onFavoriteToggled = vi.fn()
    const user = userEvent.setup()
    render(wrap(<ArtifactTile run={makeRun()} onFavoriteToggled={onFavoriteToggled} />))
    await user.hover(tile())
    const fav = screen.getByRole('button', { name: `Favorite ${NAME}` })
    expect(fav).toHaveAttribute('aria-pressed', 'false')
    await user.click(fav)
    expect(toggleRunFavorite).toHaveBeenCalledWith('run-1')
    expect(fav).toHaveAttribute('aria-pressed', 'true')
    expect(onFavoriteToggled).toHaveBeenCalled()
  })

  it('expands the prompt in place and copies the full text', async () => {
    // userEvent.setup() provides a clipboard stub on navigator.clipboard.
    const user = userEvent.setup()
    render(wrap(<ArtifactTile run={makeRun()} />))
    await user.hover(tile())
    const toggle = screen.getByRole('button', { name: `Prompt for ${NAME}` })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/harsh flash/)).toBeNull()
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('artifact-prompt')).toHaveTextContent('A harsh flash photograph of the woman from Image1. Second line ✨')
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(screen.getByRole('button', { name: `Copy prompt for ${NAME}` }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Prompt copied.'))
    expect(await navigator.clipboard.readText()).toBe(PROMPT)
    await user.click(toggle)
    expect(screen.queryByTestId('artifact-prompt')).toBeNull()
  })

  // A click leaves focus on the control; that pointer focus must not keep the
  // panel open once the pointer has left the tile (real browser event order).
  it('closes and collapses the prompt when the pointer leaves, even after clicking Prompt', async () => {
    const user = userEvent.setup()
    render(wrap(<ArtifactTile run={makeRun()} />))
    await user.hover(tile())
    const toggle = screen.getByRole('button', { name: `Prompt for ${NAME}` })
    await user.click(toggle)
    expect(toggle).toHaveFocus()
    expect(panel()).toHaveAttribute('data-state', 'open')
    await user.unhover(tile())
    expect(panel()).toHaveAttribute('data-state', 'closed')
    expect(screen.queryByTestId('artifact-prompt')).toBeNull()
  })

  it.each([
    ['Restore', `Restore ${NAME}`],
    ['Favorite', `Favorite ${NAME}`],
  ])('closes when the pointer leaves after clicking %s', async (_label, name) => {
    restoreFlowSnapshot.mockReturnValue(null)
    toggleRunFavorite.mockResolvedValue({ ok: true, favorited: true })
    const user = userEvent.setup()
    render(wrap(<ArtifactTile run={makeRun()} />))
    await user.hover(tile())
    await user.click(screen.getByRole('button', { name }))
    await user.unhover(tile())
    expect(panel()).toHaveAttribute('data-state', 'closed')
  })

  it('closes when the pointer leaves after clicking Copy', async () => {
    const user = userEvent.setup()
    render(wrap(<ArtifactTile run={makeRun()} />))
    await user.hover(tile())
    await user.click(screen.getByRole('button', { name: `Prompt for ${NAME}` }))
    await user.click(screen.getByRole('button', { name: `Copy prompt for ${NAME}` }))
    await user.unhover(tile())
    expect(panel()).toHaveAttribute('data-state', 'closed')
    expect(screen.queryByTestId('artifact-prompt')).toBeNull()
  })

  it('keeps the panel for keyboard focus after the pointer passes over and leaves', async () => {
    const user = userEvent.setup()
    render(wrap(<ArtifactTile run={makeRun()} />))
    await user.tab()
    await user.tab()
    expect(screen.getByRole('button', { name: `Restore ${NAME}` })).toHaveFocus()
    await user.hover(tile())
    await user.unhover(tile())
    expect(panel()).toHaveAttribute('data-state', 'open')
  })

  it('shows the Prompt Writer text when the generation block uses the upstream prompt', async () => {
    const user = userEvent.setup()
    const run = makeRun({
      flow_snapshot: {
        blocks: [
          { type: 'promptWriter', config: { user_prompt: 'idea', output: 'x' } },
          { type: 'imageToImage', config: { provider: 'kie', model: 'seedream-5-flash', prompt: '', use_upstream_prompt: true, params: {} } },
        ],
      },
      block_results: [
        block(0, 'promptWriter', 'Prompt Writer', { prompt: { kind: 'text', value: 'Written by the writer ✨' } }),
        block(1, 'imageToImage', 'Image to Image', { image: { kind: 'image', value: GEN_REF } }),
      ],
    })
    render(wrap(<ArtifactTile run={run} />))
    await user.hover(tile())
    await user.click(screen.getByRole('button', { name: `Prompt for ${NAME}` }))
    expect(screen.getByTestId('artifact-prompt')).toHaveTextContent('Written by the writer ✨')
  })

  it('has no prompt toggle when the run has no prompt', async () => {
    const user = userEvent.setup()
    render(wrap(<ArtifactTile run={makeRun({ flow_snapshot: {} })} />))
    await user.hover(tile())
    expect(screen.queryByRole('button', { name: /Prompt for/ })).toBeNull()
  })

  it('on touch, the first tap opens the panel and a second tap on the media opens the viewer', () => {
    const onOpen = vi.fn()
    render(wrap(<ArtifactTile run={makeRun()} onOpen={onOpen} />))
    const media = screen.getByRole('img', { name: NAME })
    act(() => {
      fireEvent.pointerDown(media, { pointerType: 'touch' })
      fireEvent.click(media)
    })
    expect(panel()).toHaveAttribute('data-state', 'open')
    expect(onOpen).not.toHaveBeenCalled()
    expect(restoreFlowSnapshot).not.toHaveBeenCalled()
    act(() => {
      fireEvent.pointerDown(media, { pointerType: 'touch' })
      fireEvent.click(media)
    })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

describe('ArtifactTile viewer', () => {
  it('opens the viewer when the media is clicked', async () => {
    const onOpen = vi.fn()
    const user = userEvent.setup()
    render(wrap(<ArtifactTile run={makeRun()} onOpen={onOpen} />))
    await user.click(screen.getByRole('img', { name: NAME }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('opens the viewer with Enter or Space on the focused tile', async () => {
    const onOpen = vi.fn()
    const user = userEvent.setup()
    render(wrap(<ArtifactTile run={makeRun()} onOpen={onOpen} />))
    await user.tab()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it("does not open the viewer from the panel's controls", async () => {
    const onOpen = vi.fn()
    restoreFlowSnapshot.mockReturnValue(null)
    toggleRunFavorite.mockResolvedValue({ ok: true, favorited: true })
    const user = userEvent.setup()
    render(wrap(<ArtifactTile run={makeRun()} onOpen={onOpen} />))
    await user.hover(tile())
    await user.click(screen.getByRole('button', { name: `Restore ${NAME}` }))
    await user.click(screen.getByRole('button', { name: `Favorite ${NAME}` }))
    await user.click(screen.getByRole('button', { name: `Prompt for ${NAME}` }))
    await user.click(screen.getByRole('button', { name: `Copy prompt for ${NAME}` }))
    await user.click(screen.getByTestId('artifact-prompt'))
    // Keyboard activation of a control does not open it either.
    screen.getByRole('button', { name: `Prompt for ${NAME}` }).focus()
    await user.keyboard('{Enter}')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('marks the tile so focus can return to it when the viewer closes', () => {
    render(wrap(<ArtifactTile run={makeRun()} />))
    expect(tile()).toHaveAttribute('data-run-tile', 'run-1')
  })
})

describe('ArtifactTile panel scrim', () => {
  it('is one element: a dark gradient with no backdrop blur, fading and sliding in one transition', () => {
    render(wrap(<ArtifactTile run={makeRun()} />))
    const el = panel()
    const all = [el, ...Array.from(el.querySelectorAll('*'))].map((e) => e.getAttribute('class') ?? '').join(' ')
    expect(all).not.toMatch(/backdrop-/)
    expect(all).not.toMatch(/mask-/)
    expect(el.className).toMatch(/bg-linear-to-t/)
    // The fade band above the panel is a pseudo-element of the same element.
    expect(el.className).toMatch(/before:bg-linear-to-t/)
    const transitions = el.className.split(' ').filter((c) => /(^|:)transition/.test(c))
    expect(transitions).toEqual(['motion-safe:transition-[translate,opacity,visibility]'])
    expect(el.className).toMatch(/motion-safe:duration-300/)
    // No other element in the panel animates on its own.
    for (const child of Array.from(el.querySelectorAll('*'))) {
      expect(child.getAttribute('class') ?? '').not.toMatch(/(^|\s)(motion-safe:)?(transition-opacity|duration-)/)
    }
  })

  it('slides only when motion is allowed', () => {
    render(wrap(<ArtifactTile run={makeRun()} />))
    expect(panel().className).toMatch(/motion-safe:translate-y-full/)
    expect(panel().className.split(' ')).not.toContain('translate-y-full')
  })
})
