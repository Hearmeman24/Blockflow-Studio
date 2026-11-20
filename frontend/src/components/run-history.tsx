'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useMcpJobs, useMcpStream, useRuns } from '@/lib/hooks'
import { ARTIFACTS_PAGE_SIZE } from '@/lib/api'
import { EmptyState } from '@/components/empty-state'
import { AlertPanel } from '@/components/alert-panel'
import { PageHeader } from '@/components/page-header'
import { ArtifactTile } from '@/components/artifacts/artifact-tile'
import { MasonryGrid, type MasonryItem } from '@/components/artifacts/masonry-grid'
import { McpJobTile, isActiveJob, jobAspect } from '@/components/artifacts/mcp-job-tile'
import { ArtifactViewer } from '@/components/artifacts/artifact-viewer'
import { ArtifactsToolbar } from '@/components/artifacts/artifacts-toolbar'
import { DEFAULT_FILTERS, activeFilters, filtersFromParams, filtersToParams, requestFilters, type ArtifactFilters } from '@/lib/artifacts/filters'
import { runAspect } from '@/lib/artifacts/run-media'
import type { JobSnapshot } from '@/lib/types'

const PAGE_SIZE = ARTIFACTS_PAGE_SIZE

export type ArtifactsListStatus = 'loading' | 'error' | 'empty' | 'ready'

/** What the list shows, decided once. An error wins over runs kept from the previous page. */
export function artifactsListStatus({ isLoading, error, runs, placeholders }: {
  isLoading: boolean; error: unknown; runs: number; placeholders: number
}): ArtifactsListStatus {
  if (isLoading) return 'loading'
  if (error) return 'error'
  return runs === 0 && placeholders === 0 ? 'empty' : 'ready'
}
const NO_JOBS: JobSnapshot[] = []
/** Wait this long after the last MCP job event before refetching runs and jobs. */
const MCP_REFETCH_DEBOUNCE_MS = 1000

/** Mixed shapes for the loading skeleton, so it reads as a masonry grid. */
const SKELETON_ASPECTS = [0.8, 1.25, 1, 0.75, 1.5, 1, 0.8, 1.33]
const SKELETON_ITEMS: MasonryItem[] = SKELETON_ASPECTS.map((aspect, i) => ({
  key: `skeleton-${i}`,
  aspect,
  render: () => <Skeleton className="size-full rounded-lg" />,
}))

