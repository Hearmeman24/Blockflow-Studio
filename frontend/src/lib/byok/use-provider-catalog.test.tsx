import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { SWRConfig, useSWRConfig } from 'swr'
import type { ReactNode } from 'react'
import { CATALOG_BOTH, CATALOG_KIE } from './__fixtures__'
import { useProviderCatalog } from './use-provider-catalog'

function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => vi.unstubAllGlobals())

describe('useProviderCatalog', () => {
  it('loads the catalog from /api/providers/catalog', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(CATALOG_KIE))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useProviderCatalog(), { wrapper })
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.catalog).toBeDefined())
    expect(result.current.catalog?.providers.piapi.configured).toBe(false)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/providers/catalog')
  })

  it('updates when Settings revalidates the catalog key', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(CATALOG_KIE)).mockResolvedValue(json(CATALOG_BOTH))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => ({ state: useProviderCatalog(), config: useSWRConfig() }), { wrapper })
    await waitFor(() => expect(result.current.state.catalog?.providers.piapi.configured).toBe(false))
    await act(async () => {
      await result.current.config.mutate('/api/providers/catalog')
    })
    await waitFor(() => expect(result.current.state.catalog?.providers.piapi.configured).toBe(true))
  })

  it('exposes an error and a retry', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({}, 500)).mockResolvedValue(json(CATALOG_BOTH))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useProviderCatalog(), { wrapper })
    await waitFor(() => expect(result.current.error?.message).toMatch(/HTTP 500/))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.catalog).toBeDefined())
  })
})
