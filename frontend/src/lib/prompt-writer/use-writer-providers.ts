'use client'

import { useCallback, useState } from 'react'
import useSWR from 'swr'
import { WRITER_PROVIDERS_URL, fetchWriterProviders } from './api'
import type { WriterProviderStatus } from './types'

export interface WriterProvidersState {
  providers: WriterProviderStatus[] | undefined
  error: Error | undefined
  isLoading: boolean
  /** True while a Re-check (a forced re-probe) is in flight. */
  rechecking: boolean
  recheck: () => Promise<void>
}

/**
 * Prompt Writer provider status, shared by every open Prompt Writer through
 * SWR. It is fetched when a block mounts and again when the window regains
 * focus; `recheck` re-probes the local servers and reloads the OpenRouter
 * model list.
 */
export function useWriterProviders(): WriterProvidersState {
  const { data, error, isLoading, mutate } = useSWR<WriterProviderStatus[], Error>(
    WRITER_PROVIDERS_URL,
    () => fetchWriterProviders(false),
    { revalidateOnFocus: true, revalidateOnMount: true, shouldRetryOnError: false },
  )
  const [rechecking, setRechecking] = useState(false)
  // A failed Re-check, remembered against the data it failed to replace, so
  // a later successful revalidation clears it without an effect.
  const [failed, setFailed] = useState<{ error: Error; data: WriterProviderStatus[] | undefined } | null>(null)
  const recheck = useCallback(async () => {
    setRechecking(true)
    try {
      const next = await fetchWriterProviders(true)
      setFailed(null)
      await mutate(next, { revalidate: false })
    } catch (err) {
      setFailed({ error: err instanceof Error ? err : new Error(String(err)), data })
    } finally {
      setRechecking(false)
    }
  }, [mutate, data])
  const recheckError = failed && failed.data === data ? failed.error : undefined
  return { providers: data, error: recheckError ?? error, isLoading: isLoading && !data, rechecking, recheck }
}
