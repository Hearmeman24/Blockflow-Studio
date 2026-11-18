'use client'

/**
 * Checks a block's saved references through `/api/generation/check-references`:
 * once per block, debounced, batched, and only for references not checked yet.
 * Nothing is fetched while there are no references. A failed check adds no
 * results and reports `failed`, so the block shows "could not verify" instead
 * of marking anything broken.
 *
 * One reducer holds the results and the phase of the latest check:
 *
 *   idle --started--> checking --answered--> checked
 *                              --failed----> failed
 *   any  --settled--> checked   (every current reference has a result)
 *   any  --reset----> results forgotten (Re-check), phase kept until the next check starts
 *
 * Results of earlier checks are kept through a failed one: `failed` means some
 * current references have no result. When the set shrinks to references that
 * all have one, the check settles to `checked`.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { checkReferenceHealth, hasSource, healthSignature, type HealthTarget, type ReferenceHealth } from './reference-health'

export type HealthCheckStatus = 'idle' | 'checking' | 'checked' | 'failed'

export interface HealthCheckState {
  phase: HealthCheckStatus
  /** Results by `healthSignature`. */
  results: ReadonlyMap<string, ReferenceHealth>
}

export type HealthCheckAction =
  | { type: 'started' }
  | { type: 'answered'; results: ReadonlyArray<readonly [string, ReferenceHealth]> }
  | { type: 'failed' }
  | { type: 'settled' }
  | { type: 'reset' }

export const INITIAL_HEALTH_CHECK: HealthCheckState = { phase: 'idle', results: new Map() }

export function healthCheckReducer(state: HealthCheckState, action: HealthCheckAction): HealthCheckState {
  switch (action.type) {
    case 'started':
      return { ...state, phase: 'checking' }
    case 'answered': {
      const results = new Map(state.results)
      for (const [sig, result] of action.results) results.set(sig, result)
      return { phase: 'checked', results }
    }
    case 'failed':
      return { ...state, phase: 'failed' }
    case 'settled':
      return state.phase === 'checked' ? state : { ...state, phase: 'checked' }
    case 'reset':
      return { ...state, results: new Map() }
  }
}

export interface ReferenceHealthState {
  status: HealthCheckStatus
  /** The result for a reference, or undefined while unchecked or after a failed check. */
  get: (target: { local?: string; url?: string }) => ReferenceHealth | undefined
  /** Forget all results and check every reference again. */
  recheck: () => void
}

export const HEALTH_DEBOUNCE_MS = 300

export function useReferenceHealth(targets: readonly HealthTarget[], debounceMs = HEALTH_DEBOUNCE_MS): ReferenceHealthState {
  const [state, dispatch] = useReducer(healthCheckReducer, INITIAL_HEALTH_CHECK)
  const [generation, setGeneration] = useState(0)
  // The effect reads the latest results without re-running when they change.
  const resultsRef = useRef(state.results)
  useEffect(() => {
    resultsRef.current = state.results
  }, [state.results])

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
      dispatch({ type: 'settled' })
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      dispatch({ type: 'started' })
      checkReferenceHealth(pending.map(([, t]) => t), controller.signal)
        .then((found) => {
          if (!controller.signal.aborted) dispatch({ type: 'answered', results: pending.map(([sig], i) => [sig, found[i]] as const) })
        })
        .catch(() => {
          if (!controller.signal.aborted) dispatch({ type: 'failed' })
        })
    }, debounceMs)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // `signature` captures the set of references; `generation` forces a re-check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, generation, debounceMs])

  const { results } = state
  const get = useCallback((target: { local?: string; url?: string }) => results.get(healthSignature(target)), [results])
  const recheck = useCallback(() => {
    resultsRef.current = new Map()
    dispatch({ type: 'reset' })
    setGeneration((g) => g + 1)
  }, [])

  return { status: checkable.size === 0 ? 'idle' : state.phase, get, recheck }
}
