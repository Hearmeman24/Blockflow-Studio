/**
 * Two saves of one loader item racing: Replace clicked twice on a failed item
 * before the first file is saved. The newest file wins whichever save answers
 * last, and a run waits for every save still running.
 * Fetch is mocked at the HTTP boundary; save answers are held until released.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import '@/components/pipeline/custom_blocks/_register'
import { blockDef as imageLoader } from '@/components/pipeline/custom_blocks/generated/upload_image_to_tmpfiles'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'
import { pickFiles } from '@/lib/file-picker'
import { probeMedia } from '@/lib/byok/probe-media'
import { blockProps, latestExecute } from '@/test-utils/byok-harness'

vi.mock('@/lib/file-picker', () => ({ pickFiles: vi.fn() }))
vi.mock('@/lib/byok/probe-media', () => ({ probeMedia: vi.fn(async () => ({})) }))

const png = (name: string) => new File([new Uint8Array(100)], name, { type: 'image/png' })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Save answers held per file name until `release(name)`. */
let held: Map<string, (ok: boolean) => void>
let savesStarted: string[]

beforeEach(() => {
  sessionStorage.clear()
  held = new Map()
  savesStarted = []
  vi.mocked(pickFiles).mockReset()
  vi.mocked(probeMedia).mockReset().mockResolvedValue({})
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/providers/catalog') return json(CATALOG_BOTH)
    if (url === '/api/generation/check-references') {
      const refs = JSON.parse(String(init?.body)).references as unknown[]
      return json({ ok: true, results: refs.map((_, index) => ({ index, status: 'ok', detail: '' })) })
    }
    if (url.includes('/save-local')) {
      const name = new Headers(init?.headers).get('X-Filename') ?? 'file'
      savesStarted.push(name)
      const ok = await new Promise<boolean>((resolve) => held.set(name, resolve))
      return ok ? json({ ok: true, image_url: `/outputs/${name}` }) : json({ ok: false, error: 'disk full' })
    }
    return json({ ok: true })
  }))
})
afterEach(() => vi.unstubAllGlobals())

async function release(name: string, ok = true) {
  await act(async () => {
    held.get(name)!(ok)
    await new Promise((r) => setTimeout(r, 0))
  })
}

function renderWithFailedItem() {
  sessionStorage.setItem('block_L1_items', JSON.stringify([{ id: 'a', label: 'a.png', status: 'error', error: 'Could not save the file: boom' }]))
  const props = blockProps('L1')
  const Comp = imageLoader.component
  render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><Comp {...props} /></SWRConfig>)
  return props
}

/** Click Replace twice before either file is saved. */
async function replaceTwice() {
  vi.mocked(pickFiles).mockResolvedValueOnce([png('first.png')]).mockResolvedValueOnce([png('second.png')])
  const button = screen.getByRole('button', { name: 'Replace a.png' })
  fireEvent.click(button)
  fireEvent.click(button)
  await waitFor(() => expect(savesStarted.sort()).toEqual(['first.png', 'second.png']))
}

const stored = () => JSON.parse(sessionStorage.getItem('block_L1_items') ?? '[]')

describe('two saves of one item', () => {
  it('the UI can start them: Replace stays clickable until the first file is checked', async () => {
    renderWithFailedItem()
    await replaceTwice()
    expect(savesStarted).toHaveLength(2)
  })

  it('keeps the newest file when the older save answers last', async () => {
    renderWithFailedItem()
    await replaceTwice()
    await release('second.png')
    await release('first.png')
    await waitFor(() => expect(stored()).toEqual([
      expect.objectContaining({ id: 'a', label: 'second.png', local: '/outputs/second.png', status: 'ready' }),
    ]))
  })

  it('ignores a failure of the older save once the newer one is saved', async () => {
    renderWithFailedItem()
    await replaceTwice()
    await release('second.png')
    await release('first.png', false)
    await waitFor(() => expect(stored()[0]).toEqual(expect.objectContaining({ label: 'second.png', status: 'ready' })))
    expect(stored()[0].error).toBeUndefined()
  })

  it('a run waits for the newer save even after the older one finished', async () => {
    const props = renderWithFailedItem()
    await replaceTwice()
    await release('first.png')
    let settled = false
    let run!: Promise<unknown>
    act(() => {
      run = latestExecute(props)({}, new AbortController().signal).finally(() => { settled = true })
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(settled).toBe(false)
    await release('second.png')
    await act(async () => { await run })
    expect(props.setOutput).toHaveBeenLastCalledWith('image', expect.objectContaining({ local: '/outputs/second.png', label: 'second.png' }))
    expect(props.setStatusMessage).toHaveBeenLastCalledWith('1 image ready')
  })
})
