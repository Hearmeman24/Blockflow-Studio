'use client'

/**
 * One shape for data the UI reads asynchronously, so a component does not
 * hand-roll its own `loading` / `error` / `data` trio.
 *
 * - `useResource(fetcher, deps)` reads it: loading, then ready or error,
 *   with `retry` (back to loading), `refresh` (re-read quietly, keeping what
 *   is shown) and `setData` (a local edit). Only the newest request may set
 *   the state: an earlier request is aborted, and its late answer or error is
 *   dropped. Nothing is set after unmount.
 * - `fromSWR` maps a hook that already uses SWR onto the same shape.
 */
import { useCallback, useEffect, useState, type DependencyList } from 'react'

export type Resource<T> =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: T }

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Request generations: only the request begun last is current. */
export interface RequestGate {
  begin: () => number
  isCurrent: (token: number) => boolean
  /** Make every request begun so far stale (an edit, a removal, unmount). */
  invalidate: () => void
}

export function createRequestGate(): RequestGate {
  let current = 0
  return {
    begin: () => ++current,
    isCurrent: (token) => token === current,
    invalidate: () => {
      current += 1
    },
  }
}

/** SWR's answer as a Resource. Data already shown stays shown when a revalidation fails. */
export function fromSWR<T>({ data, error }: { data: T | undefined; error: unknown; isLoading?: boolean }): Resource<T> {
  if (data !== undefined) return { kind: 'ready', data }
  if (error !== undefined && error !== null) return { kind: 'error', message: errorMessage(error) }
  return { kind: 'loading' }
}

export interface ResourceHandle<T> {
  resource: Resource<T>
  /** Show loading and read again (the recovery action after an error). */
  retry: () => void
  /** Read again while keeping what is shown. Resolves with the answer; on
   * failure it rejects and the shown state is unchanged. */
  refresh: () => Promise<T>
  /** Edit ready data locally (no effect while loading or after an error). An
   * answer still in flight from before the edit is dropped. */
  setData: (update: (prev: T) => T) => void
}

interface Options {
  /** While false nothing is fetched and the resource stays loading. */
  enabled?: boolean
}

export function useResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
  { enabled = true }: Options = {},
): ResourceHandle<T> {
  const [resource, setResource] = useState<Resource<T>>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [gate] = useState(createRequestGate)
  const [inflight] = useState(() => new Set<AbortController>())

  const load = useCallback((read: (signal: AbortSignal) => Promise<T>, quiet: boolean): Promise<T> => {
    for (const controller of inflight) controller.abort()
    inflight.clear()
    const controller = new AbortController()
    inflight.add(controller)
    const token = gate.begin()
    return read(controller.signal).then(
      (data) => {
        inflight.delete(controller)
        if (gate.isCurrent(token)) setResource({ kind: 'ready', data })
        return data
      },
      (err: unknown) => {
        inflight.delete(controller)
        if (!quiet && gate.isCurrent(token)) setResource({ kind: 'error', message: errorMessage(err) })
        throw err
      },
    )
  }, [gate, inflight])

  useEffect(() => {
    if (!enabled) return
    load(fetcher, false).catch(() => {})
    return () => {
      gate.invalidate()
      for (const controller of inflight) controller.abort()
      inflight.clear()
    }
    // The caller's deps decide when to read again, as with useEffect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, attempt, load, ...deps])

  const retry = useCallback(() => {
    setResource({ kind: 'loading' })
    setAttempt((n) => n + 1)
  }, [])

  const refresh = () => load(fetcher, true)

  const ready = resource.kind === 'ready'
  const setData = useCallback((update: (prev: T) => T) => {
    if (!ready) return
    gate.invalidate()
    setResource((prev) => (prev.kind === 'ready' ? { kind: 'ready', data: update(prev.data) } : prev))
  }, [gate, ready])

  return { resource, retry, refresh, setData }
}
