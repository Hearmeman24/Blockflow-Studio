/**
 * Tests for RunHistory component — Phase 3 (states) + Phase 4 (layout).
 * Mocks useRuns at the hook boundary and next/navigation for URL state.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ── next/navigation ──────────────────────────────────────────────────────────
const replaceMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => '/artifacts',
  useSearchParams: () => searchParams,
}))
let searchParams = new URLSearchParams()

// ── useRuns hook ──────────────────────────────────────────────────────────────
const mutateMock = vi.fn()
interface UseRunsReturn {
  runs: never[]
  total: number
  isLoading: boolean
  error: Error | null
  mutate: typeof mutateMock
}

const defaultUseRuns: UseRunsReturn = {
  runs: [],
  total: 0,
  isLoading: false,
  error: null,
  mutate: mutateMock,
}
let useRunsReturn: UseRunsReturn = { ...defaultUseRuns }

let mcpJobs: unknown[] = []
const useRunsArgs: unknown[][] = []
vi.mock('@/lib/hooks', () => ({
  useRuns: (...args: unknown[]) => {
    useRunsArgs.push(args)
    return useRunsReturn
  },
  useMcpJobs: () => ({ jobs: mcpJobs, mutate: vi.fn() }),
  useMcpStream: () => {},
}))

// ── ArtifactTile — tested on its own ─────────────────────────────────────────
vi.mock('@/components/artifacts/artifact-tile', () => ({
  ArtifactTile: ({ run, onOpen }: { run: { id: string }; onOpen?: () => void }) => (
    <button type="button" data-testid={`run-tile-${run.id}`} onClick={onOpen}>run-tile</button>
  ),
}))

// ── ArtifactViewer — tested on its own; here only what it is given ───────────
vi.mock('@/components/artifacts/artifact-viewer', () => ({
  ArtifactViewer: ({ runs, index, onIndexChange }: { runs: { id: string }[]; index: number | null; onIndexChange: (i: number | null) => void }) =>
    index === null ? null : (
      <div role="dialog" aria-label="viewer">
        {`showing ${runs[index].id} of ${runs.map((r) => r.id).join(',')}`}
        <button type="button" onClick={() => onIndexChange(index + 1)}>next</button>
      </div>
    ),
}))

import { RunHistory } from '../run-history'

// ─────────────────────────────────────────────────────────────────────────────

describe('RunHistory', () => {
  beforeEach(() => {
    useRunsReturn = { ...defaultUseRuns }
    searchParams = new URLSearchParams()
    mcpJobs = []
    useRunsArgs.length = 0
    mutateMock.mockClear()
    replaceMock.mockClear()
  })

  // ── Phase 4: PageHeader ───────────────────────────────────────────────────

  describe('PageHeader', () => {
    test('renders "Artifacts" as an h1', () => {
      render(<RunHistory />)
      expect(screen.getByRole('heading', { level: 1, name: 'Artifacts' })).toBeInTheDocument()
    })

    test('shows count and range in description when runs exist', () => {
      useRunsReturn = {
        ...defaultUseRuns,
        runs: [{ id: 'r1', block_results: [] } as never],
        total: 10,
      }
      render(<RunHistory />)
      // "Showing 1–1 of 10 runs" or similar — just assert both numbers appear near header
      const desc = screen.getByText(/showing/i)
      expect(desc).toBeInTheDocument()
      expect(desc.textContent).toMatch(/10/)
    })

    test('description shows "0" total when there are no runs', () => {
      render(<RunHistory />)
      const desc = screen.getByText(/showing/i)
      expect(desc.textContent).toMatch(/0/)
    })
  })

  // ── Phase 3a: Loading skeleton ────────────────────────────────────────────

  describe('loading skeleton', () => {
    test('renders skeleton cards while loading, not the empty text', () => {
      useRunsReturn = { ...defaultUseRuns, isLoading: true }
      const { container } = render(<RunHistory />)

      // Must NOT show the old "Loading history…" text
      expect(screen.queryByText(/loading history/i)).not.toBeInTheDocument()
      // Must NOT show EmptyState
      expect(screen.queryByText(/no pipeline runs/i)).not.toBeInTheDocument()
      // Must show animated skeleton placeholders
      const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
      expect(skeletons.length).toBeGreaterThanOrEqual(6)
    })

    test('skeleton tiles are laid out in the same masonry grid, in mixed shapes', () => {
      useRunsReturn = { ...defaultUseRuns, isLoading: true }
      render(<RunHistory />)
      const grid = screen.getByRole('list', { name: 'Loading artifacts' })
      const cells = grid.querySelectorAll('[data-masonry-cell]')
      expect(cells.length).toBeGreaterThanOrEqual(6)
      expect(grid.querySelectorAll('[data-slot="skeleton"]').length).toBe(cells.length)
    })

    test('skeleton does not render run tiles', () => {
      useRunsReturn = { ...defaultUseRuns, isLoading: true }
      render(<RunHistory />)
      expect(screen.queryByTestId(/run-tile-/)).not.toBeInTheDocument()
    })
  })

  // ── Phase 3b: Error state ─────────────────────────────────────────────────

  describe('error state', () => {
    test('renders a visually distinct error state on fetch failure', () => {
      useRunsReturn = {
        ...defaultUseRuns,
        error: new Error('Network error'),
      }
      render(<RunHistory />)

      // Must show error messaging
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument()
      // Must NOT show empty-state copy for "no runs"
      expect(screen.queryByText(/no pipeline runs/i)).not.toBeInTheDocument()
    })

    test('error state shows the error message or a generic label', () => {
      useRunsReturn = {
        ...defaultUseRuns,
        error: new Error('connection refused'),
      }
      render(<RunHistory />)
      // Either the raw message or a human-readable description is present
      const errEl = screen.getByText(/failed to load/i)
      expect(errEl).toBeInTheDocument()
    })

    test('error state offers a Retry button that calls mutate', async () => {
      const user = userEvent.setup()
      useRunsReturn = {
        ...defaultUseRuns,
        error: new Error('oops'),
      }
      render(<RunHistory />)

      const retryBtn = screen.getByRole('button', { name: /retry/i })
      expect(retryBtn).toBeInTheDocument()
      await user.click(retryBtn)
      expect(mutateMock).toHaveBeenCalledTimes(1)
    })

    test('error state is visually distinct from empty state (different element/text)', () => {
      // Render error state
      useRunsReturn = { ...defaultUseRuns, error: new Error('fail') }
      const { unmount } = render(<RunHistory />)
      const errorEl = screen.getByText(/failed to load/i)
      expect(errorEl).toBeInTheDocument()
      unmount()

      // Render empty state
      useRunsReturn = { ...defaultUseRuns }
      render(<RunHistory />)
      expect(screen.queryByText(/failed to load/i)).not.toBeInTheDocument()
      expect(screen.getByText(/no pipeline runs/i)).toBeInTheDocument()
    })
  })

  // ── Empty state (still works) ─────────────────────────────────────────────

  describe('empty state', () => {
    test('shows empty state when genuinely empty (no error, not loading)', () => {
      render(<RunHistory />)
      expect(screen.getByText(/no pipeline runs/i)).toBeInTheDocument()
    })

    test('does not show error or skeleton in empty state', () => {
      const { container } = render(<RunHistory />)
      expect(screen.queryByText(/failed to load/i)).not.toBeInTheDocument()
      const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
      expect(skeletons.length).toBe(0)
    })
  })

  // ── Page size and pager ───────────────────────────────────────────────────

  describe('pages of 25', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, block_results: [], flow_snapshot: {} }) as never)

    test('asks for 25 runs per page and says which ones it shows', () => {
      useRunsReturn = { ...defaultUseRuns, runs: many(25), total: 30 }
      render(<RunHistory />)
      expect(useRunsArgs[0].slice(0, 2)).toEqual([25, 0])
      expect(screen.getByText('Showing 1–25 of 30 runs · Page 1 of 2')).toBeInTheDocument()
    })

    test('has one pager, below the grid', () => {
      useRunsReturn = { ...defaultUseRuns, runs: many(25), total: 30 }
      render(<RunHistory />)
      const prev = screen.getAllByRole('button', { name: /prev/i })
      expect(prev).toHaveLength(1)
      expect(screen.getAllByRole('button', { name: /next/i })).toHaveLength(1)
      const grid = screen.getByRole('list', { name: 'Artifacts' })
      expect(grid.compareDocumentPosition(prev[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    test('hides the pager when everything fits on one page', () => {
      useRunsReturn = { ...defaultUseRuns, runs: many(3), total: 3 }
      render(<RunHistory />)
      expect(screen.queryByRole('button', { name: /prev/i })).toBeNull()
      expect(screen.queryByRole('button', { name: /next/i })).toBeNull()
      expect(screen.getByText('Showing 1–3 of 3 runs · Page 1 of 1')).toBeInTheDocument()
    })
  })

  // ── Runs grid still renders when data present ─────────────────────────────

  describe('runs grid', () => {
    test('renders one masonry tile per run when data is loaded', () => {
      useRunsReturn = {
        ...defaultUseRuns,
        runs: [
          { id: 'r1', block_results: [], flow_snapshot: {} } as never,
          { id: 'r2', block_results: [], flow_snapshot: {} } as never,
        ],
        total: 2,
      }
      render(<RunHistory />)
      const grid = screen.getByRole('list', { name: 'Artifacts' })
      expect(grid).toContainElement(screen.getByTestId('run-tile-r1'))
      expect(grid).toContainElement(screen.getByTestId('run-tile-r2'))
    })

    test('clicking a tile opens the viewer on that run, with the page\'s runs in grid order', async () => {
      useRunsReturn = {
        ...defaultUseRuns,
        runs: ['r1', 'r2', 'r3'].map((id) => ({ id, block_results: [], flow_snapshot: {} }) as never),
        total: 3,
      }
      const user = userEvent.setup()
      render(<RunHistory />)
      expect(screen.queryByRole('dialog')).toBeNull()
      await user.click(screen.getByTestId('run-tile-r2'))
      expect(screen.getByRole('dialog')).toHaveTextContent('showing r2 of r1,r2,r3')
      await user.click(screen.getByRole('button', { name: 'next' }))
      expect(screen.getByRole('dialog')).toHaveTextContent('showing r3 of r1,r2,r3')
    })

    test('in the MCP view, jobs still generating are tiles in the same grid, first', () => {
      searchParams = new URLSearchParams('source=mcp')
      mcpJobs = [{
        job_id: 'j1', source: 'mcp', provider: 'kie', model: 'seedream-5.5', mode: 'text_to_image', status: 'RUNNING',
        progress: 0.5, outputs: [], request: { aspect_ratio: '16:9' }, created_at: 1,
      }]
      useRunsReturn = { ...defaultUseRuns, runs: [{ id: 'r1', block_results: [], flow_snapshot: {} } as never], total: 1 }
      render(<RunHistory />)
      const grid = screen.getByRole('list', { name: 'Artifacts' })
      const cells = grid.querySelectorAll('[data-masonry-cell]')
      expect(cells).toHaveLength(2)
      expect(cells[0]).toContainElement(screen.getByRole('status', { name: 'Generating with seedream-5.5' }))
      expect(cells[1]).toContainElement(screen.getByTestId('run-tile-r1'))
    })
  })
})
