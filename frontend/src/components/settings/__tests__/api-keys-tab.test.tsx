import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const swrMocks = vi.hoisted(() => ({ mutate: vi.fn() }))
vi.mock('swr', () => ({ mutate: swrMocks.mutate }))

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMocks }))

import { ApiKeysTab } from '../api-keys-tab'
import { createFakeBackend, json, type FakeBackend } from './fake-settings-backend'

const KIE_KEY = 'kie-SECRET-0123456789abWXYZ'
const PIAPI_KEY = 'piapi-SECRET-9876543210cdQRST'

let backend: FakeBackend

function setup(initial: Record<string, string> = {}) {
  backend = createFakeBackend(initial)
  vi.stubGlobal('fetch', backend.fetch)
  const user = userEvent.setup()
  const view = render(<ApiKeysTab />)
  return { user, ...view }
}

const card = (name: RegExp) => screen.findByRole('region', { name })

beforeEach(() => {
  swrMocks.mutate.mockReset()
  Object.values(toastMocks).forEach((m) => m.mockReset())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ApiKeysTab states', () => {
  test('shows a skeleton while loading, then the cards', async () => {
    let release!: () => void
    backend = createFakeBackend()
    backend.override('GET /api/settings/credentials', () => new Promise<Response>((resolve) => {
      release = () => resolve(json({ credentials: [] }))
    }))
    vi.stubGlobal('fetch', backend.fetch)
    render(<ApiKeysTab />)

    expect(screen.getByText(/loading api keys/i)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /^kie$/i })).not.toBeInTheDocument()

    release()
    expect(await card(/^kie$/i)).toBeInTheDocument()
    expect(screen.queryByText(/loading api keys/i)).not.toBeInTheDocument()
  })

  test('shows an error with a retry that reloads', async () => {
    backend = createFakeBackend({ kie_api_key: KIE_KEY })
    let fail = true
    backend.override('GET /api/settings/credentials', () => {
      if (fail) return json({ detail: 'database is locked' }, 500)
      return json({ credentials: [
        { name: 'kie_api_key', configured: true, last4: 'WXYZ', updated_at: null },
        { name: 'piapi_api_key', configured: false, last4: null, updated_at: null },
      ] })
    })
    vi.stubGlobal('fetch', backend.fetch)
    const user = userEvent.setup()
    render(<ApiKeysTab />)

    expect(await screen.findByText(/could not load your api keys/i)).toBeInTheDocument()
    expect(screen.getByText(/database is locked/i)).toBeInTheDocument()

    fail = false
    await user.click(screen.getByRole('button', { name: /retry/i }))

    const kie = await card(/^kie$/i)
    expect(within(kie).getByText('Configured')).toBeInTheDocument()
    expect(screen.queryByText(/could not load your api keys/i)).not.toBeInTheDocument()
  })

  test('explains BYOK, local storage and Kie-only models', async () => {
    setup()
    await card(/^kie$/i)
    expect(screen.getByText(/pay the provider directly/i)).toBeInTheDocument()
    expect(screen.getAllByText(/stored locally on this machine/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/some models are only available with a kie key/i)).toBeInTheDocument()
  })

  test('has no wording from the removed services', async () => {
    const { container } = setup({ kie_api_key: KIE_KEY })
    await card(/^kie$/i)
    expect(container.textContent).not.toMatch(/runpod|serverless|comfy|topaz/i)
  })
})

