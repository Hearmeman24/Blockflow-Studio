import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const swrMocks = vi.hoisted(() => ({ mutate: vi.fn() }))
vi.mock('swr', () => ({ mutate: swrMocks.mutate }))

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

import { ApiKeysTab } from '../api-keys-tab'
import { createFakeBackend, json, type FakeBackend } from './fake-settings-backend'

const OR_KEY = 'sk-or-v1-SECRET-0123456789abcdefQRST'
let backend: FakeBackend

function setup(initial: Record<string, string> = {}, prefs: Record<string, string> = {}) {
  backend = createFakeBackend(initial)
  for (const [name, value] of Object.entries(prefs)) backend.prefs.set(name, value)
  vi.stubGlobal('fetch', backend.fetch)
  const user = userEvent.setup()
  const view = render(<ApiKeysTab />)
  return { user, ...view }
}

const openRouterCard = () => screen.findByRole('region', { name: 'OpenRouter (optional)' })

beforeEach(() => {
  swrMocks.mutate.mockReset()
  Object.values(toastMocks).forEach((m) => m.mockReset())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenRouter card', () => {
  test('is marked optional and Prompt Writer only, after the generation providers', async () => {
    setup()
    const card = await openRouterCard()
    expect(within(card).getByText('Used by the Prompt Writer block only.')).toBeInTheDocument()
    expect(within(card).getByText('Not configured')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: /check key/i })).not.toBeInTheDocument()
    expect(screen.getByText(/not needed for image or video generation/i)).toBeInTheDocument()
  })

  test('add a key: saved, masked, never in the DOM, Prompt Writer revalidated, generation catalog untouched', async () => {
    const { user, container } = setup()
    const card = await openRouterCard()
    await user.click(within(card).getByRole('button', { name: /add key/i }))
    const input = within(card).getByLabelText('OpenRouter API key')
    expect(input).toHaveAttribute('type', 'password')
    await user.type(input, OR_KEY)
    await user.click(within(card).getByRole('button', { name: /save key/i }))

    await waitFor(() => expect(within(card).getByText('Configured')).toBeInTheDocument())
    expect(within(card).getByText('••••QRST')).toBeInTheDocument()
    expect(backend.keys.get('openrouter_api_key')).toBe(OR_KEY)
    expect(container.innerHTML).not.toContain(OR_KEY)
    expect(container.innerHTML).not.toContain('SECRET')
    expect(swrMocks.mutate).toHaveBeenCalledWith('/api/blocks/prompt_writer/providers')
    expect(swrMocks.mutate).not.toHaveBeenCalledWith('/api/providers/catalog')
    expect(toastMocks.success).toHaveBeenCalledWith('OpenRouter key saved.')
  })

  test('replace a key', async () => {
    const { user, container } = setup({ openrouter_api_key: 'sk-or-v1-old-key-000000001111' })
    const card = await openRouterCard()
    expect(within(card).getByText('••••1111')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: /replace key/i }))
    await user.type(within(card).getByLabelText('New OpenRouter API key'), OR_KEY)
    await user.click(within(card).getByRole('button', { name: /save key/i }))
    await waitFor(() => expect(within(card).getByText('••••QRST')).toBeInTheDocument())
    expect(backend.keys.get('openrouter_api_key')).toBe(OR_KEY)
    expect(container.innerHTML).not.toContain(OR_KEY)
  })

  test('remove a key after confirming', async () => {
    const { user } = setup({ openrouter_api_key: OR_KEY })
    const card = await openRouterCard()
    await user.click(within(card).getByRole('button', { name: /^remove$/i }))
    await user.click(await screen.findByRole('button', { name: /remove key/i }))
    await waitFor(() => expect(within(card).getByText('Not configured')).toBeInTheDocument())
    expect(backend.keys.has('openrouter_api_key')).toBe(false)
    expect(backend.calls()).toContain('DELETE /api/settings/credentials/openrouter_api_key')
    expect(swrMocks.mutate).toHaveBeenCalledWith('/api/blocks/prompt_writer/providers')
  })

  test('check key calls the Prompt Writer check, not the generation provider check', async () => {
    const { user } = setup({ openrouter_api_key: OR_KEY })
    const card = await openRouterCard()
    await user.click(within(card).getByRole('button', { name: /check key/i }))
    expect(await within(card).findByText('Valid')).toBeInTheDocument()
    expect(within(card).getByText('OpenRouter accepted the key.')).toBeInTheDocument()
    expect(backend.calls()).toContain('POST /api/blocks/prompt_writer/check-key')
    expect(backend.calls().some((c) => c.includes('/api/providers/'))).toBe(false)
  })

  test('check key shows a rejected key', async () => {
    const { user } = setup({ openrouter_api_key: OR_KEY })
    backend.checks.set('openrouter', { ok: true, valid: false, message: 'OpenRouter rejected the key.' })
    const card = await openRouterCard()
    await user.click(within(card).getByRole('button', { name: /check key/i }))
    expect(await within(card).findByText('Invalid')).toBeInTheDocument()
  })

  test('a rejected value shows the server message and is not stored', async () => {
    const { user } = setup()
    backend.override('PUT /api/settings/credentials/openrouter_api_key',
      () => json({ detail: 'API key must not contain spaces or line breaks.' }, 422))
    const card = await openRouterCard()
    await user.click(within(card).getByRole('button', { name: /add key/i }))
    await user.type(within(card).getByLabelText('OpenRouter API key'), 'has a space')
    await user.click(within(card).getByRole('button', { name: /save key/i }))
    expect(await within(card).findByRole('alert')).toHaveTextContent('API key must not contain spaces or line breaks.')
    expect(backend.keys.has('openrouter_api_key')).toBe(false)
  })
})

