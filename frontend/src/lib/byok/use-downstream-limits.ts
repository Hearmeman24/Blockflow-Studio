'use client'

/**
 * For a block and a media kind: the downstream generation blocks that will
 * read this block's output, each with the ledger limit its selected provider
 * and model put on that kind. Follows the pipeline's own source resolution
 * (closest / all / custom, branches, disabled blocks) and re-renders when a
 * consumer's provider, model or settings change, because those are read from
 * the consumer's `useSessionState` keys.
 */
import { useMemo } from 'react'
import { useOptionalPipeline } from '@/lib/pipeline/pipeline-context'
import { useSessionValues } from '@/lib/use-session-state'
import { computeDownstreamLimit, strictestLimit, type DownstreamLimit, type StoredSelection } from './downstream-limits'
import { generationBlockConfig } from './generation-blocks'
import type { MediaKind } from './types'
import { useProviderCatalog } from './use-provider-catalog'

export interface DownstreamLimitsState {
  /** One entry per consumer, in pipeline order. */
  consumers: DownstreamLimit[]
  /** The consumer allowing the fewest items, or null when there is no consumer. */
  strictest: DownstreamLimit | null
  /** True while the catalog loads and a consumer exists. */
  loading: boolean
}

const FIELDS = ['provider', 'model', 'params'] as const

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

export function useDownstreamLimits(blockId: string, kind: MediaKind): DownstreamLimitsState {
  const pipeline = useOptionalPipeline()
  const getConsumers = pipeline?.getDownstreamConsumers
  const { catalog } = useProviderCatalog()

  const consumers = useMemo(
    () => (getConsumers ? getConsumers(blockId, kind) : [])
      .filter((c) => generationBlockConfig(c.type)?.referenceKinds.includes(kind)),
    [getConsumers, blockId, kind],
  )
  const keys = useMemo(
    () => consumers.flatMap((c) => FIELDS.map((f) => `block_${c.blockId}_${f}`)),
    [consumers],
  )
  const values = useSessionValues(keys)

  return useMemo(() => {
    if (!catalog || consumers.length === 0) {
      return { consumers: [], strictest: null, loading: consumers.length > 0 && !catalog }
    }
    const limits: DownstreamLimit[] = []
    consumers.forEach((consumer, i) => {
      const stored: StoredSelection = {
        provider: asString(values[i * 3]),
        model: asString(values[i * 3 + 1]),
        params: (values[i * 3 + 2] as StoredSelection['params']) ?? null,
      }
      const limit = computeDownstreamLimit(catalog, consumer, kind, stored)
      if (limit) limits.push(limit)
    })
    return { consumers: limits, strictest: strictestLimit(limits), loading: false }
  }, [catalog, consumers, values, kind])
}