describe('provider cards', () => {
  test('not configured: status text, badge and an add action, no masked key', async () => {
    setup()
    const kie = await card(/^kie$/i)
    expect(within(kie).getByText('Not configured')).toBeInTheDocument()
    expect(within(kie).getByRole('button', { name: /add key/i })).toBeInTheDocument()
    expect(within(kie).queryByRole('button', { name: /remove/i })).not.toBeInTheDocument()
    expect(within(kie).queryByRole('button', { name: /check key/i })).not.toBeInTheDocument()
    expect(within(kie).queryByText(/••••/)).not.toBeInTheDocument()

    const piapi = await card(/^piapi$/i)
    expect(within(piapi).getByText('Not configured')).toBeInTheDocument()
  })

  test('configured: masked key with last four, replace/remove/check actions', async () => {
    setup({ kie_api_key: KIE_KEY })
    const kie = await card(/^kie$/i)
    expect(within(kie).getByText('Configured')).toBeInTheDocument()
    expect(within(kie).getByText('••••WXYZ')).toBeInTheDocument()
    expect(within(kie).getByRole('button', { name: /replace key/i })).toBeInTheDocument()
    expect(within(kie).getByRole('button', { name: /remove/i })).toBeInTheDocument()
    expect(within(kie).getByRole('button', { name: /check key/i })).toBeInTheDocument()
  })

  test('a short configured key shows bullets only', async () => {
    setup({ piapi_api_key: 'short-key' })
    const piapi = await card(/^piapi$/i)
    expect(within(piapi).getByText('••••')).toBeInTheDocument()
    expect(within(piapi).queryByText(/-key/)).not.toBeInTheDocument()
  })

  test('add a key: password input, saved, masked, catalog revalidated, input cleared', async () => {
    const { user, container } = setup()
    const kie = await card(/^kie$/i)

    await user.click(within(kie).getByRole('button', { name: /add key/i }))
    const input = within(kie).getByLabelText(/kie api key/i)
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveValue('')
    expect(within(kie).getByText(/stored locally on this machine/i)).toBeInTheDocument()

    await user.type(input, KIE_KEY)
    await user.click(within(kie).getByRole('button', { name: /save key/i }))

    await waitFor(() => expect(within(kie).getByText('Configured')).toBeInTheDocument())
    expect(backend.keys.get('kie_api_key')).toBe(KIE_KEY)
    expect(within(kie).getByText('••••WXYZ')).toBeInTheDocument()
    expect(within(kie).queryByLabelText(/kie api key/i)).not.toBeInTheDocument()
    expect(swrMocks.mutate).toHaveBeenCalledWith('/api/providers/catalog')
    expect(toastMocks.success).toHaveBeenCalledWith(expect.stringMatching(/kie key saved/i))
    expect(container.innerHTML).not.toContain(KIE_KEY)
  })

  test('keyboard flow: open the form, type, Enter saves, focus returns', async () => {
    const { user } = setup()
    const piapi = await card(/^piapi$/i)
    const add = within(piapi).getByRole('button', { name: /add key/i })
    add.focus()

    await user.keyboard('{Enter}')
    const input = within(piapi).getByLabelText(/piapi api key/i)
    expect(input).toHaveFocus()

    await user.keyboard(`${PIAPI_KEY}{Enter}`)

    await waitFor(() => expect(backend.keys.get('piapi_api_key')).toBe(PIAPI_KEY))
    await waitFor(() => expect(within(piapi).getByRole('button', { name: /replace key/i })).toHaveFocus())
  })

  test('Escape cancels the form without saving', async () => {
    const { user } = setup()
    const kie = await card(/^kie$/i)
    await user.click(within(kie).getByRole('button', { name: /add key/i }))
    await user.type(within(kie).getByLabelText(/kie api key/i), 'abc{Escape}')
    expect(within(kie).queryByLabelText(/kie api key/i)).not.toBeInTheDocument()
    expect(backend.fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  })

  test('save is disabled for blank input', async () => {
    const { user } = setup()
    const kie = await card(/^kie$/i)
    await user.click(within(kie).getByRole('button', { name: /add key/i }))
    expect(within(kie).getByRole('button', { name: /save key/i })).toBeDisabled()
    await user.type(within(kie).getByLabelText(/kie api key/i), '   ')
    expect(within(kie).getByRole('button', { name: /save key/i })).toBeDisabled()
  })

  test('replace a key: input is empty (never pre-filled), new key saved', async () => {
    const { user, container } = setup({ kie_api_key: KIE_KEY })
    const kie = await card(/^kie$/i)

    await user.click(within(kie).getByRole('button', { name: /replace key/i }))
    const input = within(kie).getByLabelText(/new kie api key/i)
    expect(input).toHaveValue('')

    await user.type(input, 'kie-REPLACED-00000000LMNO')
    await user.click(within(kie).getByRole('button', { name: /save key/i }))

    await waitFor(() => expect(within(kie).getByText('••••LMNO')).toBeInTheDocument())
    expect(backend.keys.get('kie_api_key')).toBe('kie-REPLACED-00000000LMNO')
    expect(swrMocks.mutate).toHaveBeenCalledWith('/api/providers/catalog')
    expect(container.innerHTML).not.toContain(KIE_KEY)
    expect(container.innerHTML).not.toContain('kie-REPLACED-00000000LMNO')
  })

  test('a rejected save keeps the form and the typed value and shows the reason', async () => {
    const { user } = setup()
    backend.override('PUT /api/settings/credentials/kie_api_key', () =>
      json({ detail: 'API key must not contain spaces or line breaks.' }, 422))
    const kie = await card(/^kie$/i)

    await user.click(within(kie).getByRole('button', { name: /add key/i }))
    await user.type(within(kie).getByLabelText(/kie api key/i), 'bad key')
    await user.click(within(kie).getByRole('button', { name: /save key/i }))

    expect(await within(kie).findByRole('alert')).toHaveTextContent(/must not contain spaces/i)
    expect(within(kie).getByLabelText(/kie api key/i)).toHaveValue('bad key')
    expect(within(kie).getByText('Not configured')).toBeInTheDocument()
    expect(swrMocks.mutate).not.toHaveBeenCalled()
  })

  test('remove asks for confirmation; cancel keeps the key', async () => {
    const { user } = setup({ kie_api_key: KIE_KEY })
    const kie = await card(/^kie$/i)

    await user.click(within(kie).getByRole('button', { name: /remove/i }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/remove the kie api key/i)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(backend.keys.get('kie_api_key')).toBe(KIE_KEY)
    expect(within(kie).getByText('Configured')).toBeInTheDocument()
  })

  test('remove confirmed: key deleted, status updated, catalog revalidated', async () => {
    const { user } = setup({ kie_api_key: KIE_KEY })
    const kie = await card(/^kie$/i)

    await user.click(within(kie).getByRole('button', { name: /remove/i }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: /remove key/i }))

    await waitFor(() => expect(within(kie).getByText('Not configured')).toBeInTheDocument())
    expect(backend.keys.has('kie_api_key')).toBe(false)
    expect(within(kie).queryByText(/••••/)).not.toBeInTheDocument()
    expect(swrMocks.mutate).toHaveBeenCalledWith('/api/providers/catalog')
    expect(toastMocks.success).toHaveBeenCalledWith(expect.stringMatching(/kie key removed/i))
  })

  test('a failed remove keeps the status and reports the error', async () => {
    const { user } = setup({ kie_api_key: KIE_KEY })
    backend.override('DELETE /api/settings/credentials/kie_api_key', () => json({ detail: 'disk full' }, 500))
    const kie = await card(/^kie$/i)

    await user.click(within(kie).getByRole('button', { name: /remove/i }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /remove key/i }))

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith(expect.stringMatching(/disk full/)))
    expect(within(kie).getByText('Configured')).toBeInTheDocument()
    expect(swrMocks.mutate).not.toHaveBeenCalled()
  })
})

