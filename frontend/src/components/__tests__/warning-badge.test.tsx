import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WarningBadge } from '../warning-badge'

const one = [{ id: 'out', message: 'No output block. Add a Video Viewer after this block to see the result.', action: { label: 'Add Video Viewer', onClick: vi.fn() } }]

describe('WarningBadge', () => {
  it('renders nothing without warnings', () => {
    const { container } = render(<WarningBadge warnings={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('has an icon, warning tokens and an accessible name with the first warning', () => {
    render(<WarningBadge warnings={one} />)
    const badge = screen.getByRole('button', { name: '1 warning: No output block' })
    expect(badge.querySelector('svg')).not.toBeNull()
    expect(badge.className).toMatch(/text-warning/)
    expect(badge.className).toMatch(/border-warning/)
    expect(badge.className).toMatch(/hover:/)
    expect(badge.className).toMatch(/focus-visible:/)
    expect(badge).not.toHaveTextContent('1')
  })

  it('shows a count when there is more than one', () => {
    render(<WarningBadge warnings={[...one, { id: 'b', message: 'Second thing.' }]} />)
    const badge = screen.getByRole('button', { name: '2 warnings: No output block' })
    expect(badge).toHaveTextContent('2')
  })

  it('opens on hover and on keyboard focus, listing each warning', async () => {
    render(<WarningBadge warnings={[...one, { id: 'b', message: 'Second thing.' }]} />)
    fireEvent.pointerEnter(screen.getByRole('button', { name: /warnings/ }))
    expect(await screen.findByText('Second thing.')).toBeInTheDocument()
    expect(screen.getByText(/No output block\. Add a Video Viewer/)).toBeInTheDocument()
  })

  it('does not reopen when focus returns to it after closing, by click or by Escape', async () => {
    const user = userEvent.setup()
    render(<WarningBadge warnings={one} />)
    const badge = screen.getByRole('button', { name: '1 warning: No output block' })
    await user.click(badge)
    expect(await screen.findByRole('button', { name: 'Add Video Viewer' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole('button', { name: 'Add Video Viewer' })).toBeNull()
    // A pointer focus (click elsewhere then back) is not a hover or keyboard request either.
    fireEvent.pointerDown(badge)
    fireEvent.focus(badge)
    expect(screen.queryByRole('button', { name: 'Add Video Viewer' })).toBeNull()
  })

  it('runs the action from the keyboard and closes on Escape', async () => {
    const user = userEvent.setup()
    const action = vi.fn()
    render(<WarningBadge warnings={[{ ...one[0], action: { label: 'Add Video Viewer', onClick: action } }]} />)
    await user.tab()
    expect(screen.getByRole('button', { name: '1 warning: No output block' })).toHaveFocus()
    await user.keyboard('{Enter}')
    const button = await screen.findByRole('button', { name: 'Add Video Viewer' })
    expect(button).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(action).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: '1 warning: No output block' }))
    expect(await screen.findByRole('button', { name: 'Add Video Viewer' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('button', { name: 'Add Video Viewer' })).toBeNull()
  })
})
