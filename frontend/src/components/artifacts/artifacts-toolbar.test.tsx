/**
 * Artifacts toolbar: search on the left; on the right the active filters as
 * removable chips and one Filters button opening a menu of checkboxes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { ArtifactsToolbar } from './artifacts-toolbar'
import { DEFAULT_FILTERS, type ArtifactFilters } from '@/lib/artifacts/filters'
import { useCharacters } from '@/lib/characters/use-characters'
import type { Character } from '@/lib/characters/types'

vi.mock('@/lib/characters/use-characters', async (orig) => ({
  ...(await orig<typeof import('@/lib/characters/use-characters')>()),
  useCharacters: vi.fn(),
}))

const A = `char_${'a'.repeat(32)}`
const B = `char_${'b'.repeat(32)}`
const GONE = `char_${'c'.repeat(32)}`
const character = (id: string, name: string, over: Partial<Character> = {}): Character => ({
  id, name, description: '', created_at: '', updated_at: '', default_face_id: null, default_audio_id: null, media: [], ...over,
})
const withFace = character(A, 'Mira Ñandú 🌙', {
  default_face_id: 'm1',
  media: [{ id: 'm1', kind: 'image', label: '', local: `/outputs/characters/${A}/face.png`, size_bytes: 1, width: 1, height: 1, duration_s: null, position: 0, created_at: '' }],
})
function mockCharacters(state: { characters?: Character[]; isLoading?: boolean; error?: Error }) {
  vi.mocked(useCharacters).mockReturnValue({ characters: undefined, error: undefined, isLoading: false, ...state } as ReturnType<typeof useCharacters>)
}
beforeEach(() => mockCharacters({ characters: [] }))

function Harness({ initial = DEFAULT_FILTERS, onFilters = vi.fn(), onSearch = vi.fn(), search: initialSearch = '' }: {
  initial?: ArtifactFilters; onFilters?: (f: ArtifactFilters) => void; onSearch?: (s: string) => void; search?: string
}) {
  const [filters, setFilters] = useState(initial)
  const [search, setSearch] = useState(initialSearch)
  return (
    <ArtifactsToolbar
      search={search}
      onSearchChange={(s) => { setSearch(s); onSearch(s) }}
      filters={filters}
      onFiltersChange={(f) => { setFilters(f); onFilters(f) }}
    />
  )
}

const filtersButton = () => screen.getByRole('button', { name: /^Filters/ })

async function openMenu() {
  render(<Harness />)
  const user = userEvent.setup()
  await user.click(filtersButton())
  return { user, menu: await screen.findByRole('dialog', { name: 'Filters' }) }
}

describe('ArtifactsToolbar', () => {
  it('shows only the search field and the Filters button by default', () => {
    render(<Harness />)
    expect(screen.getByRole('searchbox', { name: 'Search prompts' })).toHaveAttribute('placeholder', 'Search prompts')
    expect(screen.getAllByRole('button')).toEqual([filtersButton()])
    expect(filtersButton()).toHaveAccessibleName('Filters')
    expect(screen.queryByTestId('filters-count')).toBeNull()
  })

  it('has a clear button only when the search has text', async () => {
    const onSearch = vi.fn()
    const user = userEvent.setup()
    render(<Harness onSearch={onSearch} />)
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
    await user.type(screen.getByRole('searchbox'), 'fox')
    expect(onSearch).toHaveBeenLastCalledWith('fox')
    await user.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(onSearch).toHaveBeenLastCalledWith('')
    expect(screen.getByRole('searchbox')).toHaveValue('')
  })

  it('opens a menu with labelled groups of checkboxes and a disabled Clear all', async () => {
    const { menu } = await openMenu()
    const group = (name: string) => within(menu).getByRole('group', { name })
    expect(within(group('Source')).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label') ?? c.textContent ?? '')).toHaveLength(2)
    for (const [g, names] of [['Source', ['Pipeline', 'MCP']], ['Type', ['Image', 'Video', 'Other']], ['Show', ['Favorites only', 'Hide runs without output']]] as const) {
      for (const n of names) expect(within(group(g)).getByRole('checkbox', { name: n })).toBeInTheDocument()
    }
    expect(within(menu).getByRole('checkbox', { name: 'Hide runs without output' })).toHaveAttribute('aria-checked', 'true')
    expect(within(menu).getByRole('button', { name: 'Clear all' })).toBeDisabled()
  })

  it('applies a change at once, keeps the menu open, and counts it on the button', async () => {
    const onFilters = vi.fn()
    const user = userEvent.setup()
    render(<Harness onFilters={onFilters} />)
    await user.click(filtersButton())
    const menu = await screen.findByRole('dialog', { name: 'Filters' })
    await user.click(within(menu).getByText('Video'))
    expect(onFilters).toHaveBeenLastCalledWith({ ...DEFAULT_FILTERS, kinds: ['video'] })
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument()
    await user.click(within(menu).getByRole('checkbox', { name: 'MCP' }))
    expect(filtersButton()).toHaveAccessibleName('Filters, 2 active')
    expect(screen.getByTestId('filters-count')).toHaveTextContent('2')
  })

  it('treats all of a group as no filter: no badge, no chips', async () => {
    const { user, menu } = await openMenu()
    await user.click(within(menu).getByRole('checkbox', { name: 'Pipeline' }))
    await user.click(within(menu).getByRole('checkbox', { name: 'MCP' }))
    expect(within(menu).getByRole('checkbox', { name: 'MCP' })).toHaveAttribute('aria-checked', 'true')
    expect(filtersButton()).toHaveAccessibleName('Filters')
    expect(screen.queryByRole('button', { name: /^Remove filter/ })).toBeNull()
  })

  it('shows active filters as chips that each remove one filter', async () => {
    const onFilters = vi.fn()
    const user = userEvent.setup()
    render(<Harness onFilters={onFilters} initial={{ sources: ['mcp'], kinds: ['video'], characters: [], favorites: true, hidePartial: false }} />)
    const chips = screen.getByRole('list', { name: 'Active filters' })
    expect(within(chips).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['MCP', 'Video', 'Favorites', 'Showing runs without output'])
    await user.click(screen.getByRole('button', { name: 'Remove filter Video' }))
    expect(onFilters).toHaveBeenLastCalledWith({ sources: ['mcp'], kinds: [], characters: [], favorites: true, hidePartial: false })
    await user.click(screen.getByRole('button', { name: 'Remove filter Showing runs without output' }))
    expect(onFilters).toHaveBeenLastCalledWith({ sources: ['mcp'], kinds: [], characters: [], favorites: true, hidePartial: true })
    expect(filtersButton()).toHaveAccessibleName('Filters, 2 active')
  })

  it('Clear all goes back to the defaults', async () => {
    const onFilters = vi.fn()
    const user = userEvent.setup()
    render(<Harness onFilters={onFilters} initial={{ sources: ['mcp'], kinds: [], characters: [], favorites: true, hidePartial: false }} />)
    await user.click(filtersButton())
    const menu = await screen.findByRole('dialog', { name: 'Filters' })
    await user.click(within(menu).getByRole('button', { name: 'Clear all' }))
    expect(onFilters).toHaveBeenLastCalledWith(DEFAULT_FILTERS)
    expect(within(menu).getByRole('button', { name: 'Clear all' })).toBeDisabled()
  })

  it('works from the keyboard and returns focus to the button on Escape', async () => {
    const onFilters = vi.fn()
    const user = userEvent.setup()
    render(<Harness onFilters={onFilters} />)
    filtersButton().focus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('dialog', { name: 'Filters' })
    await waitFor(() => expect(within(menu).getByRole('checkbox', { name: 'Pipeline' })).toHaveFocus())
    await user.tab()
    expect(within(menu).getByRole('checkbox', { name: 'MCP' })).toHaveFocus()
    await user.keyboard(' ')
    expect(onFilters).toHaveBeenLastCalledWith({ ...DEFAULT_FILTERS, sources: ['mcp'] })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Filters' })).toBeNull())
    expect(filtersButton()).toHaveFocus()
  })
})

describe('ArtifactsToolbar: Character filter', () => {
  const menuOf = async (initial: ArtifactFilters = DEFAULT_FILTERS) => {
    const user = userEvent.setup()
    render(<Harness initial={initial} />)
    await user.click(filtersButton())
    return { user, menu: await screen.findByRole('dialog', { name: 'Filters' }) }
  }

  it('lists the characters in order with their names (Unicode included) and a face or fallback icon', async () => {
    mockCharacters({ characters: [withFace, character(B, 'Bo')] })
    const { menu } = await menuOf()
    const group = within(menu).getByRole('group', { name: 'Character' })
    expect([...group.querySelectorAll('label')].map((l) => l.textContent)).toEqual(['Mira Ñandú 🌙', 'Bo'])
    expect(within(group).getAllByRole('checkbox')).toHaveLength(2)
    expect(group.querySelector('img')).toHaveAttribute('src', expect.stringContaining(`/outputs/characters/${A}/face.png`))
    expect(group.querySelectorAll('svg.lucide-user')).toHaveLength(1)
  })

  it('is hidden with no characters, while loading and when the list fails, and the rest of the menu works', async () => {
    for (const state of [{ characters: [] }, { isLoading: true }, { error: new Error('down') }]) {
      mockCharacters(state)
      const { unmount } = render(<Harness />)
      const user = userEvent.setup()
      await user.click(filtersButton())
      const menu = await screen.findByRole('dialog', { name: 'Filters' })
      expect(within(menu).queryByRole('group', { name: 'Character' })).toBeNull()
      await user.click(within(menu).getByRole('checkbox', { name: 'MCP' }))
      expect(filtersButton()).toHaveAccessibleName('Filters, 1 active')
      unmount()
    }
  })

  it('ticking and unticking applies at once, counts on the button and makes a chip', async () => {
    mockCharacters({ characters: [withFace, character(B, 'Bo')] })
    const onFilters = vi.fn()
    const user = userEvent.setup()
    render(<Harness onFilters={onFilters} />)
    await user.click(filtersButton())
    const menu = await screen.findByRole('dialog', { name: 'Filters' })
    await user.click(within(menu).getByText('Bo'))
    expect(onFilters).toHaveBeenLastCalledWith({ ...DEFAULT_FILTERS, characters: [B] })
    await user.click(within(menu).getByRole('checkbox', { name: 'Mira Ñandú 🌙' }))
    expect(onFilters).toHaveBeenLastCalledWith({ ...DEFAULT_FILTERS, characters: [B, A] })
    expect(filtersButton()).toHaveAccessibleName('Filters, 2 active')
    const chips = screen.getByRole('list', { name: 'Active filters' })
    expect(within(chips).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Bo', 'Mira Ñandú 🌙'])
    await user.click(within(menu).getByRole('checkbox', { name: 'Bo' }))
    expect(onFilters).toHaveBeenLastCalledWith({ ...DEFAULT_FILTERS, characters: [A] })
  })

  it('removing a character chip updates the filters', async () => {
    mockCharacters({ characters: [withFace, character(B, 'Bo')] })
    const onFilters = vi.fn()
    const user = userEvent.setup()
    render(<Harness onFilters={onFilters} initial={{ ...DEFAULT_FILTERS, characters: [A, B] }} />)
    await user.click(screen.getByRole('button', { name: 'Remove filter Mira Ñandú 🌙' }))
    expect(onFilters).toHaveBeenLastCalledWith({ ...DEFAULT_FILTERS, characters: [B] })
  })

  it('shows an id that matches no character as "Deleted character", removable, and keeps it applied', async () => {
    mockCharacters({ characters: [character(B, 'Bo')] })
    const onFilters = vi.fn()
    const user = userEvent.setup()
    render(<Harness onFilters={onFilters} initial={{ ...DEFAULT_FILTERS, characters: [GONE] }} />)
    expect(filtersButton()).toHaveAccessibleName('Filters, 1 active')
    await user.click(screen.getByRole('button', { name: 'Remove filter Deleted character' }))
    expect(onFilters).toHaveBeenLastCalledWith(DEFAULT_FILTERS)
  })

  it('uses a neutral "Character" label while the list loads or fails, never "Deleted"', () => {
    for (const state of [{ isLoading: true }, { error: new Error('down') }]) {
      mockCharacters(state)
      const { unmount } = render(<Harness initial={{ ...DEFAULT_FILTERS, characters: [A] }} />)
      expect(within(screen.getByRole('list', { name: 'Active filters' })).getByRole('listitem')).toHaveTextContent(/^Character$/)
      expect(screen.queryByText(/Deleted/)).toBeNull()
      unmount()
    }
  })

  it('Clear all drops ticked characters too', async () => {
    mockCharacters({ characters: [character(B, 'Bo')] })
    const onFilters = vi.fn()
    const user = userEvent.setup()
    render(<Harness onFilters={onFilters} initial={{ ...DEFAULT_FILTERS, characters: [B] }} />)
    await user.click(filtersButton())
    await user.click(within(await screen.findByRole('dialog', { name: 'Filters' })).getByRole('button', { name: 'Clear all' }))
    expect(onFilters).toHaveBeenLastCalledWith(DEFAULT_FILTERS)
  })
})