describe('check key', () => {
  test('valid key with balance', async () => {
    const { user } = setup({ kie_api_key: KIE_KEY })
    backend.checks.set('kie', { ok: true, valid: true, message: 'Key accepted.', balance: 42.5, balance_unit: 'credits' })
    const kie = await card(/^kie$/i)

    await user.click(within(kie).getByRole('button', { name: /check key/i }))

    const status = within(kie).getByRole('status')
    await waitFor(() => expect(status).toHaveTextContent(/valid/i))
    expect(status).toHaveTextContent(/42\.5 credits/)
    expect(backend.calls()).toContain('POST /api/providers/kie/validate-key')
  })

  test('invalid key', async () => {
    const { user } = setup({ piapi_api_key: PIAPI_KEY })
    backend.checks.set('piapi', { ok: true, valid: false, message: 'PiAPI rejected this key.' })
    const piapi = await card(/^piapi$/i)

    await user.click(within(piapi).getByRole('button', { name: /check key/i }))

    const status = within(piapi).getByRole('status')
    await waitFor(() => expect(status).toHaveTextContent(/invalid/i))
    expect(status).toHaveTextContent(/piapi rejected this key/i)
    expect(backend.calls()).toContain('POST /api/providers/piapi/validate-key')
  })

  test('provider unreachable (502 body) shows "could not check"', async () => {
    const { user } = setup({ kie_api_key: KIE_KEY })
    backend.checks.set('kie', { ok: false, valid: null, message: 'Could not reach Kie.' })
    const kie = await card(/^kie$/i)

    await user.click(within(kie).getByRole('button', { name: /check key/i }))

    const status = within(kie).getByRole('status')
    await waitFor(() => expect(status).toHaveTextContent(/could not reach kie/i))
    expect(status).toHaveTextContent(/not checked/i)
  })

  function holdCheck() {
    let release!: () => void
    backend.override('POST /api/providers/kie/validate-key', () => new Promise<Response>((resolve) => {
      release = () => resolve(json({ ok: true, valid: true, message: 'Key accepted.', balance: 42.5, balance_unit: 'credits' }))
    }))
    return () => release()
  }

  test('a check still running when the key is removed shows no result for the removed key', async () => {
    const { user } = setup({ kie_api_key: KIE_KEY })
    const release = holdCheck()
    const kie = await card(/^kie$/i)

    await user.click(within(kie).getByRole('button', { name: /check key/i }))
    await user.click(within(kie).getByRole('button', { name: /remove/i }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /remove key/i }))
    await waitFor(() => expect(within(kie).getByText('Not configured')).toBeInTheDocument())

    release()
    await new Promise((r) => setTimeout(r, 0))
    const status = within(kie).getByRole('status')
    expect(status).not.toHaveTextContent(/valid/i)
    expect(status).not.toHaveTextContent(/42\.5/)
  })

  test('a check still running when the key is replaced shows no result for the old key', async () => {
    const { user } = setup({ kie_api_key: KIE_KEY })
    const release = holdCheck()
    const kie = await card(/^kie$/i)

    await user.click(within(kie).getByRole('button', { name: /check key/i }))
    await user.click(within(kie).getByRole('button', { name: /replace key/i }))
    await user.type(within(kie).getByLabelText(/new kie api key/i), 'kie-NEW-0123456789abNEWK')
    await user.click(within(kie).getByRole('button', { name: /save key/i }))
    await waitFor(() => expect(within(kie).getByText(/NEWK/)).toBeInTheDocument())

    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(within(kie).getByRole('status')).not.toHaveTextContent(/valid|42\.5/i)
  })

  test('Replace and Check are disabled while the key is being removed', async () => {
    const { user } = setup({ kie_api_key: KIE_KEY })
    backend.override('DELETE /api/settings/credentials/kie_api_key', () => new Promise<Response>(() => {}))
    const kie = await card(/^kie$/i)

    await user.click(within(kie).getByRole('button', { name: /remove/i }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /remove key/i }))

    expect(await within(kie).findByRole('button', { name: /removing/i })).toBeDisabled()
    expect(within(kie).getByRole('button', { name: /replace key/i })).toBeDisabled()
    expect(within(kie).getByRole('button', { name: /check key/i })).toBeDisabled()
  })

  test('network error shows a recoverable message', async () => {
    const { user } = setup({ kie_api_key: KIE_KEY })
    backend.override('POST /api/providers/kie/validate-key', () => {
      throw new TypeError('Failed to fetch')
    })
    const kie = await card(/^kie$/i)

    await user.click(within(kie).getByRole('button', { name: /check key/i }))

    const status = within(kie).getByRole('status')
    await waitFor(() => expect(status).toHaveTextContent(/could not check the key/i))
    expect(within(kie).getByRole('button', { name: /check key/i })).toBeEnabled()
  })
})

