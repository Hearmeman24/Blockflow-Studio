/**
 * CharacterMediaSection over a fake MediaSource: drops upload one file at a
 * time in the order dropped, and a move asks the source to move the item
 * (the source decides the new order from its latest state).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/byok/probe-media', () => ({ probeMedia: vi.fn(async () => ({})) }))
vi.mock('@/lib/file-picker', () => ({ pickFiles: vi.fn() }))

import { CharacterMediaSection } from './character-media-section'
import type { MediaSource, SourceItem } from './media-source'

const png = (name: string) => new File(['x'], name, { type: 'image/png' })
const item = (id: string): SourceItem => ({ id, kind: 'image', label: id, src: `/${id}`, sizeBytes: 1, durationS: null })

function fakeSource(items: SourceItem[] = []) {
  const adds: { name: string; resolve: () => void }[] = []
  const source: MediaSource = {
    items: (kind) => (kind === 'image' ? items : []),
    defaultId: () => null,
    add: vi.fn((_kind, file: File) => new Promise<void>((resolve) => { adds.push({ name: file.name, resolve }) })),
    remove: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    setDefault: vi.fn(async () => undefined),
    removeBlocked: () => null,
  }
  return { source, adds }
}

beforeEach(() => vi.clearAllMocks())

describe('CharacterMediaSection', () => {
  it('a second drop waits for the first: one upload at a time, in the order dropped', async () => {
    const { source, adds } = fakeSource()
    render(<CharacterMediaSection source={source} kinds={['image']} />)
    const zone = screen.getByTestId('loader-drop-zone')
    fireEvent.drop(zone, { dataTransfer: { files: [png('a1.png'), png('a2.png')] } })
    fireEvent.drop(zone, { dataTransfer: { files: [png('b1.png')] } })
    await waitFor(() => expect(adds).toHaveLength(1))
    expect(screen.getAllByTestId('upload-pending')).toHaveLength(3)
    await act(async () => { adds[0].resolve() })
    await waitFor(() => expect(adds).toHaveLength(2))
    await act(async () => { adds[1].resolve() })
    await waitFor(() => expect(adds).toHaveLength(3))
    await act(async () => { adds[2].resolve() })
    expect(adds.map((a) => a.name)).toEqual(['a1.png', 'a2.png', 'b1.png'])
    await waitFor(() => expect(screen.queryByTestId('upload-pending')).toBeNull())
  })

  it('moving asks the source to move that item, with the locked ones', async () => {
    const { source } = fakeSource([item('m1'), item('m2'), item('m3')])
    const user = userEvent.setup()
    render(<CharacterMediaSection source={source} kinds={['image']} lockedIds={['m1']} />)
    await user.click(screen.getByRole('button', { name: 'Move m2 later' }))
    expect(source.move).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }), 1, ['m1'])
  })
})
