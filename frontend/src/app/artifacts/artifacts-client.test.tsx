/**
 * The Artifacts page keeps clear of the floating side nav: centred at 80 % of
 * the window from tablet width up (10 % free each side), and on phones the
 * normal right gutter with a left inset that clears the nav.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/components/run-history', () => ({ RunHistory: () => <p>history</p> }))

import { ArtifactsClient } from './artifacts-client'
import { SIDE_NAV_CLEARANCE } from '@/components/sidebar'
import { CREDITS_PANEL_CLEARANCE } from '@/components/credits-panel'

const src = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8')

describe('Artifacts page width', () => {
  it('is centred at 80 % of the window from tablet width up', () => {
    render(<ArtifactsClient />)
    const main = screen.getByRole('main')
    expect(main).toContainElement(screen.getByText('history'))
    for (const c of ['md:mx-auto', 'md:w-4/5', 'md:px-0']) expect(main.className.split(' ')).toContain(c)
  })

  it('on phones keeps the normal right gutter and clears the side nav on the left', () => {
    render(<ArtifactsClient />)
    const classes = screen.getByRole('main').className.split(' ')
    expect(classes).toContain('pr-4')
    expect(classes).toContain(SIDE_NAV_CLEARANCE)
  })

  it('takes its left inset from the side nav, which documents it next to its own size', () => {
    expect(SIDE_NAV_CLEARANCE).toBe('pl-20')
    const sidebar = src('components/sidebar.tsx')
    // If the nav moves or grows, SIDE_NAV_CLEARANCE has to follow (see its comment).
    expect(sidebar).toMatch(/fixed left-4 /)
    expect(sidebar).toMatch(/size-9/)
    expect(sidebar).toMatch(/p-1\.5/)
  })

  it('starts below the credits pill, which drops under the top bar on phones', () => {
    render(<ArtifactsClient />)
    const classes = screen.getByRole('main').className.split(' ')
    for (const c of CREDITS_PANEL_CLEARANCE.split(' ')) expect(classes).toContain(c)
    expect(CREDITS_PANEL_CLEARANCE).toBe('pt-28 xl:pt-20')
    expect(classes).not.toContain('pt-20')
    expect(src('components/credits-panel.tsx')).toMatch(/fixed right-4 top-16 z-40 xl:top-4/)
  })
})
