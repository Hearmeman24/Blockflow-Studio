'use client'

import { useEffect, useMemo, useState } from 'react'
import { ESTIMATE_URL, readEstimate, readUnavailable, type CostEstimate, type EstimateUnavailable } from './cost'
import type { GenerationRequest } from './types'

export const ESTIMATE_DEBOUNCE_MS = 400

export interface CostEstimateState {
  /** The estimate for the current request, or null (none, disabled or unpriceable). */
  estimate: CostEstimate | null
  /** Why there is no estimate, when the server said so (null otherwise). */
  unavailable: EstimateUnavailable | null
  isLoading: boolean
  error: Error | undefined
}

interface Settled {
  key: string
  estimate: CostEstimate | null
  unavailable: EstimateUnavailable | null
  error?: Error
}

/**
 * Debounced pre-run estimate for one generation request
 * (`POST /api/generation/estimate`, same body as validate; never calls a
 * provider). Pass `enabled: false` while the block is invalid or its
 * provider is not configured: no call is made and both `estimate` and
 * `unavailable` are null. Equal requests (by JSON) do not refetch; a changed
 * request aborts the previous call, and the previous answer (estimate or
 * reason) stays visible until the new one arrives. Leave the prompt out of
 * `request`: it never changes the price.
 */
export function useCostEstimate(
  request: GenerationRequest | null | undefined,
  options: { enabled?: boolean; debounceMs?: number } = {},
): CostEstimateState {
  const enabled = options.enabled ?? true
  const debounceMs = options.debounceMs ?? ESTIMATE_DEBOUNCE_MS
  const key = useMemo(() => (enabled && request ? JSON.stringify(request) : ''), [enabled, request])
  const [settled, setSettled] = useState<Settled | null>(null)

  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(ESTIMATE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: key,
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`Could not estimate the cost (HTTP ${res.status}).`)
        const body = (await res.json()) as { estimate?: unknown; unavailable?: unknown }
        const estimate = readEstimate(body?.estimate)
        if (!controller.signal.aborted) {
          setSettled({ key, estimate, unavailable: estimate ? null : readUnavailable(body?.unavailable) })
        }
      } catch (err) {
        if (controller.signal.aborted) return
        setSettled({ key, estimate: null, unavailable: null, error: err instanceof Error ? err : new Error(String(err)) })
      }
    }, debounceMs)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [key, debounceMs])

  if (!key) return { estimate: null, unavailable: null, isLoading: false, error: undefined }
  const current = settled?.key === key ? settled : null
  // While a changed request loads, keep showing the last answer so the chip does
  // not flicker; it changes (or disappears) only when the new answer arrives.
  if (!current) {
    return { estimate: settled?.estimate ?? null, unavailable: settled?.unavailable ?? null, isLoading: true, error: undefined }
  }
  return { estimate: current.estimate, unavailable: current.unavailable, isLoading: false, error: current.error }
}
