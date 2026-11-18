import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { SWRConfig, useSWRConfig } from 'swr'
import type { ReactNode } from 'react'
import { CATALOG_BOTH, CATALOG_KIE } from './__fixtures__'
import { catalogLoad, useProviderCatalog } from './use-provider-catalog'

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

  it('load is one tagged state: loading, then ready', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(CATALOG_KIE)))
    const { result } = renderHook(() => useProviderCatalog(), { wrapper })
    expect(result.current.load).toEqual({ status: 'loading' })
    await waitFor(() => expect(result.current.load).toEqual({ status: 'ready', catalog: CATALOG_KIE, stale: false }))
  })

  it('load is an error without a catalog, and ready (stale) when a revalidation fails after one loaded', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({}, 500)).mockResolvedValueOnce(json(CATALOG_KIE)).mockResolvedValue(json({}, 500))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => ({ state: useProviderCatalog(), config: useSWRConfig() }), { wrapper })
    await waitFor(() => expect(result.current.state.load).toMatchObject({ status: 'error', error: expect.any(Error) }))
    act(() => result.current.state.retry())
    await waitFor(() => expect(result.current.state.load).toEqual({ status: 'ready', catalog: CATALOG_KIE, stale: false }))
    await act(async () => {
      await result.current.config.mutate('/api/providers/catalog').catch(() => undefined)
    })
    await waitFor(() => expect(result.current.state.load).toEqual({ status: 'ready', catalog: CATALOG_KIE, stale: true }))
  })

  it('catalogLoad: data wins, then loading, then the error', () => {
    const error = new Error('x')
    expect(catalogLoad({ data: CATALOG_KIE, error: undefined, isLoading: false })).toEqual({ status: 'ready', catalog: CATALOG_KIE, stale: false })
    expect(catalogLoad({ data: CATALOG_KIE, error, isLoading: false })).toEqual({ status: 'ready', catalog: CATALOG_KIE, stale: true })
    // A retry in flight after an error shows the loading state again.
    expect(catalogLoad({ data: undefined, error, isLoading: true })).toEqual({ status: 'loading' })
    expect(catalogLoad({ data: undefined, error, isLoading: false })).toEqual({ status: 'error', error })
    expect(catalogLoad({ data: undefined, error: undefined, isLoading: false })).toEqual({ status: 'loading' })
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
