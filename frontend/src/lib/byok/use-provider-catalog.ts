'use client'

import useSWR from 'swr'
import { CATALOG_URL, fetchProviderCatalog } from './api'
import type { ProviderCatalog } from './types'

export interface ProviderCatalogState {
  catalog: ProviderCatalog | undefined
  error: Error | undefined
  isLoading: boolean
  retry: () => void
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
    catalog: data,
    error,
    isLoading: isLoading && !data,
    retry: () => {
      void mutate()
    },
  }
}
