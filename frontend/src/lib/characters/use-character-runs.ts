'use client'

/**
 * The runs made with one character (`GET /api/runs?character=`), newest
 * first, for the Characters page gallery. Pages are the Artifacts page size;
 * `loadMore` appends the next page. The run objects are the same ones the
 * Artifacts page shows, so its tiles and viewer render them as they are.
 *
 * The list stays current without a browser reload:
 * - Opening the page again, or selecting a character again, refetches the
 *   pages that are cached. SWR does not do this here: `revalidateFirstPage`
 *   is off so that "load more" does not refetch page one, and with it off SWR
 *   refetches no cached page on mount or on focus.
 * - Coming back to the window (focus, or the tab becoming visible) refetches
 *   the loaded pages, at most once per `focusThrottleMs`. This covers a job
 *   event that was missed while the stream was down.
 * - While the page is open, a job that completes (`/api/jobs/events`)
 *   refetches the loaded pages, once after `debounceMs` and once more after
 *   `settleMs`. The run is saved after its job finishes (by the pipeline once
 *   it has seen the result, by the backend for an MCP job), so the first
 *   refetch can be too early. A burst of jobs collapses into one of each.
 *   Every completed job counts, not only one that sent this character: a run
 *   is saved when its whole pipeline ends, and the last job of a pipeline may
 *   not carry the character's files.
 */
import { useCallback, useEffect, useRef } from 'react'
import useSWRInfinite from 'swr/infinite'
import { ARTIFACTS_PAGE_SIZE } from '@/lib/api'
import { parseJobEvent } from '@/lib/hooks'
import type { RunEntry } from '@/lib/types'

const PAGE_SIZE = ARTIFACTS_PAGE_SIZE
export const RUNS_DEBOUNCE_MS = 1500
/** A second refetch after a completed job, for a run that is saved late. */
export const RUNS_SETTLE_MS = 10_000
export const RUNS_FOCUS_THROTTLE_MS = 5000

interface RunsPage {
  runs: RunEntry[]
  total: number
}

export function characterRunsUrl(characterId: string, offset: number): string {
  const params = new URLSearchParams({ character: characterId, limit: String(PAGE_SIZE), offset: String(offset), hide_partial: '1' })
  return `/api/runs?${params}`
}

async function fetchPage(url: string): Promise<RunsPage> {
  const res = await fetch(url)
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`Could not load the runs (HTTP ${res.status}).`)
  }
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  if (!res.ok || obj.ok === false || !Array.isArray(obj.runs)) {
    const message = typeof obj.error === 'string' && obj.error.trim() ? obj.error : `Could not load the runs (HTTP ${res.status}).`
    throw new Error(message)
  }
  return { runs: obj.runs as RunEntry[], total: typeof obj.total === 'number' ? obj.total : obj.runs.length }
}

export interface CharacterRunsState {
  runs: RunEntry[]
  total: number
  isLoading: boolean
  isLoadingMore: boolean
  error: Error | undefined
  retry: () => void
  loadMore: () => void
  hasMore: boolean
  /** Refetch the loaded pages (after a favourite changes). */
  refresh: () => void
}

export function useCharacterRuns(
  characterId: string | null,
  options: { debounceMs?: number; settleMs?: number; focusThrottleMs?: number } = {},
): CharacterRunsState {
  const debounceMs = options.debounceMs ?? RUNS_DEBOUNCE_MS
  const settleMs = options.settleMs ?? RUNS_SETTLE_MS
  const focusThrottleMs = options.focusThrottleMs ?? RUNS_FOCUS_THROTTLE_MS
  const { data, error, size, setSize, isLoading, isValidating, mutate } = useSWRInfinite<RunsPage, Error>(
    (index, previous: RunsPage | null) => {
      if (!characterId) return null
      if (previous && previous.runs.length < PAGE_SIZE) return null
      return characterRunsUrl(characterId, index * PAGE_SIZE)
    },
    fetchPage,
    // Focus is handled below: SWR's own focus refetch would skip the cached pages.
    { revalidateOnFocus: false, revalidateFirstPage: false },
  )

  const pages = data ?? []
  const runs = pages.flatMap((p) => p.runs)
  const total = pages[0]?.total ?? 0
  const lastPage = pages.at(-1)
  const hasMore = !!characterId && !!lastPage && lastPage.runs.length === PAGE_SIZE && runs.length < total
  const isLoadingMore = !error && size > pages.length && pages.length > 0 && isValidating

  // `mutate()` without data refetches every loaded page.
  const retry = useCallback(() => {
    void mutate()
  }, [mutate])

  // Opened again with cached pages: show them, and refetch. Without a cache
  // SWR is already loading the first page.
  const cached = useRef(false)
  useEffect(() => {
    cached.current = data !== undefined
  })
  // Declared after the effect above, so it reads this render's value.
  useEffect(() => {
    if (characterId && cached.current) void mutate()
  }, [characterId, mutate])

  // A completed job: refetch soon, and once more later.
  const mutateRef = useRef(mutate)
  useEffect(() => {
    mutateRef.current = mutate
  }, [mutate])
  const listening = !!characterId
  useEffect(() => {
    if (!listening || typeof window === 'undefined' || typeof EventSource === 'undefined') return
    let soon: ReturnType<typeof setTimeout> | null = null
    let later: ReturnType<typeof setTimeout> | null = null
    const es = new EventSource('/api/jobs/events')
    es.onmessage = (event) => {
      if (parseJobEvent(event.data)?.status !== 'COMPLETED') return
      if (soon) clearTimeout(soon)
      if (later) clearTimeout(later)
      soon = setTimeout(() => void mutateRef.current(), debounceMs)
      later = setTimeout(() => void mutateRef.current(), settleMs)
    }
    return () => {
      es.close()
      if (soon) clearTimeout(soon)
      if (later) clearTimeout(later)
    }
  }, [listening, debounceMs, settleMs])

  // Back in the window: refetch.
  useEffect(() => {
    if (!listening || typeof window === 'undefined') return
    let last = -Infinity
    const onFocus = () => {
      if (document.visibilityState === 'hidden') return
      const now = Date.now()
      if (now - last < focusThrottleMs) return
      last = now
      void mutateRef.current()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [listening, focusThrottleMs])
  const loadMore = useCallback(() => {
    void setSize((s) => s + 1)
  }, [setSize])

  return {
    runs,
    total,
    isLoading: !!characterId && isLoading && !data,
    isLoadingMore,
    error: error ?? undefined,
    retry,
    loadMore,
    hasMore,
    refresh: retry,
  }
}
