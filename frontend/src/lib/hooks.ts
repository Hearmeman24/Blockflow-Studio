'use client'

import { useEffect, useRef } from 'react'
import useSWR from 'swr'
import { ARTIFACTS_PAGE_SIZE, fetchMcpJobs, fetchRuns } from './api'
import { fromSWR, type Resource } from './resource'
import type { JobSnapshot, RunEntry } from './types'

export function useRuns(
  limit = ARTIFACTS_PAGE_SIZE,
  offset = 0,
  favorited = false,
  /** One kind or a comma list (`image,video`); null for all. */
  mediaKind: string | null = null,
  promptQuery: string = '',
  hidePartial = true,
  /** One source or a comma list (`pipeline,mcp`); null for all. */
  source: string | null = null,
  // While watching MCP generations land, poll so the growing batch card fills in.
  refreshInterval = 0,
  /** One character id or a comma list; null for all. */
  character: string | null = null,
) {
  const { data, error, isLoading, mutate } = useSWR(
    ['runs', limit, offset, favorited, mediaKind, promptQuery, hidePartial, source, character],
    () => fetchRuns(limit, offset, favorited, mediaKind, promptQuery, hidePartial, source, character),
    { revalidateOnFocus: true, keepPreviousData: true, refreshInterval }
  )
  // A new page or filter shows loading, not the previous one's runs that
  // keepPreviousData holds; for the same reason an error wins over data.
  const failure = error ?? (data && !data.ok ? new Error(typeof data.error === 'string' ? data.error : 'Could not load the runs.') : undefined)
  const resource: Resource<RunsPage> = isLoading ? { kind: 'loading' } : fromSWR<RunsPage>({ data: failure ? undefined : data, error: failure })

  return {
    runs: (resource.kind === 'ready' ? resource.data.runs ?? [] : []) as RunEntry[],
    total: resource.kind === 'ready' && typeof resource.data.total === 'number' ? resource.data.total : 0,
    limit: typeof data?.limit === 'number' ? data.limit : limit,
    offset: typeof data?.offset === 'number' ? data.offset : offset,
    isLoading: resource.kind === 'loading',
    error: failure ?? null,
    resource,
    mutate,
  }
}

interface RunsPage { ok: boolean; runs?: RunEntry[]; total?: number; limit?: number; offset?: number; error?: unknown }
interface McpJobsPage { ok: boolean; jobs: JobSnapshot[] }

/** Live MCP jobs (active + recent) for the Artifacts MCP view. SSE drives updates;
 * the poll is a slow fallback in case the dev proxy buffers the stream. */
export function useMcpJobs(enabled: boolean, refreshInterval = 10000) {
  const { data, error, mutate } = useSWR<McpJobsPage>(
    enabled ? ['mcp-jobs'] : null,
    () => fetchMcpJobs(50),
    { refreshInterval: enabled ? refreshInterval : 0, revalidateOnFocus: true }
  )
  const resource = fromSWR<McpJobsPage>({ data, error })
  return { jobs: (data?.jobs ?? []) as JobSnapshot[], resource, mutate }
}

/** Parse one `/api/jobs/events` message payload; returns the job snapshot or null. */
export function parseJobEvent(data: unknown): JobSnapshot | null {
  if (typeof data !== 'string') return null
  try {
    const parsed = JSON.parse(data) as { type?: unknown; job?: unknown }
    if (parsed?.type !== 'job' || !parsed.job || typeof parsed.job !== 'object') return null
    return parsed.job as JobSnapshot
  } catch {
    return null
  }
}

/** Subscribe to the job-store SSE stream and call `onEvent` for every change to
 * an MCP-sourced job, so callers can revalidate. The stream carries all sources;
 * pipeline jobs are ignored here. EventSource auto-reconnects on drop. */
export function useMcpStream(enabled: boolean, onEvent: (job: JobSnapshot) => void) {
  const cb = useRef(onEvent)
  useEffect(() => { cb.current = onEvent })
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    const es = new EventSource('/api/jobs/events')
    es.onmessage = (event) => {
      const job = parseJobEvent(event.data)
      if (job?.source === 'mcp') cb.current(job)
    }
    return () => es.close()
  }, [enabled])
}
