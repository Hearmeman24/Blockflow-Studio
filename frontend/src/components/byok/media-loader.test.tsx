/**
 * Image Loader, Video Loader and Omni Reference Loader: visual-first ordered lists,
 * limits from the downstream generation block, and config round-trip.
 * Fetch is mocked at the HTTP boundary with the real catalog fixtures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'
import userEvent from '@testing-library/user-event'
import { useEffect, type ReactNode } from 'react'
import '@/components/pipeline/custom_blocks/_register'
import { blockDef as imageLoader } from '@/components/pipeline/custom_blocks/generated/upload_image_to_tmpfiles'
import { blockDef as videoLoader } from '@/components/pipeline/custom_blocks/generated/video_loader'
import { blockDef as omniLoader } from '@/components/pipeline/custom_blocks/generated/omni_reference_loader'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'
import { pickFiles } from '@/lib/file-picker'
import { probeMedia } from '@/lib/byok/probe-media'
import { exportFlow } from '@/lib/pipeline/flow-io'
import { PipelineProvider, usePipeline } from '@/lib/pipeline/pipeline-context'
import { getRunBlockers } from '@/lib/pipeline/run-blockers'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { walkBlocks } from '@/lib/pipeline/tree-utils'
import { useSessionState } from '@/lib/use-session-state'
import { blockProps, latestExecute, stubGenerationFetch, type Harness } from '@/test-utils/byok-harness'

vi.mock('@/lib/file-picker', () => ({ pickFiles: vi.fn() }))
vi.mock('@/lib/byok/probe-media', () => ({ probeMedia: vi.fn(async () => ({})) }))

const png = (name: string, size = 1000) => new File([new Uint8Array(size)], name, { type: 'image/png' })
const mp4 = (name: string, size = 1000, type = 'video/mp4') => new File([new Uint8Array(size)], name, { type })

let harness: Harness
beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  vi.mocked(pickFiles).mockReset().mockResolvedValue(null)
  vi.mocked(probeMedia).mockReset().mockResolvedValue({})
  harness = stubGenerationFetch({ catalog: CATALOG_BOTH })
})
afterEach(() => vi.unstubAllGlobals())

const items = () => screen.queryAllByTestId('loader-item').map((li) => li.getAttribute('title'))

function seed(blockId: string, list: unknown[]) {
  sessionStorage.setItem(`block_${blockId}_items`, JSON.stringify(list))
}
const saved = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  id, label, local: `/outputs/${label}`, status: 'ready', ...extra,
})

function withSWR(children: ReactNode) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
}

function renderStandalone(def = imageLoader, id = 'L1') {
  const props = blockProps(id)
  const Comp = def.component
  render(withSWR(<Comp {...props} />))
  return props
}

// ---- In a pipeline, with a downstream generation block ----

let tab = 0
const captured: { ids: string[]; api: ReturnType<typeof usePipeline> | null } = { ids: [], api: null }

function Loader({ def, index }: { def: typeof imageLoader; index: number }) {
  const { pipeline } = usePipeline()
  const ids = [...walkBlocks(pipeline.blocks)].map((b) => b.id)
  useEffect(() => {
    captured.ids = ids
  })
  const Comp = def.component
  // Props are created once per id so registerExecute stays the same mock.
  const props = propsFor(ids[index])
  return <Comp {...props} />
}
const propsCache = new Map<string, ReturnType<typeof blockProps>>()
function propsFor(id: string) {
  if (!propsCache.has(id)) propsCache.set(id, blockProps(id))
  return propsCache.get(id)!
}

function ModelSwitch({ index, field, value }: { index: number; field: 'model' | 'provider'; value: string }) {
  const { pipeline } = usePipeline()
  const id = [...walkBlocks(pipeline.blocks)][index].id
  const [, set] = useSessionState<string | null>(`block_${id}_${field}`, null)
  return <button type="button" onClick={() => set(value)}>{`switch ${field} to ${value}`}</button>
}

function renderInFlow(blocks: unknown[], opts: { def?: typeof imageLoader; extra?: ReactNode; seedItems?: unknown[] } = {}) {
  const flowJson = JSON.stringify({ name: 't', version: 2, schema_version: 5, created_at: '', blocks })
  if (opts.seedItems) {
    const withItems = JSON.parse(flowJson)
    withItems.blocks[0].config = { items: opts.seedItems }
    return renderFlowJson(JSON.stringify(withItems), opts)
  }
  return renderFlowJson(flowJson, opts)
}
function renderFlowJson(flowJson: string, opts: { def?: typeof imageLoader; extra?: ReactNode } = {}) {
  function Api() {
    const api = usePipeline()
    useEffect(() => {
      captured.api = api
    })
    return null
  }
  render(withSWR(
    <PipelineTabsProvider>
      <PipelineProvider tabId={`ml-${++tab}`} flowJson={flowJson}>
        <Api />
        <Loader def={opts.def ?? imageLoader} index={0} />
        {opts.extra}
      </PipelineProvider>
    </PipelineTabsProvider>,
  ))
  return { api: () => captured.api!, loaderId: () => captured.ids[0] }
}

const i2v = (model: string, provider = 'kie') => ({ type: 'imageToVideo', config: { provider, model } })
const omni = (model: string, provider = 'kie') => ({ type: 'omniReferenceToVideo', label: 'Omni', config: { provider, model } })
const addButton = () => screen.getByRole('button', { name: /^Drop (images|videos) or click to add$|^Drop \/ Add$/ })
const footer = () => screen.getByTestId('loader-footer')

describe('labels and definitions', () => {
  it('keep their type strings and config key, with accurate labels', () => {
    expect(imageLoader.type).toBe('uploadImageToTmpfiles')
    expect(imageLoader.label).toBe('Image Loader')
    expect(videoLoader.type).toBe('videoLoader')
    expect(videoLoader.label).toBe('Video Loader')
    expect(imageLoader.configKeys).toEqual(['items'])
    expect(videoLoader.configKeys).toEqual(['items'])
    for (const def of [imageLoader, videoLoader]) expect(def.description).not.toMatch(/tmpfiles|public url|upload/i)
  })

  it('has no prose in the card body: an empty drop zone and one footer line', () => {
    renderStandalone()
    expect(addButton()).toHaveTextContent('Drop images or click to add')
    expect(footer()).toHaveTextContent('0 images')
    const card = screen.getByRole('region', { name: 'Images' })
    expect(card.querySelectorAll('p')).toHaveLength(0)
    expect(card.textContent).not.toMatch(/tmpfiles/i)
  })

  it('puts past generations behind a compact secondary button', () => {
    renderStandalone()
    expect(screen.getByRole('button', { name: 'Add from past generations' })).toBeInTheDocument()
    expect(screen.queryByText('No generated images yet')).toBeNull()
  })
})

describe('tiles: hover and focus controls', () => {
  it('shows each file as a square tile named by its file, with a position badge', () => {
    seed('T1', [saved('a', 'a.png'), saved('b', 'b.png')])
    renderStandalone(imageLoader, 'T1')
    const tiles = screen.getAllByTestId('loader-item')
    expect(tiles.map((t) => t.getAttribute('title'))).toEqual(['a.png', 'b.png'])
    expect(tiles[0]).toHaveClass('aspect-square')
    expect(within(tiles[0]).getByRole('img', { name: 'a.png' })).toHaveClass('object-cover')
    expect(within(tiles[1]).getByText('2')).toBeInTheDocument()
  })

  it('reveals the remove X on hover, keyboard focus and touch, and one click removes the item', () => {
    seed('T2', [saved('a', 'a.png'), saved('b', 'b.png')])
    const props = renderStandalone(imageLoader, 'T2')
    const remove = screen.getByRole('button', { name: 'Remove a.png' })
    // Hidden until the tile is hovered or focused; always shown on coarse pointers.
    // Keyboard focus (:focus-visible) reveals the controls; focus left behind by a click does not keep them stuck open.
    for (const cls of ['opacity-0', 'group-hover:opacity-100', 'group-has-[:focus-visible]:opacity-100', 'pointer-coarse:opacity-100', 'focus-visible:opacity-100']) {
      expect(remove.className).toContain(cls)
    }
    expect(remove.className).not.toContain('focus-within')
    expect(remove).toHaveClass('size-6') // 24 × 24 CSS px hit target
    const tile = screen.getAllByTestId('loader-item')[0]
    expect(tile.className).toContain('has-[:focus-visible]:ring-2')
    expect(tile.className).not.toContain('focus-within')
    remove.focus()
    expect(remove).toHaveFocus()
    fireEvent.click(remove)
    expect(items()).toEqual(['b.png'])
    expect(props.setOutput).toHaveBeenLastCalledWith('image', expect.objectContaining({ local: '/outputs/b.png' }))
  })

  it('moves earlier and later with buttons and with Alt+arrow keys', () => {
    seed('T3', [saved('a', 'a.png'), saved('b', 'b.png'), saved('c', 'c.png')])
    renderStandalone(imageLoader, 'T3')
    fireEvent.click(screen.getByRole('button', { name: 'Move c.png earlier' }))
    expect(items()).toEqual(['a.png', 'c.png', 'b.png'])
    expect(screen.getByRole('button', { name: 'Move a.png earlier' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move b.png later' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Remove a.png' }), { key: 'ArrowRight', altKey: true })
    expect(items()).toEqual(['c.png', 'a.png', 'b.png'])
    fireEvent.keyDown(screen.getByRole('button', { name: 'Remove b.png' }), { key: 'ArrowUp', altKey: true })
    expect(items()).toEqual(['c.png', 'b.png', 'a.png'])
    expect(JSON.parse(sessionStorage.getItem('block_T3_items')!).map((i: { id: string }) => i.id)).toEqual(['c', 'b', 'a'])
  })

  it('labels the first and last frame on the tiles when feeding Image to Video', async () => {
    renderInFlow([{ type: 'uploadImageToTmpfiles' }, i2v('seedance-2')], { seedItems: [saved('a', 'a.png'), saved('b', 'b.png')] })
    await waitFor(() => expect(screen.getAllByTestId('tile-role').map((r) => r.textContent)).toEqual(['First frame', 'Last frame']))
  })
})

describe('adding', () => {
  it('adds several images from the file picker, saves each locally, and emits them in order', async () => {
    vi.mocked(pickFiles).mockResolvedValue([png('a.png'), png('b.png'), png('c.png')])
    const props = renderStandalone()
    fireEvent.click(addButton())
    await waitFor(() => expect(items()).toEqual(['a.png', 'b.png', 'c.png']))
    await waitFor(() => expect(props.setOutput).toHaveBeenLastCalledWith('image', [
      expect.objectContaining({ kind: 'image-ref', local: '/outputs/a.png', label: 'a.png', size_bytes: 1000 }),
      expect.objectContaining({ local: '/outputs/b.png' }),
      expect.objectContaining({ local: '/outputs/c.png' }),
    ]))
    expect(harness.fetchMock.mock.calls.filter(([u]) => String(u).includes('/save-local'))).toHaveLength(3)
    expect(harness.fetchMock.mock.calls.some(([u]) => String(u).endsWith('/upload'))).toBe(false)
    expect(addButton()).toHaveTextContent('Drop / Add')
  })

  it('adds files dropped on the drop zone', async () => {
    renderStandalone()
    fireEvent.drop(screen.getByTestId('loader-drop-zone'), { dataTransfer: { files: [png('dropped.png')] } })
    await waitFor(() => expect(items()).toEqual(['dropped.png']))
  })

  it('rejects a file of the wrong type with an accessible message', async () => {
    renderStandalone()
    fireEvent.drop(screen.getByTestId('loader-drop-zone'), { dataTransfer: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('notes.txt is not an image file.')
    expect(items()).toEqual([])
  })

  it('emits one image as a bare ref and re-emits from execute', async () => {
    seed('L1', [saved('a', 'a.png')])
    const props = renderStandalone()
    props.setOutput.mockClear()
    await act(async () => { await latestExecute(props)({}, new AbortController().signal) })
    expect(props.setOutput).toHaveBeenCalledWith('image', expect.objectContaining({ kind: 'image-ref', local: '/outputs/a.png' }))
    expect(props.setStatusMessage).toHaveBeenLastCalledWith('1 image ready')
  })

  it('execute fails with a clear message when nothing is loaded', async () => {
    const props = renderStandalone(videoLoader, 'V0')
    await expect(latestExecute(props)({}, new AbortController().signal)).rejects.toThrow('Add at least one video before running this block.')
  })
})

describe('Video Loader', () => {
  it('holds several videos, posts them straight to the backend, and emits a list', async () => {
    vi.mocked(pickFiles).mockResolvedValue([mp4('one.mp4'), mp4('two.mov', 1000, 'video/quicktime')])
    const props = renderStandalone(videoLoader, 'V1')
    fireEvent.click(addButton())
    await waitFor(() => expect(items()).toEqual(['one.mp4', 'two.mov']))
    await waitFor(() => expect(props.setOutput).toHaveBeenLastCalledWith('video', [
      expect.objectContaining({ kind: 'video-ref', local: '/outputs/one.mp4' }),
      expect.objectContaining({ kind: 'video-ref', local: '/outputs/two.mov' }),
    ]))
    expect(harness.fetchMock).toHaveBeenCalledWith('http://localhost:47301/api/blocks/video_loader/save-local', expect.objectContaining({ method: 'POST' }))
  })

  it('shows a poster tile with a duration badge, playing on hover', () => {
    seed('V9', [saved('v', 'clip.mp4', { duration_s: 65 })])
    renderStandalone(videoLoader, 'V9')
    const tile = screen.getByTestId('loader-item')
    const video = within(tile).getByLabelText('clip.mp4') as HTMLVideoElement
    expect(video.getAttribute('src')).toBe('/outputs/clip.mp4#t=0.1')
    expect(video).toHaveClass('object-cover')
    expect(within(tile).getByText('1:05')).toBeInTheDocument()
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    fireEvent.mouseEnter(tile)
    expect(play).toHaveBeenCalled()
    play.mockRestore()
  })

  it('restores the old single-video session keys as one item and re-emits it from execute', async () => {
    sessionStorage.setItem('block_V2_local_url', JSON.stringify('/outputs/clip.mp4'))
    sessionStorage.setItem('block_V2_remote_url', JSON.stringify('https://tmpfiles.org/dl/abc/clip.mp4'))
    const props = renderStandalone(videoLoader, 'V2')
    expect(items()).toEqual(['clip.mp4'])
    props.setOutput.mockClear()
    await act(async () => { await latestExecute(props)({}, new AbortController().signal) })
    expect(props.setOutput).toHaveBeenCalledWith('video', [
      { kind: 'video-ref', local: '/outputs/clip.mp4', url: 'https://tmpfiles.org/dl/abc/clip.mp4', label: 'clip.mp4' },
    ])
  })

  it('restores the oldest uploaded_video_url key too', () => {
    sessionStorage.setItem('block_V3_uploaded_video_url', JSON.stringify('/outputs/legacy-clip.mp4'))
    renderStandalone(videoLoader, 'V3')
    expect(items()).toEqual(['legacy-clip.mp4'])
  })
})

describe('limits from the downstream generation block', () => {
  it('shows no limit without a consumer', async () => {
    renderInFlow([{ type: 'uploadImageToTmpfiles' }, { type: 'imageViewer' }])
    await waitFor(() => expect(footer()).toHaveTextContent('0 images'))
    expect(footer().textContent).not.toMatch(/ of /)
  })

  it('shows count, limit and its source in one footer line, details in a tooltip on focus', async () => {
    const user = userEvent.setup()
    renderInFlow([{ type: 'uploadImageToTmpfiles' }, i2v('kling-4.0-flash')])
    await waitFor(() => expect(footer()).toHaveTextContent('0 of 1 · Kling 4.0 Flash'))
    await user.tab()
    while (document.activeElement?.getAttribute('aria-label') !== 'images limit details') await user.tab()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Limit from Image to Video · Kling 4.0 Flash.')
  })

  it('names the strictest of several consumers in the tooltip', async () => {
    renderInFlow([
      { type: 'uploadImageToTmpfiles', branches: [[i2v('kling-4.0-flash')]] },
      omni('seedance-2'),
    ])
    await waitFor(() => expect(footer()).toHaveTextContent('0 of 1 · Kling 4.0 Flash'))
    fireEvent.focus(screen.getByRole('button', { name: 'images limit details' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('the strictest of 2 blocks')
  })

  it('blocks adding past the limit with a visible, accessible message', async () => {
    renderInFlow([{ type: 'uploadImageToTmpfiles' }, i2v('kling-4.0-flash')], { seedItems: [saved('a', 'a.png')] })
    await waitFor(() => expect(footer()).toHaveTextContent('1 of 1'))
    vi.mocked(pickFiles).mockResolvedValue([png('b.png')])
    fireEvent.click(addButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('b.png was not added: Image to Video · Kling 4.0 Flash takes up to 1 image.')
    expect(items()).toEqual(['a.png'])
  })

  it('rejects files over the size limit', async () => {
    renderInFlow([{ type: 'uploadImageToTmpfiles' }, i2v('kling-4.0', 'piapi')])
    await waitFor(() => expect(footer()).toHaveTextContent('≤ 10 MB'))
    vi.mocked(pickFiles).mockResolvedValue([png('huge.png', 11_000_000)])
    fireEvent.click(addButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('huge.png is 11.0 MB; Image to Video · Kling 4.0 accepts up to 10.0 MB per image.')
  })

  it('rejects videos over the duration limit, read from the file', async () => {
    vi.mocked(probeMedia).mockResolvedValue({ duration_s: 21, width: 640, height: 360 })
    renderInFlow([{ type: 'videoLoader' }, omni('seedance-2')], { def: videoLoader })
    await waitFor(() => expect(footer()).toHaveTextContent('0 of 3 · Seedance 2'))
    vi.mocked(pickFiles).mockResolvedValue([mp4('long.mp4')])
    fireEvent.click(addButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('long.mp4 is 21 s long; Omni · Seedance 2 accepts up to 15 s per video.')
    expect(items()).toEqual([])
  })

  it('keeps every item when the limit drops, flags the excess, and Remove extras removes only those', async () => {
    const { loaderId } = renderInFlow(
      [{ type: 'uploadImageToTmpfiles' }, i2v('seedance-2')],
      { seedItems: [saved('a', 'a.png'), saved('b', 'b.png')], extra: <ModelSwitch index={1} field="model" value="kling-4.0-flash" /> },
    )
    await waitFor(() => expect(footer()).toHaveTextContent('2 of 2 · Seedance 2'))
    expect(screen.queryByTestId('loader-notice')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'switch model to kling-4.0-flash' }))
    expect(await screen.findByText('2 images, but Image to Video · Kling 4.0 Flash takes up to 1. Nothing was removed.')).toBeInTheDocument()
    expect(items()).toEqual(['a.png', 'b.png'])
    expect(screen.getAllByTestId('loader-item').map((li) => li.getAttribute('data-flag'))).toEqual(['ok', 'over_limit'])
    expect(within(screen.getAllByTestId('loader-item')[1]).getByTestId('item-status')).toHaveTextContent('Over limit')
    expect(getRunBlockers(loaderId())).toEqual(['holds 2 images; Image to Video · Kling 4.0 Flash takes up to 1'])

    fireEvent.click(screen.getByRole('button', { name: 'Remove extras' }))
    expect(items()).toEqual(['a.png'])
    await waitFor(() => expect(getRunBlockers(loaderId())).toEqual([]))
  })

  it('clears the warning when the model is switched back', async () => {
    renderInFlow(
      [{ type: 'uploadImageToTmpfiles' }, i2v('kling-4.0-flash')],
      { seedItems: [saved('a', 'a.png'), saved('b', 'b.png')], extra: <ModelSwitch index={1} field="model" value="seedance-2" /> },
    )
    expect(await screen.findByTestId('loader-notice')).toHaveTextContent('takes up to 1')
    fireEvent.click(screen.getByRole('button', { name: 'switch model to seedance-2' }))
    await waitFor(() => expect(screen.queryByTestId('loader-notice')).toBeNull())
    expect(screen.getAllByTestId('loader-item').map((li) => li.getAttribute('data-flag'))).toEqual(['ok', 'ok'])
  })

  it('says so and flags every item when the downstream model takes no items of this kind', async () => {
    const { loaderId } = renderInFlow([{ type: 'uploadImageToTmpfiles' }, i2v('seedance-2.5', 'piapi')], { seedItems: [saved('a', 'a.png'), saved('b', 'b.png')] })
    expect(await screen.findByText('Image to Video · Seedance 2.5 does not take images. Nothing was removed.')).toBeInTheDocument()
    expect(footer()).toHaveTextContent('Not supported by Seedance 2.5')
    expect(screen.queryByRole('button', { name: /Drop/ })).toBeNull()
    expect(screen.getAllByTestId('loader-item').map((li) => li.getAttribute('data-flag'))).toEqual(['unsupported', 'unsupported'])
    expect(getRunBlockers(loaderId())[0]).toMatch(/^holds 2 images, but Image to Video · Seedance 2.5 does not take images/)
  })

  it('flags an item another provider does not accept, live on provider switch', async () => {
    renderInFlow(
      [{ type: 'videoLoader' }, omni('seedance-2.5', 'kie')],
      { def: videoLoader, seedItems: [saved('m', 'take.mkv')], extra: <ModelSwitch index={1} field="provider" value="piapi" /> },
    )
    await waitFor(() => expect(footer()).toHaveTextContent('1 of 10 · Seedance 2.5'))
    expect(screen.getByTestId('loader-item').getAttribute('data-flag')).toBe('ok')
    fireEvent.click(screen.getByRole('button', { name: 'switch provider to piapi' }))
    await waitFor(() => expect(screen.getByTestId('loader-item').getAttribute('data-flag')).toBe('incompatible'))
    expect(screen.getByTestId('item-status').getAttribute('title')).toMatch(/does not accept \.mkv videos \(use mp4, mov\)/)
  })
})

describe('Omni Reference Loader', () => {
  it('has Video, Image and Audio sections, one port and one config key per kind, and no voice', async () => {
    expect(omniLoader.outputs.map((p) => [p.name, p.kind])).toEqual([['video', 'video'], ['image', 'image'], ['audio', 'audio']])
    expect(omniLoader.configKeys).toEqual(['video_items', 'image_items', 'audio_items'])
    expect(omniLoader.description).not.toMatch(/voice/i)
    expect(omniLoader.size).toBe('huge')
    renderInFlow([{ type: 'omniReferenceLoader' }, omni('kling-4.0')], { def: omniLoader })
    const loader = await screen.findByTestId('omni-reference-loader')
    const names = within(loader).getAllByRole('region').map((r) => r.getAttribute('aria-label'))
    expect(names).toEqual(['Video', 'Image', 'Audio'])
    expect(within(loader).queryByText(/voice/i)).toBeNull()
  })

  it('Kling 4.0 on Kie takes audio: the Audio footer reads its audio limit', async () => {
    renderInFlow([{ type: 'omniReferenceLoader' }, omni('kling-4.0')], { def: omniLoader })
    const audio = await screen.findByRole('region', { name: 'Audio' })
    await waitFor(() => expect(within(audio).getByTestId('loader-footer')).toHaveTextContent('0 of 3 · Kling 4.0'))
    expect(within(audio).getByRole('button', { name: 'Drop or add audio clips' })).toBeInTheDocument()
  })

  it('emits on three ports; audio clips carry no name and there is no rename control', async () => {
    const config = {
      video_items: [saved('v', 'walk.mp4')],
      image_items: [saved('i', 'face.png')],
      audio_items: [saved('n', 'narrator.mp3'), saved('z', 'Zoë 李.wav')],
    }
    const flowJson = JSON.stringify({ name: 't', version: 1, schema_version: 6, created_at: '', blocks: [{ type: 'omniReferenceLoader', config }, omni('kling-4.0')] })
    renderFlowJson(flowJson, { def: omniLoader })
    const audio = await screen.findByRole('region', { name: 'Audio' })
    expect(within(audio).queryByRole('textbox')).toBeNull()
    const props = propsFor(captured.ids[0])
    await waitFor(() => expect(props.setOutput).toHaveBeenCalledWith('audio', [
      { kind: 'audio-ref', local: '/outputs/narrator.mp3', label: 'narrator.mp3' },
      { kind: 'audio-ref', local: '/outputs/Zoë 李.wav', label: 'Zoë 李.wav' },
    ]))
    expect(props.setOutput).toHaveBeenCalledWith('video', [expect.objectContaining({ kind: 'video-ref', local: '/outputs/walk.mp4' })])
    expect(props.setOutput).toHaveBeenCalledWith('image', [expect.objectContaining({ kind: 'image-ref', local: '/outputs/face.png' })])
    expect(props.setOutput.mock.calls.some(([port]) => port === 'voice')).toBe(false)
  })

  it('keeps and flags items of a kind the model does not take', async () => {
    const config = { audio_items: [saved('s', 'song.mp3')] }
    const flowJson = JSON.stringify({ name: 't', version: 1, schema_version: 6, created_at: '', blocks: [{ type: 'omniReferenceLoader', config }, omni('kling-4.0-flash')] })
    renderFlowJson(flowJson, { def: omniLoader })
    const audio = await screen.findByRole('region', { name: 'Audio' })
    await waitFor(() => expect(within(audio).getByTestId('loader-item').getAttribute('data-flag')).toBe('unsupported'))
    expect(within(audio).getByTestId('loader-footer')).toHaveTextContent('Not supported by Kling 4.0 Flash')
  })

  it('a schema-5 flow with voices opens with them appended to Audio, after the audio', async () => {
    const config = {
      audio_items: [saved('s', 'song.mp3')],
      voice_items: [saved('n', 'narrator.mp3', { name: 'Narrator' })],
    }
    const flowJson = JSON.stringify({ name: 't', version: 1, schema_version: 5, created_at: '', blocks: [{ type: 'omniReferenceLoader', config }, omni('kling-4.0')] })
    renderFlowJson(flowJson, { def: omniLoader })
    const audio = await screen.findByRole('region', { name: 'Audio' })
    await waitFor(() => expect(within(audio).getAllByTestId('loader-item').map((li) => li.getAttribute('title'))).toEqual(['song.mp3', 'narrator.mp3']))
    const id = captured.ids[0]
    expect(sessionStorage.getItem(`block_${id}_voice_items`)).toBeNull()
  })
})

describe('Omni Reference Loader restored from an open tab', () => {
  it('folds a session voice list into Audio once, after the audio, without names', async () => {
    sessionStorage.setItem('block_O1_audio_items', JSON.stringify([saved('s', 'song.mp3')]))
    sessionStorage.setItem('block_O1_voice_items', JSON.stringify([saved('n', 'narrator.mp3', { name: 'Narrator' }), saved('s', 'song.mp3')]))
    const props = renderStandalone(omniLoader, 'O1')
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('block_O1_audio_items')!)).toEqual([
      saved('s', 'song.mp3'), saved('n', 'narrator.mp3'),
    ]))
    expect(sessionStorage.getItem('block_O1_voice_items')).toBeNull()
    await waitFor(() => expect(props.setOutput).toHaveBeenLastCalledWith('audio', [
      expect.objectContaining({ local: '/outputs/song.mp3' }),
      { kind: 'audio-ref', local: '/outputs/narrator.mp3', label: 'narrator.mp3' },
    ]))
  })

  it('folds voices into an audio list that was never saved', async () => {
    sessionStorage.setItem('block_O2_voice_items', JSON.stringify([saved('n', 'narrator.mp3', { name: 'Narrator' })]))
    renderStandalone(omniLoader, 'O2')
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('block_O2_audio_items')!)).toEqual([saved('n', 'narrator.mp3')]))
    expect(screen.getAllByTestId('loader-item').map((li) => li.getAttribute('title'))).toEqual(['narrator.mp3'])
  })

  it('leaves the audio alone when there is no voice list, or an empty or malformed one', async () => {
    sessionStorage.setItem('block_O3_audio_items', JSON.stringify([saved('s', 'song.mp3')]))
    sessionStorage.setItem('block_O3_voice_items', 'not json')
    renderStandalone(omniLoader, 'O3')
    await screen.findByRole('region', { name: 'Audio' })
    expect(JSON.parse(sessionStorage.getItem('block_O3_audio_items')!)).toEqual([saved('s', 'song.mp3')])
    expect(sessionStorage.getItem('block_O3_voice_items')).toBeNull()
  })
})

describe('config round-trip', () => {
  it('exports the ordered list with metadata and restores it on import', async () => {
    const list = [
      saved('a', 'a.png', { size_bytes: 10, width: 640, height: 480 }),
      saved('b', 'b.png', { size_bytes: 20 }),
    ]
    const { api } = renderInFlow([{ type: 'uploadImageToTmpfiles' }], { seedItems: list })
    await waitFor(() => expect(items()).toEqual(['a.png', 'b.png']))
    const exported = exportFlow(api().pipeline, 'rt')
    expect(exported.schema_version).toBe(6)
    expect(exported.blocks[0].config).toEqual({ items: list })
  })

  it('an old flow with the single-video keys still restores its video', async () => {
    const old = { name: 'old', version: 1, created_at: '', blocks: [{ type: 'videoLoader', config: { local_url: '/outputs/old.mp4', uploaded_fingerprint: '1:a' } }] }
    renderFlowJson(JSON.stringify(old), { def: videoLoader })
    await waitFor(() => expect(items()).toEqual(['old.mp4']))
    const props = propsFor(captured.ids[0])
    await waitFor(() => expect(props.setOutput).toHaveBeenLastCalledWith('video', [expect.objectContaining({ local: '/outputs/old.mp4' })]))
  })
})
