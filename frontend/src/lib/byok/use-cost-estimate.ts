'use client'

import { useEffect, useMemo, useState } from 'react'
import { ESTIMATE_URL, readEstimate, readUnavailable, type CostEstimate, type EstimateUnavailable } from './cost'
import type { GenerationRequest } from './types'

export const ESTIMATE_DEBOUNCE_MS = 400

/** The server's answer for one request. `reason` is null when it gave none. */
export type EstimateAnswer =
  | { status: 'ready'; estimate: CostEstimate }
  | { status: 'unavailable'; reason: EstimateUnavailable | null }
  | { status: 'error'; error: Error }

/**
 * The estimate for the current request:
 *
 *   disabled   no request (block invalid, provider not configured): no call
 *   loading    the answer for this request has not arrived; `previous` is the
 *              last answer for the same provider, model and mode, shown
 *              meanwhile so the chip does not flicker (null otherwise)
 *   ready / unavailable / error   the answer for this request
 */
export type CostEstimateResult =
  | { status: 'disabled' }
  | { status: 'loading'; previous: Exclude<EstimateAnswer, { status: 'error' }> | null }
  | EstimateAnswer

export interface CostEstimateState {
  result: CostEstimateResult
  /** The estimate to show, or null (none, disabled or unpriceable). */
  estimate: CostEstimate | null
  /** Why there is no estimate, when the server said so (null otherwise). */
  unavailable: EstimateUnavailable | null
  isLoading: boolean
  error: Error | undefined
}

interface Settled {
  key: string
  scope: string
  answer: EstimateAnswer
}

/** The block configuration an answer belongs to: an old price is never shown for another model. */
function scopeOf(request: GenerationRequest): string {
  return JSON.stringify([request.provider, request.model, request.mode])
}

/** What the chip shows for a result: the estimate, or the reason there is none. */
export function shownEstimate(result: CostEstimateResult): { estimate: CostEstimate | null; unavailable: EstimateUnavailable | null } {
  switch (result.status) {
    case 'ready':
      return { estimate: result.estimate, unavailable: null }
    case 'unavailable':
      return { estimate: null, unavailable: result.reason }
    case 'loading':
      return result.previous ? shownEstimate(result.previous) : { estimate: null, unavailable: null }
    case 'error':
    case 'disabled':
      return { estimate: null, unavailable: null }
  }
}

/**
 * Debounced pre-run estimate for one generation request
 * (`POST /api/generation/estimate`, same body as validate; never calls a
 * provider). Pass `enabled: false` while the block is invalid or its
 * provider is not configured: no call is made and the result is `disabled`.
 * Equal requests (by JSON) do not refetch; a changed request aborts the
 * previous call. Leave the prompt out of `request`: it never changes the price.
 */
export function useCostEstimate(
  request: GenerationRequest | null | undefined,
  options: { enabled?: boolean; debounceMs?: number } = {},
): CostEstimateState {
  const enabled = options.enabled ?? true
  const debounceMs = options.debounceMs ?? ESTIMATE_DEBOUNCE_MS
  const key = useMemo(() => (enabled && request ? JSON.stringify(request) : ''), [enabled, request])
  const scope = enabled && request ? scopeOf(request) : ''
  const [settled, setSettled] = useState<Settled | null>(null)

  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    const requestScope = scope
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
          setSettled({
            key,
            scope: requestScope,
            answer: estimate ? { status: 'ready', estimate } : { status: 'unavailable', reason: readUnavailable(body?.unavailable) },
          })
        }
      } catch (err) {
        if (controller.signal.aborted) return
        setSettled({ key, scope: requestScope, answer: { status: 'error', error: err instanceof Error ? err : new Error(String(err)) } })
      }
    }, debounceMs)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [key, scope, debounceMs])

  const result = estimateResult(key, scope, settled)
  return {
    result,
    ...shownEstimate(result),
    isLoading: result.status === 'loading',
    error: result.status === 'error' ? result.error : undefined,
  }
}

function estimateResult(key: string, scope: string, settled: Settled | null): CostEstimateResult {
  if (!key) return { status: 'disabled' }
  if (settled?.key === key) return settled.answer
  const previous = settled && settled.scope === scope && settled.answer.status !== 'error' ? settled.answer : null
  return { status: 'loading', previous }
}