describe('sign-up links', () => {
  test('exact referral hrefs, new tab, noopener noreferrer', async () => {
    setup()
    const kie = await card(/^kie$/i)
    const kieLink = within(kie).getByRole('link', { name: /get a kie api key/i })
    expect(kieLink).toHaveAttribute('href', 'https://kie.ai/?ref=071ed206b70bc522e7626d3b4d1ad069')
    expect(kieLink).toHaveAttribute('target', '_blank')
    expect(kieLink).toHaveAttribute('rel', 'noopener noreferrer')

    const piapi = await card(/^piapi$/i)
    const piLink = within(piapi).getByRole('link', { name: /get a piapi api key/i })
    expect(piLink).toHaveAttribute('href', 'https://piapi.ai/?ref=dbc2855b-3394-4052-8b8a-6dcc471bfced')
    expect(piLink).toHaveAttribute('target', '_blank')
    expect(piLink).toHaveAttribute('rel', 'noopener noreferrer')
  })
})

describe('the two BYOK providers, then the optional Prompt Writer settings', () => {
  test('shows the Kie and PiAPI cards first, then OpenRouter and the local servers; no tmpfiles', async () => {
    const { container } = setup()
    await card(/^kie$/i)
    await screen.findByLabelText('Ollama URL')
    const names = screen.getAllByRole('region').map((r) => r.getAttribute('aria-labelledby'))
      .map((id) => document.getElementById(id ?? '')?.textContent)
    expect(names).toEqual(['Kie', 'PiAPI', 'OpenRouter (optional)', 'Local LLM servers'])
    expect(container.textContent).not.toMatch(/tmpfiles/i)
  })
})
