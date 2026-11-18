'use client'

/**
 * Checks a block's saved references through `/api/generation/check-references`:
 * once per block, debounced, batched, and only for references not checked yet.
 * Nothing is fetched while there are no references. A failed check leaves the
 * results empty and reports `failed`, so the block shows "could not verify"
 * instead of marking anything broken.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { checkReferenceHealth, hasSource, healthSignature, type HealthTarget, type ReferenceHealth } from './reference-health'

export type HealthCheckStatus = 'idle' | 'checking' | 'checked' | 'failed'

export interface ReferenceHealthState {
  status: HealthCheckStatus
  /** The result for a reference, or undefined while unchecked or after a failed check. */
  get: (target: { local?: string; url?: string }) => ReferenceHealth | undefined
  /** Forget all results and check every reference again. */
  recheck: () => void
}

export const HEALTH_DEBOUNCE_MS = 300

export function useReferenceHealth(targets: readonly HealthTarget[], debounceMs = HEALTH_DEBOUNCE_MS): ReferenceHealthState {
  const [results, setResults] = useState<ReadonlyMap<string, ReferenceHealth>>(() => new Map())
  const [status, setStatus] = useState<HealthCheckStatus>('idle')
  const [generation, setGeneration] = useState(0)
  const resultsRef = useRef(results)
  useEffect(() => {
    resultsRef.current = results
  }, [results])

  const checkable = useMemo(() => {
    const unique = new Map<string, HealthTarget>()
    for (const t of targets) if (hasSource(t)) unique.set(healthSignature(t), t)
    return unique
  }, [targets])
  const signature = [...checkable.keys()].sort().join('\u0001')

  useEffect(() => {
    if (checkable.size === 0) return
    const pending = [...checkable.entries()].filter(([sig]) => !resultsRef.current.has(sig))
    if (pending.length === 0) {
      setStatus((s) => (s === 'checking' ? 'checked' : s))
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setStatus('checking')
      checkReferenceHealth(pending.map(([, t]) => t), controller.signal)
        .then((found) => {
          if (controller.signal.aborted) return
          setResults((prev) => {
            const next = new Map(prev)
            pending.forEach(([sig], i) => next.set(sig, found[i]))
            return next
          })
          setStatus('checked')
        })
        .catch(() => {
          if (!controller.signal.aborted) setStatus('failed')
        })
    }, debounceMs)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // `signature` captures the set of references; `generation` forces a re-check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, generation, debounceMs])

  const get = useCallback((target: { local?: string; url?: string }) => results.get(healthSignature(target)), [results])
  const recheck = useCallback(() => {
    resultsRef.current = new Map()
    setResults(new Map())
    setGeneration((g) => g + 1)
  }, [])

  return { status: checkable.size === 0 ? 'idle' : status, get, recheck }
}
