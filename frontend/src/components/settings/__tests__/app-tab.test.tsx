/**
 * Tests for the <AppTab>.
 *
 * App tab holds the small non-credential preferences:
 *   - BlockFlow Studio version (display-only, read from GET /api/app/version)
 *   - Output folder (<OutputFolderSetting>, tested in output-folder-setting.test.tsx)
 *   - Run history retention (one of 30/90/365/forever — app_pref)
 *   - Links section (docs, GitHub, etc.)
 *
 * Behavior tested:
 *   - Loads existing values on mount
 *   - Persists via setAppPref on change
 *   - Falls back to documented defaults when unset
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/settings/client', () => ({
  getAppPref: vi.fn(),
  setAppPref: vi.fn(),
}))

vi.mock('../updates-setting', () => ({
  UpdatesSetting: () => <section aria-label="updates setting" />,
}))

vi.mock('@/lib/app-update/client', () => ({
  VERSION_URL: '/api/app/version',
  fetchVersion: vi.fn(),
}))

vi.mock('../output-folder-setting', () => ({
  OutputFolderSetting: () => <section aria-label="output folder setting" />,
}))

import * as client from '@/lib/settings/client'
import * as updateClient from '@/lib/app-update/client'
import { AppTab } from '../app-tab'

// A fresh SWR cache per render, so one test's version answer never leaks into the next.
const render = (ui: React.ReactElement) =>
  rtlRender(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>)

beforeEach(() => {
  vi.mocked(updateClient.fetchVersion).mockReset()
  vi.mocked(updateClient.fetchVersion).mockResolvedValue({
    version: '0.1.0-beta.1', commit: 'abc1234', install: 'git', branch: 'main', dirty: false, update_supported: true,
  })
  vi.mocked(client.getAppPref).mockReset()
  vi.mocked(client.setAppPref).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AppTab', () => {
  test('shows the running version from /api/app/version, not a hard-coded one', async () => {
    vi.mocked(client.getAppPref).mockResolvedValue(null)
    render(<AppTab />)
    expect(await screen.findByText('0.1.0-beta.1')).toBeInTheDocument()
    expect(screen.getByText(/BlockFlow Studio/)).toBeInTheDocument()
    expect(updateClient.fetchVersion).toHaveBeenCalled()
  })

  test('says the version is unavailable when the backend cannot answer', async () => {
    vi.mocked(client.getAppPref).mockResolvedValue(null)
    vi.mocked(updateClient.fetchVersion).mockRejectedValue(new Error('offline'))
    render(<AppTab />)
    expect(await screen.findByText(/version unavailable/i)).toBeInTheDocument()
  })

  test('renders the output folder setting and no legacy relative-path field', async () => {
    vi.mocked(client.getAppPref).mockResolvedValue(null)
    render(<AppTab />)
    expect(await screen.findByRole('region', { name: /output folder setting/i })).toBeInTheDocument()
    expect(screen.queryByDisplayValue('./output')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/default output directory/i)).not.toBeInTheDocument()
    expect(client.getAppPref).not.toHaveBeenCalledWith('output_dir')
  })

  test('retention dropdown defaults to 90 days when unset', async () => {
    vi.mocked(client.getAppPref).mockResolvedValue(null)
    render(<AppTab />)

    const select = (await screen.findByLabelText(/Run history retention/i)) as HTMLSelectElement
    expect(select.value).toBe('90')
  })

  test('retention dropdown shows the stored value', async () => {
    vi.mocked(client.getAppPref).mockImplementation(async (name) => {
      if (name === 'run_history_retention_days') return '30'
      return null
    })

    render(<AppTab />)

    const select = (await screen.findByLabelText(/Run history retention/i)) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('30'))
  })

  test('changing retention calls setAppPref with the selected value', async () => {
    vi.mocked(client.getAppPref).mockResolvedValue(null)
    vi.mocked(client.setAppPref).mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<AppTab />)

    const select = await screen.findByLabelText(/Run history retention/i)
    await user.selectOptions(select, '365')

    await waitFor(() => {
      expect(client.setAppPref).toHaveBeenCalledWith('run_history_retention_days', '365')
    })
  })

  test('retention shows a loading state, not the default, until the stored value arrives', async () => {
    let answer!: (value: string | null) => void
    vi.mocked(client.getAppPref).mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    render(<AppTab />)

    expect(screen.queryByLabelText(/Run history retention/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('retention-loading')).toBeInTheDocument()
    answer('365')
    const select = (await screen.findByLabelText(/Run history retention/i)) as HTMLSelectElement
    expect(select.value).toBe('365')
  })

  test('a retention load error says so and Retry reads it again', async () => {
    vi.mocked(client.getAppPref)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('30')
    const user = userEvent.setup()
    render(<AppTab />)

    const message = await screen.findByText('Could not read the retention setting.')
    await user.click(within(message.parentElement!).getByRole('button', { name: 'Retry' }))
    const select = (await screen.findByLabelText(/Run history retention/i)) as HTMLSelectElement
    expect(select.value).toBe('30')
  })

  test('a failed retention save says so and shows the stored value again', async () => {
    vi.mocked(client.getAppPref).mockResolvedValue(null)
    vi.mocked(client.setAppPref).mockRejectedValue(new Error('HTTP 500'))
    const user = userEvent.setup()
    render(<AppTab />)

    const select = (await screen.findByLabelText(/Run history retention/i)) as HTMLSelectElement
    await user.selectOptions(select, '30')
    expect(await screen.findByText('Could not save this setting. Try again.')).toBeInTheDocument()
    expect(select.value).toBe('90')
  })

  test('retention cannot be changed again while a change is being saved', async () => {
    vi.mocked(client.getAppPref).mockResolvedValue(null)
    vi.mocked(client.setAppPref).mockImplementation(() => new Promise(() => {}))
    const user = userEvent.setup()
    render(<AppTab />)

    const select = (await screen.findByLabelText(/Run history retention/i)) as HTMLSelectElement
    await user.selectOptions(select, '30')
    expect(select.value).toBe('30')
    expect(select).toBeDisabled()
  })

  test('retention dropdown offers 30 / 90 / 365 / forever options', async () => {
    vi.mocked(client.getAppPref).mockResolvedValue(null)
    render(<AppTab />)

    const select = await screen.findByLabelText(/Run history retention/i)
    const options = Array.from(select.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value)
    expect(options).toEqual(['30', '90', '365', 'forever'])
  })

  test('"forever" retention persists the literal string "forever"', async () => {
    vi.mocked(client.getAppPref).mockResolvedValue(null)
    vi.mocked(client.setAppPref).mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<AppTab />)

    const select = await screen.findByLabelText(/Run history retention/i)
    await user.selectOptions(select, 'forever')

    await waitFor(() => {
      expect(client.setAppPref).toHaveBeenCalledWith('run_history_retention_days', 'forever')
    })
  })

  test('renders links section', async () => {
    vi.mocked(client.getAppPref).mockResolvedValue(null)
    render(<AppTab />)

    // Links go to this project, whose documentation is its README.
    expect(await screen.findByRole('link', { name: /GitHub/i }))
      .toHaveAttribute('href', 'https://github.com/Hearmeman24/Blockflow-Studio')
    expect(screen.getByRole('link', { name: /docs/i }))
      .toHaveAttribute('href', 'https://github.com/Hearmeman24/Blockflow-Studio#readme')
  })
})
