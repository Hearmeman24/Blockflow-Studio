/**
 * Tests for the SettingsLayout component.
 *
 * SettingsLayout is the presentational shell of the /settings page:
 *   - Left in-page sidebar with 4 tab links (API keys, Storage, App, Keyboard)
 *   - Main content area renders whichever tab is active
 *   - Tab list is fixed; the page above this component controls which is active
 *
 * Tab content is tested with each tab; this file covers the shell and tab
 * navigation only.
 */
import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { SettingsLayout, SETTINGS_TABS, type SettingsTabId } from '../layout'

describe('SettingsLayout', () => {
  test('renders all four tab labels in the sidebar', () => {
    render(
      <SettingsLayout activeTab="credentials" onTabChange={() => {}}>
        <div>placeholder</div>
      </SettingsLayout>,
    )

    expect(screen.getByRole('button', { name: /api keys/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /storage/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^app/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /keyboard/i })).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(4)
  })

  test('marks the active tab visually distinct from the others', () => {
    render(
      <SettingsLayout activeTab="storage" onTabChange={() => {}}>
        <div>content</div>
      </SettingsLayout>,
    )

    const storage = screen.getByRole('button', { name: /storage/i })
    const credentials = screen.getByRole('button', { name: /api keys/i })

    // The active tab has aria-current="page" — the only marker the test should
    // depend on (visual styling is allowed to change without breaking tests).
    expect(storage).toHaveAttribute('aria-current', 'page')
    expect(credentials).not.toHaveAttribute('aria-current')
  })

  test('renders children in the main content area', () => {
    render(
      <SettingsLayout activeTab="app" onTabChange={() => {}}>
        <div data-testid="content">my tab body</div>
      </SettingsLayout>,
    )

    expect(screen.getByTestId('content')).toBeInTheDocument()
    expect(screen.getByText('my tab body')).toBeInTheDocument()
  })

  test('clicking a tab calls onTabChange with that tab id', async () => {
    const user = userEvent.setup()
    const onTabChange = vi.fn()
    render(
      <SettingsLayout activeTab="credentials" onTabChange={onTabChange}>
        <div />
      </SettingsLayout>,
    )

    await user.click(screen.getByRole('button', { name: /keyboard/i }))
    expect(onTabChange).toHaveBeenCalledWith('keyboard')

    await user.click(screen.getByRole('button', { name: /storage/i }))
    expect(onTabChange).toHaveBeenLastCalledWith('storage')
  })

  test('clicking the currently-active tab is a no-op (does not re-call onTabChange)', async () => {
    const user = userEvent.setup()
    const onTabChange = vi.fn()
    render(
      <SettingsLayout activeTab="credentials" onTabChange={onTabChange}>
        <div />
      </SettingsLayout>,
    )

    await user.click(screen.getByRole('button', { name: /api keys/i }))
    expect(onTabChange).not.toHaveBeenCalled()
  })

  test('SETTINGS_TABS export lists the tabs in the expected order', () => {
    // The page above this component reads SETTINGS_TABS for URL-state plumbing,
    // so its shape + order is part of the contract.
    const ids = SETTINGS_TABS.map((t) => t.id)
    expect(ids).toEqual([
      'credentials',
      'storage',
      'app',
      'keyboard',
    ] satisfies SettingsTabId[])
  })

  test('renders the page heading "Settings" via PageHeader', () => {
    render(
      <SettingsLayout activeTab="credentials" onTabChange={() => {}}>
        <div />
      </SettingsLayout>,
    )
    // PageHeader renders an <h1> with the title text.
    const heading = screen.getByRole('heading', { name: /^settings$/i, level: 1 })
    expect(heading).toBeInTheDocument()
    // PageHeader wraps the heading in a <header> element.
    expect(heading.closest('header')).toBeInTheDocument()
  })

  test('uses max-w-4xl container class (standard form width)', () => {
    const { container } = render(
      <SettingsLayout activeTab="credentials" onTabChange={() => {}}>
        <div />
      </SettingsLayout>,
    )
    const outerDiv = container.firstChild as HTMLElement
    expect(outerDiv.className).toContain('max-w-4xl')
    expect(outerDiv.className).not.toContain('max-w-5xl')
  })

  test('two-column layout: aside nav and content section both render', () => {
    render(
      <SettingsLayout activeTab="credentials" onTabChange={() => {}}>
        <div data-testid="tab-content">content</div>
      </SettingsLayout>,
    )
    expect(screen.getByRole('navigation', { name: /settings sections/i })).toBeInTheDocument()
    expect(screen.getByTestId('tab-content')).toBeInTheDocument()
  })
})
