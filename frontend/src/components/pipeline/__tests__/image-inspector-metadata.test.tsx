/**
 * image_inspector reads embedded generation metadata through the shared
 * `GET /api/file-metadata/{filename}` route (backend/routes.py), which returns
 * `{ok, has_meta, meta}`. The block previously called a route owned by a
 * removed block.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { blockDef, fetchMeta } from '../custom_blocks/generated/image_inspector'
import { pickFiles } from '@/lib/file-picker'

vi.mock('@/lib/file-picker', () => ({
  pickFiles: vi.fn(),
}))

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('image_inspector metadata', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:preview', revokeObjectURL: () => {} }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetchMeta GETs the shared file-metadata route for an /outputs file', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, has_meta: true, meta: { prompt: 'p', seed: 7 } }))
    vi.stubGlobal('fetch', fetchMock)

    const meta = await fetchMeta('/outputs/shot 1.png?v=2')

    expect(fetchMock).toHaveBeenCalledWith('/api/file-metadata/shot%201.png')
    expect(meta).toEqual({ prompt: 'p', seed: 7 })
  })

  it('fetchMeta returns null without a request for non-output URLs, and when no metadata exists', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: false, has_meta: false }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchMeta('https://example.com/a.png')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()

    expect(await fetchMeta('/outputs/a.png')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('renders metadata read for a loaded image', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/blocks/upload_image_to_tmpfiles/save-local') {
        return jsonResponse({ ok: true, image_url: '/outputs/fox.png' })
      }
      if (url === '/api/file-metadata/fox.png') {
        return jsonResponse({ ok: true, has_meta: true, meta: { prompt: 'a red fox', seed: 42, model: 'seedream' } })
      }
      return jsonResponse({ ok: false }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
    const file = new File([new Uint8Array([1, 2, 3])], 'fox.png', { type: 'image/png' })
    vi.mocked(pickFiles).mockResolvedValue([file])

    const Comp = blockDef.component
    render(
      <Comp
        blockId="ii1"
        inputs={{}}
        setOutput={vi.fn()}
        registerExecute={() => {}}
        setStatusMessage={vi.fn()}
      />,
    )

    await userEvent.setup().click(screen.getByRole('button', { name: /load images/i }))

    expect(await screen.findByText('a red fox')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('seedream')).toBeInTheDocument()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/file-metadata/fox.png'))
    // The save sends the File itself (streamed by the browser), not a copy in memory.
    const save = fetchMock.mock.calls.find(([url]) => url === '/api/blocks/upload_image_to_tmpfiles/save-local') as
      | unknown[]
      | undefined
    expect((save?.[1] as RequestInit).body).toBe(file)
  })
})