describe('Local LLM servers', () => {
  test('shows each server with its default', async () => {
    setup()
    const ollama = await screen.findByLabelText('Ollama URL')
    expect(ollama).toHaveValue('')
    expect(ollama).toHaveAttribute('placeholder', 'http://localhost:11434')
    expect(screen.getByLabelText('LM Studio URL')).toHaveAttribute('placeholder', 'http://localhost:1234')
    expect(screen.getByText('Using the default, http://localhost:11434.')).toBeInTheDocument()
  })

  test('saves a URL, shows the stored value and revalidates the Prompt Writer', async () => {
    const { user } = setup()
    const input = await screen.findByLabelText('LM Studio URL')
    await user.type(input, 'http://192.168.1.20:1234/')
    const form = input.closest('form')!
    await user.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(backend.prefs.get('lmstudio_base_url')).toBe('http://192.168.1.20:1234'))
    expect(await screen.findByText('Using http://192.168.1.20:1234.')).toBeInTheDocument()
    expect(input).toHaveValue('http://192.168.1.20:1234')
    expect(swrMocks.mutate).toHaveBeenCalledWith('/api/blocks/prompt_writer/providers')
  })

  test('shows the validation message for an invalid URL and keeps the old value', async () => {
    const { user } = setup({}, { ollama_base_url: 'http://localhost:9999' })
    const input = await screen.findByLabelText('Ollama URL')
    expect(input).toHaveValue('http://localhost:9999')
    await user.clear(input)
    await user.type(input, 'ftp://nope')
    await user.click(within(input.closest('form')!).getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The URL must start with http:// or https://.')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(backend.prefs.get('ollama_base_url')).toBe('http://localhost:9999')
  })

  test('Use default clears the saved URL', async () => {
    const { user } = setup({}, { ollama_base_url: 'http://10.0.0.2:11434' })
    const input = await screen.findByLabelText('Ollama URL')
    await user.click(within(input.closest('form')!).getByRole('button', { name: 'Use default' }))
    await waitFor(() => expect(backend.prefs.get('ollama_base_url')).toBe(''))
    expect(input).toHaveValue('')
    expect(screen.getByText('Using the default, http://localhost:11434.')).toBeInTheDocument()
  })

  test('shows an error with a retry when the prefs cannot be loaded', async () => {
    backend = createFakeBackend()
    let fail = true
    backend.override('GET /api/settings/app-prefs/ollama_base_url', () => (fail
      ? json({ detail: 'database is locked' }, 500)
      : json({ name: 'ollama_base_url', value: null })))
    vi.stubGlobal('fetch', backend.fetch)
    const user = userEvent.setup()
    render(<ApiKeysTab />)
    expect(await screen.findByText('Could not load the local server settings')).toBeInTheDocument()
    fail = false
    const section = screen.getByRole('region', { name: 'Local LLM servers' })
    await user.click(within(section).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByLabelText('Ollama URL')).toBeInTheDocument()
  })
})
