'use client'

import { useCallback, useEffect, useRef } from 'react'
import useSWR from 'swr'
import { TERMINAL_STATUSES, type JobStatus } from '@/lib/types'
import { parseJobEvent } from '@/lib/hooks'
import { BALANCES_URL, type ProviderBalance } from './cost'
import { useProviderCatalog } from './use-provider-catalog'

export const BALANCE_DEBOUNCE_MS = 1500
/** A second cache-bypassing refresh after a finished job, for providers that settle the charge late. */
export const BALANCE_SETTLE_MS = 10_000

export async function fetchBalances(refresh = false): Promise<ProviderBalance[]> {
  const res = await fetch(refresh ? `${BALANCES_URL}?refresh=1` : BALANCES_URL, { method: 'GET' })
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  if (!res.ok) throw new Error(`Could not load balances (HTTP ${res.status}).`)
  const list = (body as { balances?: unknown } | undefined)?.balances
  if (!Array.isArray(list) || !list.every((b) => b && typeof b === 'object' && typeof b.provider === 'string')) {
    throw new Error('The balances response was malformed.')
  }
  return list as ProviderBalance[]
}

export interface ProviderBalancesState {
  balances: ProviderBalance[] | undefined
  error: Error | undefined
  /** True only before the first answer. */
  isLoading: boolean
  /** True while any request is in flight (first load, refresh, revalidation). */
  isRefreshing: boolean
  /** Fetch now, bypassing the server's short cache. */
  refresh: () => Promise<void>
}

/**
 * Remaining credits per provider, under SWR key `BALANCES_URL`.
 *
 * Refreshes on mount and window focus (SWR, served from the server's ~30 s
 * cache), when the provider catalog is revalidated (Settings calls
 * `mutate('/api/providers/catalog')` after a key is saved or removed; the
 * server cache is keyed per key, so a new key is never served stale), and,
 * debounced and bypassing the cache, on `/api/jobs/events`: when a job is
 * first submitted (`QUEUED`; providers may reserve credits), and when a job
 * reaches a terminal state, once after the debounce and once more about
 * `settleMs` later for providers that settle the balance late. A batch of
 * events collapses into one request of each kind.
 */
export function useProviderBalances(options: { debounceMs?: number; settleMs?: number } = {}): ProviderBalancesState {
  const debounceMs = options.debounceMs ?? BALANCE_DEBOUNCE_MS
  const settleMs = options.settleMs ?? BALANCE_SETTLE_MS
  const { data, error, isLoading, isValidating, mutate } = useSWR<ProviderBalance[], Error>(
    BALANCES_URL,
    () => fetchBalances(false),
    { revalidateOnFocus: true, shouldRetryOnError: false },
  )

  const refresh = useCallback(async () => {
    try {
      await mutate(fetchBalances(true), { revalidate: false })
    } catch {
      // SWR keeps the error in `error`.
    }
  }, [mutate])

  // Debounced scheduler: many events collapse into one request.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingBypass = useRef(false)
  const schedule = useCallback((bypass: boolean) => {
    pendingBypass.current ||= bypass
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      const force = pendingBypass.current
      pendingBypass.current = false
      if (force) void refresh()
      else void mutate()
    }, debounceMs)
  }, [debounceMs, mutate, refresh])
  // One trailing "settle" refresh after the last finished job of a batch.
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleSettle = useCallback(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null
      void refresh()
    }, settleMs)
  }, [settleMs, refresh])
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
    if (settleTimer.current) clearTimeout(settleTimer.current)
  }, [])

  // Catalog revalidation (key saved / removed).
  const { catalog } = useProviderCatalog()
  const seenCatalog = useRef<unknown>(undefined)
  useEffect(() => {
    if (!catalog) return
    if (seenCatalog.current !== undefined && seenCatalog.current !== catalog) schedule(false)
    seenCatalog.current = catalog
  }, [catalog, schedule])

  // Job events: submitted and terminal.
  const scheduleRef = useRef(schedule)
  const settleRef = useRef(scheduleSettle)
  useEffect(() => {
    scheduleRef.current = schedule
    settleRef.current = scheduleSettle
  }, [schedule, scheduleSettle])
  const submitted = useRef(new Set<string>())
  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return
    const es = new EventSource('/api/jobs/events')
    es.onmessage = (event) => {
      const job = parseJobEvent(event.data)
      if (!job) return
      if (TERMINAL_STATUSES.includes(job.status as JobStatus)) {
        scheduleRef.current(true)
        settleRef.current()
      } else if (job.status === 'QUEUED' && !submitted.current.has(job.job_id)) {
        submitted.current.add(job.job_id)
        scheduleRef.current(true)
      }
    }
    return () => es.close()
  }, [])

  return {
    balances: data,
    error,
    isLoading: isLoading && !data,
    isRefreshing: isValidating,
    refresh,
  }
}
