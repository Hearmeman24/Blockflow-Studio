/**
 * The add-block menu opens from a "+" button anywhere on the canvas. When it
 * opens upward from the middle of the screen it must fit the space above, so
 * its search field is never cut off by the window edge: the height is capped
 * by the space Radix reports, with a little padding from the edge.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'

const seen = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }))
vi.mock('@/components/ui/dropdown-menu', async (orig) => {
  const actual = await orig<typeof import('@/components/ui/dropdown-menu')>()
  return {
    ...actual,
    DropdownMenuContent: (props: ComponentProps<typeof actual.DropdownMenuContent>) => {
      seen.props = props as Record<string, unknown>
      return <actual.DropdownMenuContent {...props} />
    },
  }
})

import '@/components/pipeline/custom_blocks/_register'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { getStarterTypes } from '@/lib/pipeline/registry'
import { BlockPickerMenuContent } from '../block-picker-menu'

describe('BlockPickerMenuContent height', () => {
  it('caps its height by the available space and keeps a gap from the window edge', async () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>+</DropdownMenuTrigger>
        <BlockPickerMenuContent validTypes={getStarterTypes()} onSelect={() => {}} />
      </DropdownMenu>,
    )
    expect(await screen.findByRole('textbox', { name: 'Search blocks' })).toBeInTheDocument()
    const content = document.querySelector('[data-slot="dropdown-menu-content"]')!
    const classes = (content.getAttribute('class') ?? '').split(/\s+/)
    const maxH = classes.filter((c) => c.startsWith('max-h-'))
    // One max-height, and it includes the space Radix measured on the open side.
    expect(maxH).toHaveLength(1)
    expect(maxH[0]).toContain('var(--radix-dropdown-menu-content-available-height)')
    expect(maxH[0]).toContain('560px')
    expect(seen.props?.collisionPadding).toBeGreaterThanOrEqual(8)
    // The search field stays pinned at the top while the list scrolls.
    expect(classes).toContain('overflow-y-auto')
  })
})
