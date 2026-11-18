/**
 * Update indicator, update flow and Settings → Updates, against a fake backend
 * at the fetch boundary.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'
import type { ReactNode } from 'react'
import { AppUpdateProvider, RESTART_POLL_MS } from './app-update-provider'
import { UpdateIndicator } from './update-indicator'
import { UpdatesSetting } from '@/components/settings/updates-setting'
import type { UpdateProgress, UpdateStatus } from '@/lib/app-update/client'

vi.mock('@/lib/settings/client', () => ({ setAppPref: vi.fn().mockResolvedValue(undefined) }))
import * as settingsClient from '@/lib/settings/client'

const XSS = '<script>window.__pwned = true</script><img src=x onerror="window.__pwned=true"> Fixed **bugs**'

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    current: '0.1.15',
    latest: {
      version: '0.2.0', tag: 'v0.2.0', name: 'v0.2.0', published_at: '2026-11-01T10:00:00Z',
      url: 'https://github.com/Hearmeman24/Blockflow-Studio/releases/tag/v0.2.0', notes: XSS, prerelease: false,
    },
    update_available: true, notify: true, dismissed: null, checked_at: 1_700_000_000, status: 'ok',
    message: 'Checked for updates.', channel: 'beta', checks_enabled: true, repo: 'Hearmeman24/Blockflow-Studio',
    supported: true, install: 'git', restart_automatic: true, ...overrides,
  }
}

const STEPS = ['preflight', 'fetch', 'verify', 'pause', 'merge', 'python_deps', 'frontend_deps', 'codegen', 'build', 'restart']
function progress(state: UpdateProgress['state'], overrides: Partial<UpdateProgress> = {}): UpdateProgress {
  return {
    state, step: state === 'running' ? 'merge' : state === 'restarting' ? 'restart' : null,
    steps: STEPS.map((id, i) => ({ id, label: `Step ${id}`, status: i < 4 ? 'done' : state === 'running' && id === 'merge' ? 'running' : 'pending' })),
    log_tail: ['$ git fetch --tags origin', '(exit 0)'], error: null, message: null, manual: [],
    restart: { automatic: true, required: true, command: 'uv run app.py' },
    tag: 'v0.2.0', from_version: '0.1.15', to_version: '0.2.0', ...overrides,
  }
}

type Handler = (init?: RequestInit) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }> | 'network-error'

let routes: Record<string, Handler>
let calls: { url: string; method: string; body?: unknown }[]

function route(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, '')
}

beforeEach(() => {
  calls = []
  routes = {
    'GET /api/app/update': () => ({ body: status() }),
    'GET /api/app/update/progress': () => ({ body: progress('idle') }),
    'GET /api/app/version': () => ({ body: { version: '0.1.15', commit: 'abc123def456', branch: 'main', install: 'git' } }),
    'POST /api/app/update/progress/ack': () => ({ body: progress('idle') }),
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = route(String(input))
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const handler = routes[`${method} ${url}`]
    if (!handler) return new Response(JSON.stringify({ detail: 'no route' }), { status: 404 })
    const out = await handler(init)
    if (out === 'network-error') throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200 })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete (window as unknown as { __pwned?: boolean }).__pwned
})

function wrap(ui: ReactNode, reload = vi.fn()) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <AppUpdateProvider reload={reload}>{ui}</AppUpdateProvider>
    </SWRConfig>,
  )
}

describe('UpdateIndicator', () => {
  test('is hidden when no update is available', async () => {
    routes['GET /api/app/update'] = () => ({ body: status({ update_available: false, notify: false }) })
    wrap(<UpdateIndicator />)
    await waitFor(() => expect(calls.some((c) => c.url === '/api/app/update')).toBe(true))
    expect(screen.queryByRole('button', { name: /update available/i })).not.toBeInTheDocument()
  })

  test('is hidden for a skipped version', async () => {
    routes['GET /api/app/update'] = () => ({ body: status({ notify: false, dismissed: 'skipped' }) })
    wrap(<UpdateIndicator />)
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(screen.queryByRole('button', { name: /update available/i })).not.toBeInTheDocument()
  })

  test('shows an accessible button and a popover with plain-text notes', async () => {
    const user = userEvent.setup()
    wrap(<UpdateIndicator />)
    const button = await screen.findByRole('button', { name: 'Update available: v0.2.0' })
    await user.click(button)
    const dialog = await screen.findByRole('dialog', { name: 'Update available' })
    expect(within(dialog).getByText('v0.1.15')).toBeInTheDocument()
    expect(within(dialog).getByText('v0.2.0')).toBeInTheDocument()
    expect(within(dialog).getByText(/Released/)).toBeInTheDocument()
    const notes = within(dialog).getByTestId('release-notes')
    expect(notes.textContent).toBe(XSS)
    expect(notes.querySelector('script, img')).toBeNull()
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined()
    const link = within(dialog).getByRole('link', { name: /view the release on github/i })
    expect(link).toHaveAttribute('href', 'https://github.com/Hearmeman24/Blockflow-Studio/releases/tag/v0.2.0')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(within(dialog).getByRole('button', { name: 'Update now' })).toBeInTheDocument()
  })

  test('unsupported installs show the reason and manual commands instead of Update now', async () => {
    const user = userEvent.setup()
    routes['GET /api/app/update'] = () => ({ body: status({ supported: false, reason: "This checkout's 'origin' is not the release repository." }) })
    wrap(<UpdateIndicator />)
    await user.click(await screen.findByRole('button', { name: /update available/i }))
    const dialog = await screen.findByRole('dialog', { name: 'Update available' })
    expect(within(dialog).queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument()
    expect(within(dialog).getByText(/origin' is not the release repository/)).toBeInTheDocument()
    expect(within(dialog).getByText(/git merge --ff-only v0.2.0/)).toBeInTheDocument()
  })

  test.each([['Skip this version', 'skip'], ['Remind me later', 'later']])('%s stores the dismissal', async (label, action) => {
    const user = userEvent.setup()
    routes['POST /api/app/update/dismiss'] = () => ({ body: status({ notify: false, dismissed: action === 'skip' ? 'skipped' : 'snoozed' }) })
    wrap(<UpdateIndicator />)
    await user.click(await screen.findByRole('button', { name: /update available/i }))
    await user.click(await screen.findByRole('button', { name: label }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /update available/i })).not.toBeInTheDocument())
    expect(calls.find((c) => c.url === '/api/app/update/dismiss')?.body).toEqual({ tag: 'v0.2.0', action })
  })
})

describe('update flow', () => {
  async function openConfirm(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: /update available/i }))
    await user.click(await screen.findByRole('button', { name: 'Update now' }))
    return screen.findByRole('alertdialog')
  }

  test('confirms before starting, then shows progress, restarting and done', async () => {
    const user = userEvent.setup()
    const reload = vi.fn()
    let current: UpdateProgress = progress('running')
    let version = '0.1.15'
    routes['POST /api/app/update/apply'] = () => ({ status: 202, body: current })
    routes['GET /api/app/version'] = () => (version === 'down' ? 'network-error' : { body: { version } })
    // The progress check on mount reports idle: no dialog yet.
    wrap(<UpdateIndicator />, reload)
    const confirm = await openConfirm(user)
    expect(within(confirm).getByText(/restarts/)).toBeInTheDocument()
    expect(calls.some((c) => c.url === '/api/app/update/apply')).toBe(false)
    routes['GET /api/app/update/progress'] = () => ({ body: current })
    await user.click(within(confirm).getByRole('button', { name: 'Update and restart' }))
    expect(calls.find((c) => c.url === '/api/app/update/apply')?.body).toEqual({ tag: 'v0.2.0', allow_active_jobs: false })

    const dialog = await screen.findByRole('dialog', { name: /Updating to v0.2.0/ })
    expect(within(dialog).getByTestId('update-step-merge')).toHaveAttribute('data-status', 'running')
    expect(within(dialog).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Show details' }))
    expect(within(dialog).getByLabelText('Update log').textContent).toContain('git fetch --tags origin')

    current = progress('restarting')
    version = 'down'
    await screen.findByRole('dialog', { name: /Restarting/ }, { timeout: 3000 })
    version = '0.2.0'
    current = progress('done', { steps: progress('done').steps.map((s) => ({ ...s, status: 'done' })), message: 'Updated to v0.2.0.' })
    const done = await screen.findByRole('dialog', { name: 'Updated to v0.2.0' }, { timeout: RESTART_POLL_MS * 3 })
    await user.click(within(done).getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(reload).toHaveBeenCalled())
  }, 15_000)

  test('active jobs need an explicit choice', async () => {
    const user = userEvent.setup()
    routes['POST /api/app/update/apply'] = (init) => {
      const body = JSON.parse(String(init?.body))
      if (!body.allow_active_jobs) {
        return { status: 409, body: { code: 'blocked', detail: 'x', blockers: [{ code: 'active_jobs', message: '2 generation jobs are still running.' }] } }
      }
      return { status: 202, body: progress('running') }
    }
    wrap(<UpdateIndicator />)
    const confirm = await openConfirm(user)
    await user.click(within(confirm).getByRole('button', { name: 'Update and restart' }))
    expect(await within(confirm).findByText('2 generation jobs are still running.')).toBeInTheDocument()
    expect(within(confirm).queryByRole('button', { name: 'Update and restart' })).not.toBeInTheDocument()
    await user.click(within(confirm).getByRole('button', { name: 'Update anyway' }))
    expect(calls.filter((c) => c.url === '/api/app/update/apply').map((c) => c.body)).toEqual([
      { tag: 'v0.2.0', allow_active_jobs: false }, { tag: 'v0.2.0', allow_active_jobs: true }])
    expect(await screen.findByRole('dialog', { name: /Updating to/ })).toBeInTheDocument()
  })

  test('other blockers are explained and cannot be overridden', async () => {
    const user = userEvent.setup()
    routes['POST /api/app/update/apply'] = () => ({ status: 409, body: { code: 'blocked', detail: 'x', blockers: [{ code: 'dirty', message: 'These files in the app folder have changes: app.py.' }] } })
    wrap(<UpdateIndicator />)
    const confirm = await openConfirm(user)
    await user.click(within(confirm).getByRole('button', { name: 'Update and restart' }))
    expect(await within(confirm).findByText(/have changes: app.py/)).toBeInTheDocument()
    expect(within(confirm).queryByRole('button', { name: 'Update anyway' })).not.toBeInTheDocument()
    expect(within(confirm).getByRole('button', { name: 'Update and restart' })).toBeDisabled()
  })

  test.each([
    ['failed', 'Update failed', 'The update did not finish', 'git reset --keep aaaa'],
    ['rolled_back', 'Update undone', 'Nothing changed', 'git merge --ff-only v0.2.0'],
  ] as const)('a %s update shows what happened and what to do', async (state, title, panel, command) => {
    const user = userEvent.setup()
    routes['GET /api/app/update/progress'] = () => ({ body: progress(state, { error: 'Updating web packages failed (npm ci).', manual: [command] }) })
    wrap(<UpdateIndicator />)
    const dialog = await screen.findByRole('dialog', { name: title })
    expect(within(dialog).getByText(panel)).toBeInTheDocument()
    expect(within(dialog).getByText('Updating web packages failed (npm ci).')).toBeInTheDocument()
    expect(within(dialog).getByText(command)).toBeInTheDocument()
    await user.click(within(dialog).getAllByRole('button', { name: 'Close' })[0])
    await waitFor(() => expect(calls.some((c) => c.url === '/api/app/update/progress/ack' && c.method === 'POST')).toBe(true))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: title })).not.toBeInTheDocument())
  })

  test('a manual restart says the exact command', async () => {
    routes['GET /api/app/update/progress'] = () => ({ body: progress('done', {
      restart: { automatic: false, required: true, command: 'uv run app.py' },
      message: 'Updated to v0.2.0. Restart BlockFlow to use it.' }) })
    wrap(<UpdateIndicator />)
    const dialog = await screen.findByRole('dialog', { name: 'Updated, restart needed' })
    expect(within(dialog).getByText('uv run app.py')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument()
  })

  test('progress is announced politely', async () => {
    routes['GET /api/app/update/progress'] = () => ({ body: progress('running') })
    wrap(<UpdateIndicator />)
    const dialog = await screen.findByRole('dialog', { name: /Updating/ })
    const live = within(dialog).getByRole('status')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live.textContent).toContain('Step merge')
  })
})

describe('Settings → Updates', () => {
  test('shows a skeleton while loading, then version, commit, channel and last check', async () => {
    let resolve!: (v: { body: unknown }) => void
    routes['GET /api/app/update'] = () => new Promise((r) => { resolve = r })
    wrap(<UpdatesSetting />)
    expect(screen.getByTestId('updates-loading')).toBeInTheDocument()
    await act(async () => resolve({ body: status({ update_available: false, notify: false }) }))
    expect(await screen.findByText('0.1.15')).toBeInTheDocument()
    expect(await screen.findByText(/abc123def456/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Update channel' })).toHaveTextContent('Beta')
    expect(screen.getByText(/Last checked .*BlockFlow is up to date/)).toBeInTheDocument()
  })

  test('shows an error with a retry', async () => {
    const user = userEvent.setup()
    routes['GET /api/app/update'] = () => ({ status: 500, body: { detail: 'boom' } })
    wrap(<UpdatesSetting />)
    expect(await screen.findByText('Could not read the update status')).toBeInTheDocument()
    routes['GET /api/app/update'] = () => ({ body: status() })
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(/v0.2.0 is available/)).toBeInTheDocument()
  })

  test('the toggle and Check now use the backend', async () => {
    const user = userEvent.setup()
    routes['POST /api/app/update/check'] = () => ({ body: status({ status: 'not_found', message: 'No releases are published yet.', latest: null, update_available: false, notify: false }) })
    wrap(<UpdatesSetting />)
    await user.click(await screen.findByRole('button', { name: 'Check now' }))
    expect(await screen.findByText(/No releases are published yet/)).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Check for updates automatically' }))
    expect(settingsClient.setAppPref).toHaveBeenCalledWith('update_checks', 'false')
  })

  test('offers the same Update action', async () => {
    const user = userEvent.setup()
    wrap(<UpdatesSetting />)
    await user.click(await screen.findByRole('button', { name: 'Update now' }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Update to v0.2.0?')
  })
})
