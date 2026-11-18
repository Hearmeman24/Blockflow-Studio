import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig, useSWRConfig } from 'swr'
import type { ReactNode } from 'react'
import { CATALOG_BOTH, CATALOG_KIE } from '@/lib/byok/__fixtures__'
import type { ProviderBalance } from '@/lib/byok/cost'
import { CreditsPanel } from './credits-panel'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((e: MessageEvent) => void) | null = null
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }
  close() {}
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const NOW = Date.now() / 1000
const KIE_OK: ProviderBalance = {
  provider: 'kie', label: 'Kie', configured: true, status: 'ok', amount: 1234, unit: 'credits',
  usd_equivalent: 6.17, fetched_at: NOW,
}
const PI_OK: ProviderBalance = {
  provider: 'piapi', label: 'PiAPI', configured: true, status: 'ok', amount: 12.34, unit: 'usd',
  usd_equivalent: 12.34, fetched_at: NOW,
}
const PI_NONE: ProviderBalance = { provider: 'piapi', label: 'PiAPI', configured: false, status: 'not_configured', fetched_at: NOW }
const KIE_NONE: ProviderBalance = { provider: 'kie', label: 'Kie', configured: false, status: 'not_configured', fetched_at: NOW }

type Reply = ProviderBalance[] | Response | (() => Promise<Response>)

/** fetch mock: catalog from `catalogs`; balances answered from `replies` in order (last one repeats). */
function serve(replies: Reply[], catalogs: unknown[] = [CATALOG_KIE]) {
  const balanceUrls: string[] = []
  let i = 0
  let c = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/providers/catalog')) return json(catalogs[Math.min(c++, catalogs.length - 1)])
    balanceUrls.push(url)
    const reply = replies[Math.min(i++, replies.length - 1)]
    if (typeof reply === 'function') return reply()
    if (reply instanceof Response) return reply.clone()
    return json({ ok: true, balances: reply })
  }))
  return balanceUrls
}

function Wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
}

function renderPanel() {
  return render(<CreditsPanel debounceMs={10} />, { wrapper: Wrapper })
}

const trigger = () => screen.getByRole('button', { name: /credits/i })

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => vi.unstubAllGlobals())

