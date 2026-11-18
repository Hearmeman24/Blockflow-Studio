'use client'

import useSWR from 'swr'
import { CATALOG_URL, fetchProviderCatalog } from './api'
import type { ProviderCatalog } from './types'

/**
 * The catalog's load state. `stale`: the catalog was loaded, but the last
 * revalidation failed; the loaded one is still used.
 */
export type CatalogLoad =
  | { status: 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'ready'; catalog: ProviderCatalog; stale: boolean }

export interface ProviderCatalogState {
  /** The catalog's load state; read this rather than the fields below. */
  load: CatalogLoad
  catalog: ProviderCatalog | undefined
  error: Error | undefined
  isLoading: boolean
  retry: () => void
}

/** SWR's fields as one state: data wins, then a request in flight, then the error. */
export function catalogLoad({ data, error, isLoading }: {
  data: ProviderCatalog | undefined
  error: Error | undefined
  isLoading: boolean
}): CatalogLoad {
  if (data) return { status: 'ready', catalog: data, stale: Boolean(error) }
  if (isLoading || !error) return { status: 'loading' }
  return { status: 'error', error }
}

/**
 * The provider catalog, cached by SWR under `CATALOG_URL`. Settings calls
 * `mutate('/api/providers/catalog')` after a key is saved or removed, so every
 * block re-renders with the new availability without a reload.
 */
export function useProviderCatalog(): ProviderCatalogState {
  const { data, error, isLoading, mutate } = useSWR<ProviderCatalog, Error>(CATALOG_URL, fetchProviderCatalog, {
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  })
  return {
    load: catalogLoad({ data, error, isLoading }),
    catalog: data,
    error,
    isLoading: isLoading && !data,
    retry: () => {
      void mutate()
    },
  }
}
