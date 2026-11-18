/**
 * Artifacts toolbar filters. Media kind lives in the URL (URL-state routing is
 * the repo convention, so the filter survives a reload). Sets were removed: no
 * Set control, and a leftover `set` param from an old link is ignored.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const replaceMock = vi.fn()
let searchParams = new URLSearchParams()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => '/artifacts',
  useSearchParams: () => searchParams,
}))

const useRunsArgs: unknown[][] = []
vi.mock('@/lib/hooks', () => ({
  useRuns: (...args: unknown[]) => {
    useRunsArgs.push(args)
    return { runs: [], total: 0, isLoading: false, error: null, mutate: vi.fn() }
  },
  useMcpJobs: () => ({ jobs: [], mutate: vi.fn() }),
  useMcpStream: () => {},
}))

vi.mock('@/components/artifacts/artifact-tile', () => ({
  ArtifactTile: () => <div>run-tile</div>,
}))

import { RunHistory } from '../run-history'
import * as hooks from '@/lib/hooks'
import * as api from '@/lib/api'

/** useRuns(limit, offset, favorited, mediaKind, promptQuery, hidePartial, source, refreshInterval) */
const MEDIA_KIND_ARG = 3

beforeEach(() => {
  replaceMock.mockClear()
  useRunsArgs.length = 0
  searchParams = new URLSearchParams()
})

describe('RunHistory without sets', () => {
  test('has no Set control', () => {
    render(<RunHistory />)
    expect(screen.queryByRole('button', { name: /^set$/i })).toBeNull()
    expect(screen.queryByText(/all sets/i)).toBeNull()
  })

  test('a leftover set param from an old link neither filters the query nor counts as a filter', () => {
    searchParams = new URLSearchParams('set=set-2')
    render(<RunHistory />)
    expect(useRunsArgs[0]).not.toContain('set-2')
    expect(screen.queryByRole('button', { name: /^clear$/i })).toBeNull()
  })

  test('the client has no sets hook or sets API calls left', async () => {
    const realHooks = await vi.importActual<typeof hooks>('@/lib/hooks')
    expect('useSets' in realHooks).toBe(false)
    for (const name of ['fetchSets', 'fetchSet', 'createSet', 'renameSet', 'deleteSet', 'addToSet', 'removeFromSet']) {
      expect(name in api).toBe(false)
    }
  })

  test('the runs request never carries a set id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, runs: [] })))
    vi.stubGlobal('fetch', fetchMock)
    // The 8th positional argument used to be the set id.
    await (api.fetchRuns as (...a: unknown[]) => Promise<unknown>)(10, 0, false, null, '', true, null, 'set-1')
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).not.toContain('set_id')
    vi.unstubAllGlobals()
  })
})

/** useRuns(limit, offset, favorited, mediaKind, promptQuery, hidePartial, source, refreshInterval) */
const FAV_ARG = 2
const HIDE_PARTIAL_ARG = 5
const SOURCE_ARG = 6

describe('RunHistory filters', () => {
  test('has the search field and one Filters button instead of the old controls', () => {
    render(<RunHistory />)
    expect(screen.getByRole('searchbox', { name: 'Search prompts' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()
    for (const old of ['All', 'Pipeline', 'MCP', 'Video', 'Image', 'Other', 'Favorites', 'Hide partial']) {
      expect(screen.queryByRole('button', { name: old })).toBeNull()
    }
  })

  test('defaults: hide partial on, no other filter, no badge', () => {
    render(<RunHistory />)
    const args = useRunsArgs[0]
    expect([args[FAV_ARG], args[MEDIA_KIND_ARG], args[HIDE_PARTIAL_ARG], args[SOURCE_ARG]]).toEqual([false, null, true, null])
    expect(screen.queryByRole('list', { name: 'Active filters' })).toBeNull()
  })

  test('legacy single-value URLs still filter and show their chips', () => {
    searchParams = new URLSearchParams('source=mcp&kind=video&fav=1&hide_partial=0')
    render(<RunHistory />)
    const args = useRunsArgs[0]
    expect([args[FAV_ARG], args[MEDIA_KIND_ARG], args[HIDE_PARTIAL_ARG], args[SOURCE_ARG]]).toEqual([true, 'video', false, 'mcp'])
    expect(screen.getByRole('button', { name: 'Filters, 4 active' })).toBeInTheDocument()
  })

  test('several kinds go to the runs query as one comma list; all of them as no filter', () => {
    searchParams = new URLSearchParams('kind=image,video')
    const { unmount } = render(<RunHistory />)
    expect(useRunsArgs.at(-1)![MEDIA_KIND_ARG]).toBe('image,video')
    unmount()
    searchParams = new URLSearchParams('kind=image,video,other&source=pipeline,mcp')
    render(<RunHistory />)
    expect(useRunsArgs.at(-1)![MEDIA_KIND_ARG]).toBeNull()
    expect(useRunsArgs.at(-1)![SOURCE_ARG]).toBeNull()
  })

  test('an unsupported kind in the URL is not sent to the runs query', () => {
    searchParams = new URLSearchParams('kind=dataset')
    render(<RunHistory />)
    expect(useRunsArgs[0][MEDIA_KIND_ARG]).toBeNull()
  })

  test('ticking a filter writes it to the URL and returns to page 1', async () => {
    searchParams = new URLSearchParams('page=3&q=fox')
    const user = userEvent.setup()
    render(<RunHistory />)
    await user.click(screen.getByRole('button', { name: 'Filters' }))
    await user.click(await screen.findByRole('checkbox', { name: 'Video' }))
    expect(replaceMock).toHaveBeenLastCalledWith('/artifacts?q=fox&kind=video', { scroll: false })
  })

  test('removing a chip writes the URL without that filter', async () => {
    searchParams = new URLSearchParams('kind=image,video&page=2')
    const user = userEvent.setup()
    render(<RunHistory />)
    await user.click(screen.getByRole('button', { name: 'Remove filter Image' }))
    expect(replaceMock).toHaveBeenLastCalledWith('/artifacts?kind=video', { scroll: false })
  })
})
