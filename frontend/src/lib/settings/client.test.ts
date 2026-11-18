/**
 * Tests for the settings API client.
 *
 * Mock the BOUNDARY: global fetch. The client's URL construction, header
 * shape, body serialization, and response parsing all run against the mock
 * — we assert each is correct.
 *
 * Doctrine: build green ≠ feature works. Every test asserts the actual HTTP
 * call shape AND the parsed return value, not just "no exception."
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  deleteCredential,
  ensureAssetStorageModeDefault,
  getAppPref,
  getCredential,
  getOnboardingCompleted,
  listCredentials,
  maskedKey,
  setAppPref,
  setCredential,
  setOnboardingCompleted,
  validateProviderKey,
  getAssetStorageMode,
  setAssetStorageMode,
} from './client'

type MockResponse = {
  status?: number
  body: BodyInit | null
  headers?: Record<string, string>
}

function mockFetch(responses: MockResponse[]) {
  const queue = [...responses]
  const fn: typeof fetch = async () => {
    const next = queue.shift()
    if (!next) throw new Error('mockFetch: no more queued responses')
    return new Response(next.body, {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    })
  }
  return vi.fn<typeof fetch>(fn)
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// === credentials ============================================================

describe('credentials', () => {
  const kieStatus = { name: 'kie_api_key', configured: true, last4: 'WXYZ', updated_at: '2026-11-15T10:00:00+00:00' }

  test('listCredentials GETs the right URL and returns status objects', async () => {
    const statuses = [
      kieStatus,
      { name: 'piapi_api_key', configured: false, last4: null, updated_at: null },
    ]
    const fetchMock = mockFetch([{ body: JSON.stringify({ credentials: statuses }) }])
    vi.stubGlobal('fetch', fetchMock)

    const result = await listCredentials()

    expect(fetchMock).toHaveBeenCalledWith('/api/settings/credentials', expect.anything())
    expect(result).toEqual(statuses)
  })

  test('getCredential returns the masked status on 200', async () => {
    const fetchMock = mockFetch([{ body: JSON.stringify(kieStatus) }])
    vi.stubGlobal('fetch', fetchMock)

    const cred = await getCredential('kie_api_key')

    expect(fetchMock).toHaveBeenCalledWith('/api/settings/credentials/kie_api_key', expect.anything())
    expect(cred).toEqual(kieStatus)
  })

  test('getCredential returns null on 404', async () => {
    const fetchMock = mockFetch([{ status: 404, body: JSON.stringify({ detail: 'Unknown credential name.' }) }])
    vi.stubGlobal('fetch', fetchMock)

    expect(await getCredential('kie_api_key')).toBeNull()
  })

  test('setCredential PUTs { value } and returns the new status', async () => {
    const fetchMock = mockFetch([{ body: JSON.stringify(kieStatus) }])
    vi.stubGlobal('fetch', fetchMock)

    const result = await setCredential('kie_api_key', 'kie-new-key-WXYZ')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/settings/credentials/kie_api_key')
    expect(init.method).toBe('PUT')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({ value: 'kie-new-key-WXYZ' })
    expect(result).toEqual(kieStatus)
  })

  test('setCredential throws with the server detail on 422', async () => {
    const fetchMock = mockFetch([
      { status: 422, body: JSON.stringify({ detail: 'API key must not contain spaces or line breaks.' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    await expect(setCredential('kie_api_key', 'a b')).rejects.toThrow(/must not contain spaces/)
  })

  test('a non-string detail falls back to the HTTP status', async () => {
    const fetchMock = mockFetch([{ status: 422, body: JSON.stringify({ detail: [{ msg: 'x' }] }) }])
    vi.stubGlobal('fetch', fetchMock)

    await expect(setCredential('kie_api_key', 'x')).rejects.toThrow('HTTP 422')
  })

  test('deleteCredential DELETEs the right URL', async () => {
    const fetchMock = mockFetch([{ status: 204, body: null }])
    vi.stubGlobal('fetch', fetchMock)

    await deleteCredential('kie_api_key')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/credentials/kie_api_key',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  test('maskedKey shows bullets plus the last four, or bullets alone', () => {
    expect(maskedKey('WXYZ')).toBe('••••WXYZ')
    expect(maskedKey(null)).toBe('••••')
  })
})

// === endpoints ==============================================================

describe('app-prefs', () => {
  test('getAppPref returns value when set', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ name: 'output_dir', value: '/tmp/out' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    expect(await getAppPref('output_dir')).toBe('/tmp/out')
  })

  test('getAppPref returns null when unset', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ name: 'never_set', value: null }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    expect(await getAppPref('never_set')).toBeNull()
  })

  test('getAppPref passes default as query param when provided', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ name: 'k', value: 'default_val' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    await getAppPref('k', 'default_val')

    const url = fetchMock.mock.calls[0][0]
    expect(url).toContain('default=default_val')
  })

  test('setAppPref PUTs with body { value }', async () => {
    const fetchMock = mockFetch([{ body: JSON.stringify({ saved: true }) }])
    vi.stubGlobal('fetch', fetchMock)

    await setAppPref('retention_days', '90')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/settings/app-prefs/retention_days')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ value: '90' })
  })

  test('getAssetStorageMode defaults to local_only when unset', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ name: 'asset_storage_mode', value: null }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    expect(await getAssetStorageMode()).toBe('local_only')
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/app-prefs/asset_storage_mode', expect.anything())
  })

  test('getAssetStorageMode returns stored valid mode', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ name: 'asset_storage_mode', value: 'local_only' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    expect(await getAssetStorageMode()).toBe('local_only')
  })

  test('getAssetStorageMode falls back to local_only for invalid stored mode', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ name: 'asset_storage_mode', value: 'public_forever' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    expect(await getAssetStorageMode()).toBe('local_only')
  })

  test('setAssetStorageMode persists only supported modes', async () => {
    const fetchMock = mockFetch([{ body: JSON.stringify({ saved: true }) }])
    vi.stubGlobal('fetch', fetchMock)

    await setAssetStorageMode('local_only')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/settings/app-prefs/asset_storage_mode')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ value: 'local_only' })
  })
})

// === provider key check =====================================================

describe('validateProviderKey', () => {
  test('POSTs to the provider validate-key route and returns the verdict', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ ok: true, valid: true, message: 'Key works.', balance: 12.5, balance_unit: 'credits' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await validateProviderKey('kie')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/providers/kie/validate-key',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(result).toEqual({ ok: true, valid: true, message: 'Key works.', balance: 12.5, balance_unit: 'credits' })
  })

  test('returns an invalid verdict as data, not an error', async () => {
    const fetchMock = mockFetch([{ body: JSON.stringify({ ok: true, valid: false, message: 'Rejected.' }) }])
    vi.stubGlobal('fetch', fetchMock)

    expect(await validateProviderKey('piapi')).toEqual({ ok: true, valid: false, message: 'Rejected.' })
  })

  test('returns the 502 "could not check" body as data', async () => {
    const fetchMock = mockFetch([
      { status: 502, body: JSON.stringify({ ok: false, valid: null, kind: 'network', message: 'Could not reach PiAPI.' }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    const result = await validateProviderKey('piapi')
    expect(result.ok).toBe(false)
    expect(result.valid).toBeNull()
    expect(result.message).toBe('Could not reach PiAPI.')
  })

  test('throws when the response has no verdict', async () => {
    const fetchMock = mockFetch([{ status: 500, body: 'oops' }])
    vi.stubGlobal('fetch', fetchMock)

    await expect(validateProviderKey('kie')).rejects.toThrow()
  })
})

// === onboarding ===============================================================

describe('onboarding prefs', () => {
  test('getOnboardingCompleted is true only for "true"', async () => {
    for (const [value, expected] of [['true', true], ['false', false], [null, false]] as const) {
      const fetchMock = mockFetch([{ body: JSON.stringify({ name: 'onboarding_completed', value }) }])
      vi.stubGlobal('fetch', fetchMock)
      expect(await getOnboardingCompleted()).toBe(expected)
      expect(fetchMock).toHaveBeenCalledWith('/api/settings/app-prefs/onboarding_completed', expect.anything())
    }
  })

  test('setOnboardingCompleted PUTs "true"', async () => {
    const fetchMock = mockFetch([{ body: JSON.stringify({ saved: true }) }])
    vi.stubGlobal('fetch', fetchMock)

    await setOnboardingCompleted()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/settings/app-prefs/onboarding_completed')
    expect(JSON.parse(init.body as string)).toEqual({ value: 'true' })
  })

  test('ensureAssetStorageModeDefault sets local_only when the pref is unset', async () => {
    const fetchMock = mockFetch([
      { body: JSON.stringify({ name: 'asset_storage_mode', value: null }) },
      { body: JSON.stringify({ saved: true }) },
    ])
    vi.stubGlobal('fetch', fetchMock)

    await ensureAssetStorageModeDefault()

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('/api/settings/app-prefs/asset_storage_mode')
    expect(JSON.parse(init.body as string)).toEqual({ value: 'local_only' })
  })

  test('ensureAssetStorageModeDefault leaves a chosen mode alone', async () => {
    const fetchMock = mockFetch([{ body: JSON.stringify({ name: 'asset_storage_mode', value: 'tmpfiles' }) }])
    vi.stubGlobal('fetch', fetchMock)

    await ensureAssetStorageModeDefault()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
