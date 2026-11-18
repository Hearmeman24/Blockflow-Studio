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
const NO_JOBS: JobSnapshot[] = []

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
  const { runs, total, isLoading, error, mutate } = useRuns(
    PAGE_SIZE, offset, favoritesOnly, mediaKind, debouncedQuery, hidePartial, source,
    mcpView ? 15000 : 0, character,
  )
  const { jobs: mcpJobs, mutate: mutateJobs } = useMcpJobs(mcpView)
  useMcpStream(mcpView, () => { mutate(); mutateJobs() })

  const activeJobs = useMemo(() => mcpJobs.filter(isActiveJob), [mcpJobs])
  // Only show placeholders on page 1 (newest), where freshly-started jobs belong.
  const placeholders = mcpView && page === 1 ? activeJobs : NO_JOBS

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total])
  const startIndex = total === 0 ? 0 : offset + 1
  const endIndex = total === 0 ? 0 : offset + runs.length
  const canGoPrev = page > 1
  const canGoNext = page < totalPages
  const hasFilters = activeFilters(filters).length > 0 || debouncedQuery !== ''

  // The run open in the viewer, as an index into this page's runs.
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const shownIndex = viewerIndex !== null && viewerIndex < runs.length ? viewerIndex : null

  const tiles: MasonryItem[] = useMemo(() => [
    ...placeholders.map((job): MasonryItem => ({
      key: `job-${job.job_id}`,
      aspect: jobAspect(job),
      render: () => <McpJobTile job={job} />,
    })),
    ...runs.map((run, i): MasonryItem => ({
      key: `run-${run.id}`,
      aspect: runAspect(run),
      render: ({ reportAspect }) => (
        <ArtifactTile run={run} onAspect={reportAspect} onFavoriteToggled={() => mutate()} onOpen={() => setViewerIndex(i)} />
      ),
    })),
  ], [placeholders, runs, mutate])

  useEffect(() => {
    if (!isLoading && page > 1 && runs.length === 0) {
      updateParams({ page: String(Math.max(1, page - 1)) })
    }
  }, [isLoading, page, runs.length]) // eslint-disable-line react-hooks/exhaustive-deps

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

      {isLoading ? (
        <MasonryGrid items={SKELETON_ITEMS} label="Loading artifacts" />
      ) : error ? (
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
      ) : runs.length === 0 && placeholders.length === 0 ? (
        <EmptyState
          title={hasFilters ? 'No runs match these filters.' : mcpView ? 'No MCP generations yet.' : 'No pipeline runs yet.'}
          description={hasFilters ? undefined : mcpView ? 'Ask Claude to generate via the BlockFlow MCP — results appear here live.' : 'Run a pipeline from the Generate page to see results here.'}
          action={hasFilters ? (
            <button type="button" className="text-sm underline hover:text-foreground text-muted-foreground/70" onClick={clearAll}>
              Clear filters
            </button>
          ) : undefined}
        />
      ) : (
        <>
          <MasonryGrid items={tiles} label="Artifacts" />
          <ArtifactViewer runs={runs} index={shownIndex} onIndexChange={setViewerIndex} onFavoriteToggled={() => mutate()} />
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
