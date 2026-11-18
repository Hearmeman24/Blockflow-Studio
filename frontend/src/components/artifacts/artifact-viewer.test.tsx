/**
 * ArtifactViewer: a run's media large on the left (about 70 %) and its
 * metadata on the right, in a Dialog; previous/next through the page's runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'
import { useState, type ReactNode } from 'react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
const restoreFlowSnapshot = vi.fn()
vi.mock('@/lib/pipeline/tabs-context', () => ({ usePipelineTabs: () => ({ restoreFlowSnapshot }) }))
const toggleRunFavorite = vi.fn()
vi.mock('@/lib/api', () => ({ toggleRunFavorite: (...a: unknown[]) => toggleRunFavorite(...a) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { ArtifactViewer } from './artifact-viewer'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'
import type { BlockResult, RunEntry } from '@/lib/types'

const META = { job_id: 'j', provider: 'kie', model: 'seedream-5-flash', cost: { amount: 3.24, unit: 'credits', usd_equivalent: 0.0162 } }
const ref = (n: number, meta: unknown = META) => ({ kind: 'image-ref', local: `/outputs/byok/j_${n}.png`, meta })
const PROMPT = 'A harsh flash photograph of the woman from Image1 ✨'
const block = (i: number, type: string, label: string, outputs: BlockResult['outputs'], status = 'completed'): BlockResult =>
  ({ block_index: i, block_type: type, block_label: label, status, outputs })

function makeRun(id: string, over: Partial<RunEntry> = {}): RunEntry {
  return {
    id, name: `Run ${id}`, status: 'completed', duration_ms: 21_000, created_at: '2026-11-15T13:23:00Z', favorited: false,
    flow_snapshot: { blocks: [
      { type: 'uploadImageToTmpfiles', config: { items: [{ id: 'a', label: 'face.png', local: '/outputs/face.png' }] } },
      { type: 'imageToImage', config: { provider: 'kie', model: 'seedream-5-flash', prompt: PROMPT, params: { resolution: '1.5K', aspect_ratio: '3:4', settings: { quality: 'high', nsfw_checker: true } } } },
    ] },
    block_results: [block(0, 'imageToImage', 'Image to Image', { image: { kind: 'image', value: ref(1) } })],
    ...over,
  }
}

const RUNS = [makeRun('a'), makeRun('b', { block_results: [block(0, 'i', 'I', { image: { kind: 'image', value: ref(2, { ...META, cost: null }) } })] }), makeRun('c')]

function Harness({ runs = RUNS, start = 0 }: { runs?: RunEntry[]; start?: number }) {
  const [openId, setOpenId] = useState<string | null>(null)
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <button type="button" data-run-tile={runs[start].id} onClick={() => setOpenId(runs[start].id)}>open</button>
      <ArtifactViewer runs={runs} openId={openId} onOpenChange={setOpenId} />
    </SWRConfig>
  )
}

function wrap(children: ReactNode) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
}

beforeEach(() => {
  push.mockReset()
  restoreFlowSnapshot.mockReset()
  toggleRunFavorite.mockReset()
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    new Response(JSON.stringify(String(url).startsWith('/api/providers/catalog') ? CATALOG_BOTH : {}))))
})
afterEach(() => vi.unstubAllGlobals())

async function open(props: { runs?: RunEntry[]; start?: number } = {}) {
  const user = userEvent.setup()
  render(<Harness {...props} />)
  await user.click(screen.getByRole('button', { name: 'open' }))
  return { user, dialog: await screen.findByRole('dialog') }
}

describe('ArtifactViewer', () => {
  it('shows the media large and the metadata beside it, titled with the run name', async () => {
    const { dialog } = await open()
    expect(within(dialog).getByRole('heading', { name: 'Run a' })).toBeInTheDocument()
    const img = within(dialog).getByRole('img', { name: 'Run a' })
    expect(img).toHaveAttribute('src', '/outputs/byok/j_1.png')
    expect(img.className).toMatch(/object-contain/)
    const details = within(dialog).getByRole('complementary', { name: 'Details' })
    expect(await within(details).findByText('Seedream 5 Flash')).toBeInTheDocument()
    expect(details).toHaveTextContent('Kie')
    expect(details).toHaveTextContent('3.24 credits ≈ $0.02')
    expect(details).toHaveTextContent('21s')
    expect(details).not.toHaveTextContent('completed')
  })

  it('lays the panes side by side from medium width and stacks them below', async () => {
    const { dialog } = await open()
    expect(dialog.className).toMatch(/flex-col/)
    expect(dialog.className).toMatch(/md:flex-row/)
    expect(within(dialog).getByRole('region', { name: 'Media' }).className).toMatch(/md:basis-7\/10/)
    expect(within(dialog).getByRole('complementary', { name: 'Details' }).className).toMatch(/md:basis-3\/10/)
  })

  it('lists the settings used, the prompt with Copy, and the references', async () => {
    const { dialog } = await open()
    const settings = within(dialog).getByRole('list', { name: 'Settings' })
    expect(settings).toHaveTextContent('Resolution1.5K')
    expect(settings).toHaveTextContent('Aspect ratio3:4')
    expect(settings).toHaveTextContent('Qualityhigh')
    expect(settings).toHaveTextContent('Nsfw checkerOn')
    expect(within(dialog).getByTestId('viewer-prompt')).toHaveTextContent(PROMPT)
    expect(within(dialog).getByRole('button', { name: 'Copy prompt for Run a' })).toBeInTheDocument()
    expect(within(dialog).getByRole('img', { name: 'face.png' })).toHaveAttribute('src', '/outputs/face.png')
  })

  it('leaves the cost out when the run has none and shows status and error for a failed run', async () => {
    const failed = makeRun('f', { status: 'failed', block_results: [block(0, 'imageToImage', 'Image to Image', {}, 'error')] })
    const { dialog } = await open({ runs: [RUNS[1], failed] })
    expect(within(dialog).getByRole('complementary', { name: 'Details' })).not.toHaveTextContent('Cost')
    await userEvent.setup().keyboard('{ArrowRight}')
    await waitFor(() => expect(within(dialog).getByRole('heading', { name: 'Run f' })).toBeInTheDocument())
    expect(within(dialog).getByRole('complementary', { name: 'Details' })).toHaveTextContent('Failed')
    expect(within(dialog).getByRole('complementary', { name: 'Details' })).toHaveTextContent('Image to Image failed.')
  })

  it('moves through the runs with the arrow buttons and keys, disabled at the ends', async () => {
    const { user, dialog } = await open()
    const prev = within(dialog).getByRole('button', { name: 'Previous run' })
    const next = within(dialog).getByRole('button', { name: 'Next run' })
    expect(prev).toBeDisabled()
    await user.click(next)
    expect(within(dialog).getByRole('heading', { name: 'Run b' })).toBeInTheDocument()
    await user.keyboard('{ArrowRight}')
    expect(within(dialog).getByRole('heading', { name: 'Run c' })).toBeInTheDocument()
    expect(next).toBeDisabled()
    await user.keyboard('{ArrowRight}')
    expect(within(dialog).getByRole('heading', { name: 'Run c' })).toBeInTheDocument()
    await user.keyboard('{ArrowLeft}')
    expect(within(dialog).getByRole('heading', { name: 'Run b' })).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBe(dialog)
  })

  it('closes on Escape and returns focus to the tile', async () => {
    const { user } = await open()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('button', { name: 'open' })).toHaveFocus()
  })

  it('closes on a backdrop click', async () => {
    const { user } = await open()
    const overlay = document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement
    await user.click(overlay)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('switches between several outputs with a thumbnail strip', async () => {
    const multi = makeRun('m', { block_results: [block(0, 't', 'T', { image: { kind: 'image', value: [ref(1), ref(2), ref(3)] } })] })
    const { user, dialog } = await open({ runs: [multi] })
    const strip = within(dialog).getByRole('list', { name: 'Outputs' })
    const thumbs = within(strip).getAllByRole('button')
    expect(thumbs).toHaveLength(3)
    expect(thumbs[0]).toHaveAttribute('aria-current', 'true')
    await user.click(thumbs[2])
    expect(within(dialog).getByRole('img', { name: 'Run m' })).toHaveAttribute('src', '/outputs/byok/j_3.png')
    expect(thumbs[2]).toHaveAttribute('aria-current', 'true')
  })

  it('has no strip for a single output', async () => {
    const { dialog } = await open()
    expect(within(dialog).queryByRole('list', { name: 'Outputs' })).toBeNull()
  })

  it('shows a video with native controls, paused, and audio with a player', async () => {
    const video = makeRun('v', { block_results: [block(0, 'v', 'V', { video: { kind: 'video', value: { kind: 'video-ref', local: '/outputs/v.mp4' } } })] })
    const audio = makeRun('s', { block_results: [block(0, 'a', 'A', { audio: { kind: 'audio', value: { kind: 'audio-ref', local: '/outputs/s.mp3' } } })] })
    const { user, dialog } = await open({ runs: [video, audio] })
    const el = dialog.querySelector('video')!
    expect(el).toHaveAttribute('src', '/outputs/v.mp4')
    expect(el.controls).toBe(true)
    expect(el.autoplay).toBe(false)
    await user.click(within(dialog).getByRole('button', { name: 'Next run' }))
    expect(within(dialog).getByLabelText('Audio for Run s')).toHaveAttribute('src', '/outputs/s.mp3')
  })

  it('Restore closes the viewer and restores the run', async () => {
    restoreFlowSnapshot.mockReturnValue('tab-1')
    const { user, dialog } = await open()
    await user.click(within(dialog).getByRole('button', { name: 'Restore Run a' }))
    expect(restoreFlowSnapshot).toHaveBeenCalledWith('Run a', RUNS[0].flow_snapshot)
    expect(push).toHaveBeenCalledWith('/generate')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('Favorite toggles and reflects aria-pressed', async () => {
    toggleRunFavorite.mockResolvedValue({ ok: true, favorited: true })
    const onFavoriteToggled = vi.fn()
    const user = userEvent.setup()
    render(wrap(<ArtifactViewer runs={RUNS} openId="a" onOpenChange={vi.fn()} onFavoriteToggled={onFavoriteToggled} />))
    const fav = await screen.findByRole('button', { name: 'Favorite Run a' })
    expect(fav).toHaveAttribute('aria-pressed', 'false')
    await user.click(fav)
    expect(toggleRunFavorite).toHaveBeenCalledWith('a')
    await waitFor(() => expect(fav).toHaveAttribute('aria-pressed', 'true'))
    expect(onFavoriteToggled).toHaveBeenCalled()
  })

  it('has no delete control and no block badges', async () => {
    const { dialog } = await open()
    expect(within(dialog).queryByRole('button', { name: /delete/i })).toBeNull()
    expect(within(dialog).queryByText('Image to Image')).toBeNull()
  })

  it('a refresh that adds runs above keeps showing the open run', async () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(wrap(<ArtifactViewer runs={RUNS} openId="b" onOpenChange={onOpenChange} />))
    expect(await screen.findByRole('dialog', { name: 'Run b' })).toBeInTheDocument()
    rerender(wrap(<ArtifactViewer runs={[makeRun('new1'), makeRun('new2'), ...RUNS]} openId="b" onOpenChange={onOpenChange} />))
    expect(screen.getByRole('dialog', { name: 'Run b' })).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('the open run leaving the list stays shown; the arrows go to its old neighbours', async () => {
    const onOpenChange = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(wrap(<ArtifactViewer runs={RUNS} openId="b" onOpenChange={onOpenChange} />))
    await screen.findByRole('dialog', { name: 'Run b' })
    // e.g. its favourite was turned off under "Favorites only", and the list refreshed.
    rerender(wrap(<ArtifactViewer runs={[RUNS[0], RUNS[2]]} openId="b" onOpenChange={onOpenChange} />))
    const dialog = screen.getByRole('dialog', { name: 'Run b' })
    await user.click(within(dialog).getByRole('button', { name: 'Next run' }))
    expect(onOpenChange).toHaveBeenLastCalledWith('c')
    await user.click(within(dialog).getByRole('button', { name: 'Previous run' }))
    expect(onOpenChange).toHaveBeenLastCalledWith('a')
  })

  it('an id that is not in the list and was never shown opens nothing', () => {
    render(wrap(<ArtifactViewer runs={RUNS} openId="zzz" onOpenChange={vi.fn()} />))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
