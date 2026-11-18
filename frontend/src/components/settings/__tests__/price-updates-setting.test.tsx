import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/settings/client', () => ({
  getAppPref: vi.fn(),
  setAppPref: vi.fn(),
}))

import * as client from '@/lib/settings/client'
import { PriceUpdatesSetting } from '../price-updates-setting'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function status(over: { configured?: boolean; enabled?: boolean; active?: string } = {}) {
  return {
    ok: true,
    active: over.active ?? 'bundled',
    ledger: { schema_version: 1, generated_at: '2026-11-15T13:34:29Z', entries: 100 },
    bundled: { schema_version: 1, generated_at: '2026-11-15T13:34:29Z', entries: 100 },
    remote: { configured: over.configured ?? true, enabled: over.enabled ?? true, url: 'https://example.test/p.json',
      repo: '', refresh_interval_hours: 12 },
    last_refresh: null,
  }
}

beforeEach(() => {
  vi.mocked(client.setAppPref).mockReset().mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllGlobals())

describe('PriceUpdatesSetting', () => {
  test('explains what is downloaded and that nothing is sent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(status())))
    render(<PriceUpdatesSetting />)
    const toggle = await screen.findByRole('switch', { name: 'Keep cost estimates current' })
    expect(toggle).toBeChecked()
    expect(toggle).toBeEnabled()
    expect(screen.getByText(/downloads a public price list/i)).toHaveTextContent(/sends nothing about you/i)
    expect(screen.getByText(/bundled with this version.*2026-11-15/i)).toBeInTheDocument()
  })

  test('turning it off saves the pref and re-reads the status', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(status()))
      .mockResolvedValueOnce(json(status({ enabled: false })))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<PriceUpdatesSetting />)
    await user.click(await screen.findByRole('switch', { name: 'Keep cost estimates current' }))
    expect(client.setAppPref).toHaveBeenCalledWith('price_ledger_updates', 'false')
    await waitFor(() => expect(screen.getByRole('switch')).not.toBeChecked())
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe('/api/pricing/status')
  })

  test('turning it back on saves "true"', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json(status({ enabled: false })))
      .mockResolvedValueOnce(json(status({ enabled: true, active: 'ledger' }))))
    const user = userEvent.setup()
    render(<PriceUpdatesSetting />)
    await user.click(await screen.findByRole('switch', { name: 'Keep cost estimates current' }))
    expect(client.setAppPref).toHaveBeenCalledWith('price_ledger_updates', 'true')
    await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
    expect(screen.getByText(/downloaded price list/i)).toBeInTheDocument()
  })

  test('is inactive, with an explanation, while no URL is configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(status({ configured: false }))))
    render(<PriceUpdatesSetting />)
    const toggle = await screen.findByRole('switch', { name: 'Keep cost estimates current' })
    expect(toggle).toBeDisabled()
    expect(screen.getByText(/inactive/i)).toHaveTextContent(/no price list address is configured/i)
  })

  test('names where the list comes from', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(status())))
    render(<PriceUpdatesSetting />)
    await screen.findByRole('switch', { name: 'Keep cost estimates current' })
    expect(screen.getByText(/downloads a public price list/i)).toHaveTextContent('Hearmeman24/blockflow-prices')
  })

  test('says quietly when the online list is not available yet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      ...status(),
      last_refresh: { ok: false, status: 'not_available', message: 'x', at: 1 },
    })))
    render(<PriceUpdatesSetting />)
    expect(await screen.findByText(/online price list is not available yet/i)).toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeChecked()
  })

  test('shows a loading skeleton, then an error with a retry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json(status()))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    const { container } = render(<PriceUpdatesSetting />)
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull()
    expect(await screen.findByText(/could not read the price list status/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('switch', { name: 'Keep cost estimates current' })).toBeChecked()
  })

  test('a failed save keeps the previous state and says so', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(status())))
    vi.mocked(client.setAppPref).mockRejectedValueOnce(new Error('HTTP 500'))
    const user = userEvent.setup()
    render(<PriceUpdatesSetting />)
    await user.click(await screen.findByRole('switch', { name: 'Keep cost estimates current' }))
    expect(await screen.findByText(/could not save/i)).toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeChecked()
  })
})