describe('CreditsPanel', () => {
  it('shows a skeleton while loading', () => {
    serve([() => new Promise<Response>(() => {})])
    renderPanel()
    expect(screen.getByTestId('credits-panel')).toBeInTheDocument()
    expect(screen.getByLabelText('Loading credits')).toBeInTheDocument()
    expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull()
  })

  it('shows each connected balance compactly, with the panel fixed at the top right', async () => {
    serve([[KIE_OK, PI_OK]])
    renderPanel()
    await waitFor(() => expect(trigger()).toHaveTextContent('1.2K credits'))
    expect(trigger()).toHaveTextContent('$12.34')
    expect(screen.getByTestId('credits-panel').className).toMatch(/fixed/)
    expect(screen.getByTestId('credits-panel').className).toMatch(/right-/)
  })

  it('announces balances politely', async () => {
    serve([[KIE_OK, PI_NONE]])
    renderPanel()
    const live = screen.getByTestId('credits-live')
    expect(live).toHaveAttribute('aria-live', 'polite')
    await waitFor(() => expect(live).toHaveTextContent('Kie: 1,234 credits ≈ $6.17'))
  })

  it('opens a popover on hover with one row per provider', async () => {
    serve([[KIE_OK, PI_NONE]])
    renderPanel()
    await waitFor(() => expect(trigger()).toHaveTextContent('1.2K credits'))
    expect(trigger()).not.toHaveTextContent('PiAPI')
    fireEvent.pointerEnter(trigger())
    const panel = await screen.findByRole('dialog', { name: 'Provider credits' })
    const kie = within(panel).getByTestId('balance-row-kie')
    expect(kie).toHaveTextContent('Kie')
    expect(kie).toHaveTextContent('Connected')
    expect(kie).toHaveTextContent('1,234 credits ≈ $6.17')
    expect(kie).toHaveTextContent('Updated just now')
    const pi = within(panel).getByTestId('balance-row-piapi')
    expect(pi).toHaveTextContent('Not connected')
    expect(within(panel).getByRole('link', { name: /API keys/ })).toHaveAttribute('href', '/settings?tab=credentials')
  })

  it('opens on keyboard focus without stealing focus, and Enter moves focus into it; Escape closes', async () => {
    const user = userEvent.setup()
    serve([[KIE_OK, PI_OK]])
    renderPanel()
    await waitFor(() => expect(trigger()).toHaveTextContent('1.2K credits'))
    await user.tab()
    expect(trigger()).toHaveFocus()
    await screen.findByRole('dialog', { name: 'Provider credits' })
    expect(trigger()).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(trigger()).toHaveFocus()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('toggles open on click', async () => {
    const user = userEvent.setup()
    serve([[KIE_OK, PI_OK]])
    renderPanel()
    await waitFor(() => expect(trigger()).toHaveTextContent('1.2K credits'))
    await user.click(trigger())
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await user.click(trigger())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('Refresh bypasses the cache and shows the new balance', async () => {
    const user = userEvent.setup()
    const urls = serve([[KIE_OK, PI_NONE], [{ ...KIE_OK, amount: 1000, usd_equivalent: 5 }, PI_NONE]])
    renderPanel()
    await waitFor(() => expect(trigger()).toHaveTextContent('1.2K credits'))
    await user.click(trigger())
    await user.click(await screen.findByRole('button', { name: 'Refresh balances' }))
    await waitFor(() => expect(screen.getByTestId('balance-row-kie')).toHaveTextContent('1,000 credits ≈ $5.00'))
    expect(urls.at(-1)).toBe('/api/providers/balances?refresh=1')
  })

  it('refreshes after a job reaches a terminal state', async () => {
    const urls = serve([[KIE_OK, PI_NONE], [{ ...KIE_OK, amount: 999 }, PI_NONE]])
    renderPanel()
    await waitFor(() => expect(trigger()).toHaveTextContent('1.2K credits'))
    act(() => FakeEventSource.instances[0].emit({ type: 'job', job: { job_id: 'j', status: 'COMPLETED' } }))
    await waitFor(() => expect(trigger()).toHaveTextContent('999 credits'))
    expect(urls.at(-1)).toBe('/api/providers/balances?refresh=1')
  })

  it('refreshes when the catalog is revalidated after a key change', async () => {
    serve([[KIE_OK, PI_NONE], [KIE_OK, PI_OK]], [CATALOG_KIE, CATALOG_BOTH])
    // Stands in for Settings, which calls mutate('/api/providers/catalog') after a key change.
    function SaveKey() {
      const { mutate } = useSWRConfig()
      return <button type="button" onClick={() => void mutate('/api/providers/catalog')}>save key</button>
    }
    render(<><CreditsPanel debounceMs={10} /><SaveKey /></>, { wrapper: Wrapper })
    await waitFor(() => expect(trigger()).toHaveTextContent('1.2K credits'))
    expect(trigger()).not.toHaveTextContent('$12.34')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'save key' }))
    })
    await waitFor(() => expect(trigger()).toHaveTextContent('$12.34'))
  })

  it('with no provider connected, links to Settings instead', async () => {
    serve([[KIE_NONE, PI_NONE]])
    renderPanel()
    const link = await screen.findByRole('link', { name: 'Add an API key' })
    expect(link).toHaveAttribute('href', '/settings?tab=credentials')
  })

  it('shows "Balance unavailable" with the reason', async () => {
    serve([[KIE_OK, { ...PI_OK, status: 'unavailable', amount: undefined, message: 'PiAPI answered without a readable balance.' }]])
    renderPanel()
    await waitFor(() => expect(trigger()).toHaveTextContent('PiAPI unavailable'))
    fireEvent.pointerEnter(trigger())
    const row = await screen.findByTestId('balance-row-piapi')
    expect(row).toHaveTextContent('Balance unavailable')
    expect(row).toHaveTextContent('PiAPI answered without a readable balance.')
  })

  it('shows a provider error with a retry', async () => {
    const user = userEvent.setup()
    const urls = serve([
      [{ ...KIE_OK, status: 'error', amount: undefined, kind: 'auth', message: 'Kie rejected the saved API key.' }, PI_NONE],
      [KIE_OK, PI_NONE],
    ])
    renderPanel()
    await waitFor(() => expect(trigger()).toHaveTextContent('Kie error'))
    await user.click(trigger())
    const row = await screen.findByTestId('balance-row-kie')
    expect(row).toHaveTextContent('Error')
    expect(row).toHaveTextContent('Kie rejected the saved API key.')
    await user.click(within(row).getByRole('button', { name: 'Retry Kie' }))
    await waitFor(() => expect(screen.getByTestId('balance-row-kie')).toHaveTextContent('1,234 credits'))
    expect(urls.at(-1)).toBe('/api/providers/balances?refresh=1')
  })

  it('shows a request failure, distinct from empty, with a retry', async () => {
    const user = userEvent.setup()
    serve([json({}, 500), [KIE_OK, PI_NONE]])
    renderPanel()
    await waitFor(() => expect(trigger()).toHaveTextContent('Credits unavailable'))
    await user.click(trigger())
    const panel = await screen.findByRole('dialog')
    expect(panel).toHaveTextContent(/Could not load balances/)
    await user.click(within(panel).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(trigger()).toHaveTextContent('1.2K credits'))
  })
})
