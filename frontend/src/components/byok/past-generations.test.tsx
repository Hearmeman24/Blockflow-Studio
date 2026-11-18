/**
 * The Image Loader's past-generations gallery: paging quickly never shows a
 * page whose answer arrived late. Fetch is mocked at the HTTP boundary, and
 * each page answer is held until released.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import '@/components/pipeline/custom_blocks/_register'
import { blockDef as imageLoader } from '@/components/pipeline/custom_blocks/generated/upload_image_to_tmpfiles'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'
import { blockProps } from '@/test-utils/byok-harness'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Held answers to `/api/images`, in request order: `[offset, answer]`. */
let pages: Array<{ offset: number; answer: (body: unknown, status?: number) => void; signal?: AbortSignal | null }>

beforeEach(() => {
  sessionStorage.clear()
  pages = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/providers/catalog') return json(CATALOG_BOTH)
    if (url.startsWith('/api/images')) {
      const offset = Number(new URL(url, 'http://x').searchParams.get('offset'))
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        pages.push({ offset, answer: (body, status = 200) => resolve(json(body, status)), signal: init?.signal })
      })
    }
    return json({ ok: true })
  }))
})
afterEach(() => vi.unstubAllGlobals())

const page = (offset: number) => ({
  ok: true,
  total: 48,
  images: [{ url: `/outputs/p${offset}.png`, name: `p${offset}.png`, created_at: 1 }],
})

async function openGallery() {
  const Comp = imageLoader.component
  render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><Comp {...blockProps('L1')} /></SWRConfig>)
  fireEvent.click(screen.getByRole('button', { name: 'Add from past generations' }))
  await waitFor(() => expect(pages).toHaveLength(1))
}

async function answer(index: number, body: unknown, status?: number) {
  await act(async () => {
    pages[index].answer(body, status)
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('past generations paging', () => {
  it('shows the page asked for last, even when an earlier answer arrives after it', async () => {
    await openGallery()
    await answer(0, page(0))
    expect(await screen.findByRole('button', { name: 'Add p0.png' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(pages).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Prev' }))
    await waitFor(() => expect(pages).toHaveLength(3))
    expect(pages.map((p) => p.offset)).toEqual([0, 24, 0])

    await answer(2, page(0))
    // The answer for page 2 arrives last; it must not replace page 1.
    await act(async () => {
      try { pages[1].answer(page(24)) } catch { /* aborted */ }
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.getByText('Page 1 / 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add p0.png' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add p24.png' })).toBeNull()
  })

  it('a late failure of an abandoned page does not show an error', async () => {
    await openGallery()
    await answer(0, page(0))
    await screen.findByRole('button', { name: 'Add p0.png' })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(pages).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Prev' }))
    await waitFor(() => expect(pages).toHaveLength(3))
    await answer(2, page(0))
    await act(async () => {
      try { pages[1].answer({ ok: false, error: 'boom' }, 500) } catch { /* aborted */ }
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.queryByText('Could not load past generations')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add p0.png' })).toBeInTheDocument()
  })

  it('keeps its loading, empty and error states', async () => {
    await openGallery()
    expect(screen.getByLabelText('Loading past generations')).toBeInTheDocument()
    await answer(0, { ok: false, error: 'boom' }, 500)
    expect(await screen.findByText('Could not load past generations')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(pages).toHaveLength(2))
    await answer(1, { ok: true, total: 0, images: [] })
    expect(await screen.findByText('No generated images yet')).toBeInTheDocument()
  })
})
