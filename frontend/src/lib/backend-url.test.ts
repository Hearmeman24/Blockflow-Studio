import { afterEach, describe, expect, test, vi } from 'vitest'

async function importBackendUrl() {
  vi.resetModules()
  return import('./backend-url')
}

describe('directBackendUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  test('returns the path unchanged when window is undefined (SSR)', async () => {
    vi.stubGlobal('window', undefined)
    const { directBackendUrl } = await importBackendUrl()
    expect(directBackendUrl('/api/blocks/video_fx/run')).toBe('/api/blocks/video_fx/run')
  })

  test('builds an absolute URL from window.location using the configured backend port', async () => {
    vi.stubEnv('NEXT_PUBLIC_BACKEND_PORT', '47301')
    vi.stubGlobal('window', { location: { protocol: 'http:', hostname: '127.0.0.1' } })
    const { directBackendUrl } = await importBackendUrl()
    expect(directBackendUrl('/api/blocks/video_fx/run')).toBe(
      'http://127.0.0.1:47301/api/blocks/video_fx/run',
    )
  })

  test('falls back to the default backend port when NEXT_PUBLIC_BACKEND_PORT is unset', async () => {
    vi.stubGlobal('window', { location: { protocol: 'http:', hostname: '127.0.0.1' } })
    const { directBackendUrl } = await importBackendUrl()
    expect(directBackendUrl('/x')).toBe('http://127.0.0.1:47301/x')
  })
})