export function RunHistory() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const filters = filtersFromParams(searchParams)
  const { source, mediaKind, character, favorited: favoritesOnly, hidePartial } = requestFilters(filters)
  const urlQuery = searchParams.get('q') ?? ''
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)

  // The search box is a draft; after a pause it is written to the URL, and
  // the URL's `q` is what is searched (so Clear filters and Back apply at once).
  const [promptDraft, setPromptDraft] = useState(urlQuery)
  const [debouncedQuery, setDebouncedQuery] = useState(urlQuery)

  useEffect(() => { setPromptDraft(urlQuery) }, [urlQuery])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(promptDraft), 300)
    return () => clearTimeout(t)
  }, [promptDraft])

  const updateParams = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(changes)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    const qs = next.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  useEffect(() => {
    if (debouncedQuery === urlQuery) return
    updateParams({ q: debouncedQuery || null, page: null })
  }, [debouncedQuery]) // eslint-disable-line react-hooks/exhaustive-deps

  const offset = (page - 1) * PAGE_SIZE
  const mcpView = source === 'mcp'
  // SSE drives live updates in MCP view; the 15s poll is a fallback if the stream buffers.
  // A batch of MCP jobs sends many events and each refetch filters the whole run
  // history on the backend, so events are collapsed (MCP_REFETCH_DEBOUNCE_MS).
  const { runs, total, isLoading, error, mutate } = useRuns(
    PAGE_SIZE, offset, favoritesOnly, mediaKind, urlQuery, hidePartial, source,
    mcpView ? 15000 : 0, character,
  )
  const { jobs: mcpJobs, resource: mcpJobsResource, mutate: mutateJobs } = useMcpJobs(mcpView)
  useMcpStream(mcpView, () => { mutate(); mutateJobs() }, { debounceMs: MCP_REFETCH_DEBOUNCE_MS })

  const activeJobs = useMemo(() => mcpJobs.filter(isActiveJob), [mcpJobs])
  // Only show placeholders on page 1 (newest), where freshly-started jobs belong.
  const placeholders = mcpView && page === 1 ? activeJobs : NO_JOBS

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total])
  const startIndex = total === 0 ? 0 : offset + 1
  const endIndex = total === 0 ? 0 : offset + runs.length
  const canGoPrev = page > 1
  const canGoNext = page < totalPages
  const hasFilters = activeFilters(filters).length > 0 || urlQuery !== ''
  const list = artifactsListStatus({ isLoading, error, runs: runs.length, placeholders: placeholders.length })

  // The run open in the viewer, by id: a refresh that adds runs does not switch it.
  const [openRunId, setOpenRunId] = useState<string | null>(null)

  const tiles: MasonryItem[] = useMemo(() => [
    ...placeholders.map((job): MasonryItem => ({
      key: `job-${job.job_id}`,
      aspect: jobAspect(job),
      render: () => <McpJobTile job={job} />,
    })),
    ...runs.map((run): MasonryItem => ({
      key: `run-${run.id}`,
      aspect: runAspect(run),
      render: ({ reportAspect }) => (
        <ArtifactTile run={run} onAspect={reportAspect} onFavoriteToggled={() => mutate()} onOpen={() => setOpenRunId(run.id)} />
      ),
    })),
  ], [placeholders, runs, mutate])

  // A later page that came back empty (runs were removed) steps back one
  // page. Only a real empty answer: an error or a load in progress is not one.
  useEffect(() => {
    if (list === 'empty' && page > 1) {
      updateParams({ page: String(page - 1) })
    }
  }, [list, page]) // eslint-disable-line react-hooks/exhaustive-deps

  const setPage = (p: number) => updateParams({ page: p === 1 ? null : String(p) })
  // Any filter change goes back to page 1.
  const setFilters = (next: ArtifactFilters) => {
    const params = new URLSearchParams(searchParams.toString())
    filtersToParams(params, next)
    params.delete('page')
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }
  const clearAll = () => {
    setPromptDraft('')
    const params = new URLSearchParams(searchParams.toString())
    filtersToParams(params, DEFAULT_FILTERS)
    params.delete('q')
    params.delete('page')
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  const prevNextButtons = (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" className="h-8 px-3" disabled={!canGoPrev} onClick={() => setPage(page - 1)}>
        <ChevronLeft className="size-4" />
        Prev
      </Button>
      <Button type="button" variant="outline" size="sm" className="h-8 px-3" disabled={!canGoNext} onClick={() => setPage(page + 1)}>
        Next
        <ChevronRight className="size-4" />
      </Button>
    </div>
  )

  const countDescription = `Showing ${startIndex}–${endIndex} of ${total} ${favoritesOnly ? 'favorites' : 'runs'} · Page ${page} of ${totalPages}`

  return (
    <div className="space-y-4">
      <PageHeader
        title="Artifacts"
        description={countDescription}
      />

      <ArtifactsToolbar search={promptDraft} onSearchChange={setPromptDraft} filters={filters} onFiltersChange={setFilters} />

      {mcpView && mcpJobsResource.kind === 'error' && (
        <AlertPanel variant="warning">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>Could not load the generations in progress.</p>
            <Button type="button" variant="outline" size="xs" onClick={() => void mutateJobs()}>Retry</Button>
          </div>
        </AlertPanel>
      )}

      {list === 'loading' ? (
        <MasonryGrid items={SKELETON_ITEMS} label="Loading artifacts" />
      ) : list === 'error' ? (
        <div className="py-8 space-y-3">
          <AlertPanel variant="error" title="Failed to load artifacts">
            {error instanceof Error ? error.message : String(error)}
          </AlertPanel>
          <div className="flex justify-center">
            <Button type="button" variant="outline" size="sm" onClick={() => mutate()}>
              Retry
            </Button>
          </div>
        </div>
      ) : list === 'empty' ? (
        <EmptyState
          title={hasFilters ? 'No runs match these filters.' : mcpView ? 'No MCP generations yet.' : 'No pipeline runs yet.'}
          description={hasFilters ? undefined : mcpView ? 'Ask Claude to generate via the BlockFlow MCP — results appear here live.' : 'Run a pipeline from the Generate page to see results here.'}
          action={hasFilters ? (
            <Button type="button" variant="link" size="sm" className="text-muted-foreground/70 hover:text-foreground underline" onClick={clearAll}>
              Clear filters
            </Button>
          ) : undefined}
        />
      ) : (
        <>
          <MasonryGrid items={tiles} label="Artifacts" />
          <ArtifactViewer runs={runs} openId={openRunId} onOpenChange={setOpenRunId} onFavoriteToggled={() => mutate()} />
          {(totalPages > 1 || page > 1) && (
            <div className="flex justify-end">
              {prevNextButtons}
            </div>
          )}
        </>
      )}
    </div>
  )
}
