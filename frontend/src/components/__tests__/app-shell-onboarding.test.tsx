import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

let pathname = '/generate'

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/components/nav-bar', () => ({ NavBar: () => <nav aria-label="nav">nav</nav> }))
vi.mock('@/components/sidebar', () => ({ Sidebar: () => <aside>sidebar</aside> }))
vi.mock('@/components/pipeline/pipeline-tabs', () => ({
  PipelineTabs: () => <div data-testid="pipeline-tabs">pipeline tabs</div>,
}))
vi.mock('@/lib/pipeline/tabs-context', () => ({
  PipelineTabsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@/lib/pipeline/registry', () => ({ setAdvancedMode: vi.fn() }))
vi.mock('@/components/pipeline/custom_blocks/_register', () => ({}))

vi.mock('@/lib/settings/client', () => ({
  getOnboardingCompleted: vi.fn(),
}))

// The dialog itself is covered by onboarding-dialog.test.tsx.
vi.mock('@/components/onboarding-dialog', () => ({
  OnboardingDialog: ({ open, onFinished }: { open: boolean; onFinished: () => void }) => (
    open ? (
      <div role="dialog" aria-label="Welcome to BlockFlow">
        <button type="button" onClick={onFinished}>Skip for now</button>
      </div>
    ) : null
  ),
}))

global.fetch = vi.fn().mockResolvedValue({ json: async () => ({ advanced: false }) }) as unknown as typeof fetch

import { getOnboardingCompleted } from '@/lib/settings/client'
import { AppShell } from '../app-shell'

describe('AppShell first-start onboarding', () => {
  beforeEach(() => {
    pathname = '/generate'
    vi.mocked(getOnboardingCompleted).mockReset().mockResolvedValue(false)
  })

  test('shows onboarding when it has not been completed', async () => {
    render(<AppShell><div>child page</div></AppShell>)
    expect(await screen.findByRole('dialog', { name: /welcome to blockflow/i })).toBeInTheDocument()
    expect(screen.getByTestId('pipeline-tabs')).toBeInTheDocument()
  })

  test('shows onboarding on other routes too (first start may land anywhere)', async () => {
    pathname = '/settings'
    render(<AppShell><div>settings page</div></AppShell>)
    expect(await screen.findByRole('dialog', { name: /welcome to blockflow/i })).toBeInTheDocument()
    expect(screen.getByText('settings page')).toBeInTheDocument()
  })

  test('does not show onboarding once completed', async () => {
    vi.mocked(getOnboardingCompleted).mockResolvedValue(true)
    render(<AppShell><div>child page</div></AppShell>)
    await waitFor(() => expect(getOnboardingCompleted).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('does not show onboarding when the pref cannot be read', async () => {
    vi.mocked(getOnboardingCompleted).mockRejectedValue(new Error('backend down'))
    render(<AppShell><div>child page</div></AppShell>)
    await waitFor(() => expect(getOnboardingCompleted).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('pipeline-tabs')).toBeInTheDocument()
  })

  test('finishing onboarding closes it and the shell keeps working', async () => {
    const user = userEvent.setup()
    render(<AppShell><div>child page</div></AppShell>)
    await user.click(await screen.findByRole('button', { name: /skip for now/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByTestId('pipeline-tabs')).toBeInTheDocument()
  })
})
