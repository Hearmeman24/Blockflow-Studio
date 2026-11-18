/**
 * The Artifacts page and the character filter: the URL's `character` ids reach
 * the runs request, changing the filter goes back to page 1, and a filter with
 * no matches shows the "no results for these filters" state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'

const A = `char_${'a'.repeat(32)}`
const B = `char_${'b'.repeat(32)}`
const nav = vi.hoisted(() => ({ search: '', replace: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => '/artifacts',
  useSearchParams: () => new URLSearchParams(nav.search),
}))
vi.mock('@/lib/characters/use-characters', async (orig) => ({
  ...(await orig<typeof import('@/lib/characters/use-characters')>()),
  useCharacters: () => ({
    characters: [
      { id: A, name: 'Mira Ñandú', description: '', created_at: '', updated_at: '', default_face_id: null, default_audio_id: null, media: [] },
      { id: B, name: 'Bo', description: '', created_at: '', updated_at: '', default_face_id: null, default_audio_id: null, media: [] },
    ],
    error: undefined,
    isLoading: false,
  }),
}))

import { RunHistory } from './run-history'

const runsUrls = () => vi.mocked(fetch).mock.calls.map(([u]) => new URL(String(u), 'http://x')).filter((u) => u.pathname === '/api/runs')

beforeEach(() => {
  nav.search = ''
  nav.replace.mockReset()
  vi.stubGlobal('EventSource', class { onmessage = null; close() {} })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, runs: [], total: 0, limit: 25, offset: 0 }))))
})

const renderPage = () => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><RunHistory /></SWRConfig>)

describe('RunHistory character filter', () => {
  it('sends the ids from the URL as one character param, together with the other filters', async () => {
    nav.search = `character=${A},${B}&source=mcp&kind=image`
    renderPage()
    await waitFor(() => expect(runsUrls().length).toBeGreaterThan(0))
    const url = runsUrls()[0]
    expect(url.searchParams.get('character')).toBe(`${A},${B}`)
    expect(url.searchParams.get('source')).toBe('mcp')
    expect(url.searchParams.get('media_kind')).toBe('image')
  })

  it('sends no character param when none is in the URL, and drops malformed ids', async () => {
    nav.search = 'character=bogus'
    renderPage()
    await waitFor(() => expect(runsUrls().length).toBeGreaterThan(0))
    expect(runsUrls()[0].searchParams.has('character')).toBe(false)
  })

  it('ticking a character writes it to the URL and goes back to page 1', async () => {
    nav.search = 'page=3&q='
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: /^Filters/ }))
    await user.click(await screen.findByRole('checkbox', { name: 'Mira Ñandú' }))
    const target = new URL(String(nav.replace.mock.calls.at(-1)![0]), 'http://x')
    expect(target.searchParams.get('character')).toBe(A)
    expect(target.searchParams.has('page')).toBe(false)
  })

  it('refetches from the first page when the character filter changes', async () => {
    nav.search = 'page=2'
    const { rerender } = renderPage()
    await waitFor(() => expect(runsUrls().at(-1)?.searchParams.get('offset')).toBe('25'))
    nav.search = `character=${A}`
    rerender(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><RunHistory /></SWRConfig>)
    await waitFor(() => {
      const last = runsUrls().at(-1)!
      expect(last.searchParams.get('character')).toBe(A)
      expect(last.searchParams.get('offset')).toBe('0')
    })
  })

  it('shows the no-results state with a way out when a character filter matches nothing', async () => {
    nav.search = `character=${A}`
    renderPage()
    expect(await screen.findByText('No runs match these filters.')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear filters' }))
    const target = nav.replace.mock.calls.at(-1)![0] as string
    expect(target).not.toContain('character')
  })

  it('an error answer without ok:false is an error, not "No pipeline runs yet"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Internal Server Error' }), { status: 500 })))
    renderPage()
    expect(await screen.findByText('Failed to load artifacts')).toBeInTheDocument()
    expect(screen.getByText('Internal Server Error')).toBeInTheDocument()
    expect(screen.queryByText(/no pipeline runs/i)).toBeNull()
  })
})
