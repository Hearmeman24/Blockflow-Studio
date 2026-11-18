/**
 * Settings → Updates: each action (channel, automatic checks, Check now) has
 * its own pending and error state. The update provider is stubbed here; its
 * own behaviour is tested in app-update.test.tsx.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render as rtlRender, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'
import type { UpdateStatus } from '@/lib/app-update/client'

const checkNow = vi.fn<() => Promise<void>>()
const refresh = vi.fn<() => Promise<void>>()

function status(): UpdateStatus {
  return {
    current: '0.1.15', latest: null, update_available: false, notify: false, dismissed: null,
    checked_at: null, status: 'ok', message: 'Checked for updates.', channel: 'beta', checks_enabled: true,
    repo: 'Hearmeman24/Blockflow-Studio', supported: true, install: 'git', restart_automatic: true,
  } as UpdateStatus
}

vi.mock('@/components/app-update/app-update-provider', () => ({
  useAppUpdate: () => ({
    status: status(), error: undefined, isLoading: false, checkNow, refresh,
    requestUpdate: vi.fn(), dismiss: vi.fn(), updating: false,
  }),
}))
vi.mock('@/components/app-update/update-indicator', () => ({
  ManualUpdate: () => null,
  ReleaseNotes: () => null,
}))
vi.mock('@/lib/app-update/client', () => ({
  VERSION_URL: '/api/app/version',
  fetchVersion: vi.fn().mockResolvedValue({ version: '0.1.15', commit: 'abc', branch: 'main' }),
}))
vi.mock('@/lib/settings/client', () => ({ setAppPref: vi.fn() }))

import * as settingsClient from '@/lib/settings/client'
import { UpdatesSetting } from '../updates-setting'

const render = () => rtlRender(
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><UpdatesSetting /></SWRConfig>,
)
const toggle = () => screen.getByRole('switch', { name: 'Check for updates automatically' })
const checkButton = () => screen.getByRole('button', { name: 'Check now' })

beforeEach(() => {
  checkNow.mockReset().mockResolvedValue(undefined)
  refresh.mockReset().mockResolvedValue(undefined)
  vi.mocked(settingsClient.setAppPref).mockReset().mockResolvedValue(undefined)
})

describe('UpdatesSetting actions', () => {
  test('a pending check does not lock the channel or the automatic-checks switch', async () => {
    checkNow.mockImplementation(() => new Promise(() => {}))
    const user = userEvent.setup()
    render()
    await user.click(checkButton())
    expect(checkButton()).toBeDisabled()
    expect(toggle()).toBeEnabled()
    expect(screen.getByRole('combobox', { name: 'Update channel' })).toBeEnabled()
  })

  test('a pending switch change does not lock Check now or the channel', async () => {
    vi.mocked(settingsClient.setAppPref).mockImplementation(() => new Promise(() => {}))
    const user = userEvent.setup()
    render()
    await user.click(toggle())
    expect(settingsClient.setAppPref).toHaveBeenCalledWith('update_checks', 'false')
    expect(toggle()).toBeDisabled()
    expect(checkButton()).toBeEnabled()
    expect(screen.getByRole('combobox', { name: 'Update channel' })).toBeEnabled()
  })

  test('a failed check and a failed save each keep their own message', async () => {
    checkNow.mockRejectedValue(new Error('offline'))
    vi.mocked(settingsClient.setAppPref).mockRejectedValue(new Error('HTTP 500'))
    const user = userEvent.setup()
    render()
    await user.click(checkButton())
    expect(await screen.findByText('Could not check for updates. Try again.')).toBeInTheDocument()
    await user.click(toggle())
    expect(await screen.findByText('Could not save this setting. Try again.')).toBeInTheDocument()
    expect(screen.getByText('Could not check for updates. Try again.')).toBeInTheDocument()
  })

  test('a successful check clears only its own earlier error', async () => {
    checkNow.mockRejectedValueOnce(new Error('offline'))
    vi.mocked(settingsClient.setAppPref).mockRejectedValue(new Error('HTTP 500'))
    const user = userEvent.setup()
    render()
    await user.click(checkButton())
    await screen.findByText('Could not check for updates. Try again.')
    await user.click(toggle())
    await screen.findByText('Could not save this setting. Try again.')
    await user.click(checkButton())
    expect(screen.queryByText('Could not check for updates. Try again.')).not.toBeInTheDocument()
    expect(screen.getByText('Could not save this setting. Try again.')).toBeInTheDocument()
  })
})
