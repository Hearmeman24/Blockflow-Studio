/**
 * Which status shows a block's status message, and where: in the badge while
 * running or after completing (an iterator's item count), as a note in the
 * block body while idle (a reload's interrupted run). An error shows its text
 * in the body instead; skipped and cancelled blocks show their label only.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BLOCK_STATUSES } from '@/lib/status'
import { BlockStatusBadge, blockStatusDisplay } from './block-status-badge'

describe('blockStatusDisplay', () => {
  it('without a message, every status shows its label and no note', () => {
    const labels = Object.fromEntries(BLOCK_STATUSES.map((s) => [s, blockStatusDisplay(s, undefined)]))
    expect(labels).toEqual({
      idle: { label: 'Idle', note: null },
      running: { label: 'Running', note: null },
      completed: { label: 'Done', note: null },
      error: { label: 'Error', note: null },
      skipped: { label: 'Skipped', note: null },
      cancelled: { label: 'Cancelled', note: null },
    })
  })

  it('shows the message in the badge while running or after completing', () => {
    expect(blockStatusDisplay('running', 'Writing the prompt…')).toEqual({ label: 'Writing the prompt…', note: null })
    expect(blockStatusDisplay('completed', '2/3 items completed')).toEqual({ label: '2/3 items completed', note: null })
  })

  it('shows the message as a note while idle', () => {
    expect(blockStatusDisplay('idle', 'Run tracking was interrupted.')).toEqual({ label: 'Idle', note: 'Run tracking was interrupted.' })
  })

  it('does not show a message on an error, skipped or cancelled block', () => {
    for (const status of ['error', 'skipped', 'cancelled'] as const) {
      expect(blockStatusDisplay(status, 'Pipeline cancelled').note).toBeNull()
      expect(blockStatusDisplay(status, 'Pipeline cancelled').label).not.toBe('Pipeline cancelled')
    }
  })

  it('an empty message counts as none', () => {
    expect(blockStatusDisplay('running', '')).toEqual({ label: 'Running', note: null })
    expect(blockStatusDisplay('idle', '')).toEqual({ label: 'Idle', note: null })
  })
})

describe('BlockStatusBadge', () => {
  it('pulses only while running, and a cancelled block is neutral', () => {
    const { rerender } = render(<BlockStatusBadge status="running" />)
    expect(screen.getByTestId('block-status-badge').className).toContain('animate-pulse')
    rerender(<BlockStatusBadge status="cancelled" />)
    const badge = screen.getByTestId('block-status-badge')
    expect(badge.textContent).toBe('Cancelled')
    expect(badge.className).not.toContain('animate-pulse')
    expect(badge.className).toContain('text-muted-foreground')
    expect(badge.dataset.status).toBe('cancelled')
  })
})
