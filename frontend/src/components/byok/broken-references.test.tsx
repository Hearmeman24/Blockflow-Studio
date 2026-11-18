/**
 * Saved references that can no longer be found are marked on the item (text
 * and icon), never dropped, and can be replaced or removed. References live
 * in the loaders (Image Loader, Omni Reference Loader with video, images and audio).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import '@/components/pipeline/custom_blocks/_register'
import { blockDef as imageLoader } from '@/components/pipeline/custom_blocks/generated/upload_image_to_tmpfiles'
import { blockDef as omniLoader } from '@/components/pipeline/custom_blocks/generated/omni_reference_loader'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'
import { pickFiles } from '@/lib/file-picker'
import { getBlockDef } from '@/lib/pipeline/registry'
import { getRunBlockers } from '@/lib/pipeline/run-blockers'
import { blockProps, latestExecute, renderGenerationBlock, stubGenerationFetch, type Harness } from '@/test-utils/byok-harness'

vi.mock('@/lib/file-picker', () => ({ pickFiles: vi.fn() }))
vi.mock('@/lib/byok/probe-media', () => ({ probeMedia: vi.fn(async () => ({})) }))

type Status = 'ok' | 'missing_local' | 'expired' | 'unreachable' | 'malformed' | 'unchecked'
let statusFor: (ref: { local?: string; url?: string }) => Status = () => 'ok'
let routeDown = false
let harness: Harness

function stub() {
  harness = stubGenerationFetch({
    catalog: CATALOG_BOTH,
    checkReferences: (body) => routeDown
      ? { status: 502, body: { error: 'down' } }
      : { body: { ok: true, results: body.references.map((r, index) => ({ index, status: statusFor(r), detail: `Detail for ${r.local ?? r.url}.` })) } },
  })
}

beforeEach(() => {
  sessionStorage.clear()
  statusFor = () => 'ok'
  routeDown = false
  vi.mocked(pickFiles).mockReset().mockResolvedValue(null)
  stub()
})
afterEach(() => vi.unstubAllGlobals())

function seed(blockId: string, values: Record<string, unknown>) {
  for (const [k, v] of Object.entries(values)) sessionStorage.setItem(`block_${blockId}_${k}`, JSON.stringify(v))
}

const item = (label: string, extra: Record<string, unknown> = {}) => ({ id: label, label, local: `/outputs/${label}`, status: 'ready', ...extra })
const statusOf = (label: string) => {
  const tile = screen.getAllByTestId('loader-item').find((li) => li.getAttribute('title') === label)!
  return within(tile).queryByTestId('item-status')
}

function renderOmniLoader(blockId: string, lists: Record<string, unknown[]>) {
  seed(blockId, lists)
  const props = blockProps(blockId)
  renderGenerationBlock(omniLoader.component, props)
  return props
}

const OMNI_LISTS = {
  image_items: [item('face.png')],
  video_items: [item('motion.mp4')],
  audio_items: [item('song.mp3'), item('voice.mp3')],
}

describe('broken references in the Omni Reference Loader', () => {
  it('marks each broken status on its item with text and an icon, never dropping anything', async () => {
    const statuses: Record<string, Status> = {
      '/outputs/face.png': 'missing_local',
      '/outputs/motion.mp4': 'expired',
      '/outputs/song.mp3': 'unreachable',
      '/outputs/voice.mp3': 'malformed',
    }
    statusFor = (r) => statuses[r.local ?? r.url ?? ''] ?? 'ok'
    renderOmniLoader('o1', OMNI_LISTS)
    await waitFor(() => expect(statusOf('face.png')).toHaveTextContent('File not found'))
    expect(statusOf('motion.mp4')).toHaveTextContent('Link expired')
    expect(statusOf('song.mp3')).toHaveTextContent('Unreachable')
    expect(statusOf('voice.mp3')).toHaveTextContent('Invalid reference')
    expect(statusOf('face.png')!.querySelector('svg')).not.toBeNull()
    expect(statusOf('face.png')!.getAttribute('title')).toBe('Detail for /outputs/face.png.')
    for (const [key, list] of Object.entries(OMNI_LISTS)) expect(JSON.parse(sessionStorage.getItem(`block_o1_${key}`)!)).toHaveLength(list.length)
    expect(getRunBlockers('o1')).toEqual([
      'has a broken reference: motion.mp4 (Link expired)',
      'has a broken reference: face.png (File not found)',
      'has 2 broken references: song.mp3 (Unreachable), voice.mp3 (Invalid reference)',
    ])
  })

  it('shows a provider asset as not verified, not broken', async () => {
    statusFor = () => 'unchecked'
    renderOmniLoader('o2', { image_items: [{ id: 'asset', label: 'library image', url: 'asset://abc', status: 'ready' }] })
    await waitFor(() => expect(statusOf('library image')).toHaveTextContent('Not verified'))
    expect(screen.queryByRole('button', { name: /Replace/ })).toBeNull()
    expect(getRunBlockers('o2')).toEqual([])
  })

  it('Replace keeps an audio clip in place; Remove drops only that item', async () => {
    statusFor = (r) => (r.local === '/outputs/voice.mp3' ? 'missing_local' : 'ok')
    renderOmniLoader('o3', { audio_items: [item('a.mp3'), item('voice.mp3'), item('c.mp3')] })
    await waitFor(() => expect(statusOf('voice.mp3')).toHaveTextContent('File not found'))
    vi.mocked(pickFiles).mockResolvedValue([new File(['x'], 'new-voice.mp3', { type: 'audio/mpeg' })])
    fireEvent.click(screen.getByRole('button', { name: 'Replace voice.mp3' }))
    await waitFor(() => {
      const saved = JSON.parse(sessionStorage.getItem('block_o3_audio_items')!)
      expect(saved[1]).toMatchObject({ id: 'voice.mp3', label: 'new-voice.mp3', local: '/outputs/new-voice.mp3', status: 'ready' })
      expect(saved[1]).not.toHaveProperty('name')
    })
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove c.mp3' }))
    expect(JSON.parse(sessionStorage.getItem('block_o3_audio_items')!).map((i: { id: string }) => i.id)).toEqual(['a.mp3', 'voice.mp3'])
  })

  it('checks each list once in one batch, and not at all when empty', async () => {
    renderOmniLoader('o4', { image_items: [item('a.png'), item('b.png')] })
    await waitFor(() => expect(harness.requests('/api/generation/check-references')).toHaveLength(1))
    const [body] = harness.requests('/api/generation/check-references') as Array<{ references: unknown[] }>
    expect(body.references).toHaveLength(2)
  })
})

describe('broken items in the Image Loader', () => {
  it('marks a missing local file, keeps the other items, and Replace keeps its position', async () => {
    seed('L', { items: [item('a.png'), item('b.png'), item('c.png')] })
    statusFor = (r) => (r.local === '/outputs/b.png' ? 'missing_local' : 'ok')
    renderGenerationBlock(imageLoader.component, blockProps('L'))
    await waitFor(() => expect(statusOf('b.png')).toHaveTextContent('File not found'))
    expect(screen.getByTestId('loader-notice')).toHaveTextContent('1 file could not be found. Replace or remove it.')
    expect(getRunBlockers('L')).toEqual(['has a broken reference: b.png (File not found)'])

    vi.mocked(pickFiles).mockResolvedValue([new File(['x'], 'b2.png', { type: 'image/png' })])
    fireEvent.click(screen.getByRole('button', { name: 'Replace b.png' }))
    await waitFor(() => expect(screen.getAllByTestId('loader-item').map((li) => li.getAttribute('title'))).toEqual(['a.png', 'b2.png', 'c.png']))
    expect(JSON.parse(sessionStorage.getItem('block_L_items')!)[1]).toMatchObject({ id: 'b.png', label: 'b2.png', local: '/outputs/b2.png' })
    await waitFor(() => expect(getRunBlockers('L')).toEqual([]))
  })

  it('Re-check asks again and clears marks that are fixed', async () => {
    seed('L3', { items: [item('a.png')] })
    statusFor = () => 'missing_local'
    renderGenerationBlock(imageLoader.component, blockProps('L3'))
    await waitFor(() => expect(statusOf('a.png')).toHaveTextContent('File not found'))
    statusFor = () => 'ok'
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }))
    await waitFor(() => expect(harness.requests('/api/generation/check-references')).toHaveLength(2))
    await waitFor(() => expect(statusOf('a.png')).toBeNull())
  })

  it('says "could not verify" when the route fails, marking nothing broken', async () => {
    seed('L2', { items: [item('a.png')] })
    routeDown = true
    renderGenerationBlock(imageLoader.component, blockProps('L2'))
    expect(await screen.findByText('Could not verify the saved files.')).toBeInTheDocument()
    expect(screen.queryByTestId('item-status')).toBeNull()
    expect(getRunBlockers('L2')).toEqual([])
    routeDown = false
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Re-check' })) })
    await waitFor(() => expect(screen.queryByText('Could not verify the saved files.')).toBeNull())
  })

  it('execute refuses a broken item with a message naming it', async () => {
    seed('L4', { items: [item('face.png')] })
    statusFor = () => 'missing_local'
    const props = blockProps('L4')
    renderGenerationBlock(imageLoader.component, props)
    await waitFor(() => expect(statusOf('face.png')).not.toBeNull())
    await expect(latestExecute(props)({}, new AbortController().signal)).rejects.toThrow(/^face.png: Detail for \/outputs\/face.png. Replace or remove it.$/)
  })
})

describe('empty reference blocks', () => {
  it.each([['imageToImage'], ['omniReferenceToVideo']])('%s shows a neutral hint until used, then the error', async (type) => {
    const props = blockProps(`empty-${type}`)
    renderGenerationBlock(getBlockDef(type)!.component, props)
    await screen.findByRole('combobox', { name: 'Model' })
    const hint = await screen.findByTestId('reference-hint')
    expect(hint).toHaveTextContent(/needs at least 1/)
    expect(screen.queryByText(/Fix (this issue|these issues) to run|Fix before running/)).toBeNull()

    // A run attempt turns it into the blocking error.
    harness.fetchMock.mockClear()
    await act(async () => {
      await latestExecute(props)({}, new AbortController().signal).catch(() => undefined)
    })
    await waitFor(() => expect(screen.queryByTestId('reference-hint')).toBeNull())
    const errors = screen.getAllByText(/needs at least 1/)
    expect(errors.length).toBeGreaterThan(0)
    for (const el of errors) expect(el.closest('[class*="border-destructive"]')).not.toBeNull()
  })
})
