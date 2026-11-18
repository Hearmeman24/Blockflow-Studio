'use client'

/**
 * The Artifacts toolbar: prompt search on the left; on the right the active
 * filters as small removable chips and one Filters button. The button opens a
 * menu of checkboxes (Source, Type, Character, Show) that apply at once and stays open
 * while toggling. On phones the chips wrap onto their own line below.
 */
import { useId, useState } from 'react'
import { ListFilter, Search, User, X } from 'lucide-react'
import { ChipTooltip } from '@/components/chip-tooltip'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DEFAULT_FILTERS, KINDS, KIND_LABELS, SOURCES, SOURCE_LABELS, activeFilters, removeFilter, toggleFilter,
  type ArtifactFilters, type FilterToggle,
} from '@/lib/artifacts/filters'
import { useCharacters, defaultFace } from '@/lib/characters/use-characters'
import type { Character } from '@/lib/characters/types'

export interface ArtifactsToolbarProps {
  search: string
  onSearchChange: (search: string) => void
  filters: ArtifactFilters
  onFiltersChange: (filters: ArtifactFilters) => void
}

/** A small round avatar: the character's default face, or a person icon. */
function Avatar({ character }: { character: Character | undefined }) {
  const face = character ? defaultFace(character) : null
  return face
    // A local /outputs file; next/image cannot optimise it.
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={face.local} alt="" aria-hidden className="size-4 shrink-0 rounded-full object-cover" />
    : <User aria-hidden className="text-muted-foreground size-4 shrink-0 rounded-full" />
}

function CheckRow({ label, checked, onToggle, icon }: { label: string; checked: boolean; onToggle: () => void; icon?: React.ReactNode }) {
  const id = useId()
  return (
    <div className="hover:bg-accent/60 flex items-center gap-2 rounded-md px-2">
      <Checkbox id={id} checked={checked} onCheckedChange={onToggle} />
      <Label htmlFor={id} className="flex flex-1 cursor-pointer items-center gap-2 py-1.5 text-xs font-normal">
        {icon}
        <span className="min-w-0 truncate">{label}</span>
      </Label>
    </div>
  )
}

function Group({ legend, children }: { legend: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-0.5">
      <legend className="text-muted-foreground mb-1 px-2 text-2xs font-medium uppercase tracking-wide">{legend}</legend>
      {children}
    </fieldset>
  )
}

export function ArtifactsToolbar({ search, onSearchChange, filters, onFiltersChange }: ArtifactsToolbarProps) {
  const [open, setOpen] = useState(false)
  const { characters, isLoading: charactersLoading, error: charactersError } = useCharacters()
  const byId = new Map((characters ?? []).map((c) => [c.id, c]))
  // Until the list is known, an id is just "a character": only a loaded list can call it deleted.
  const listKnown = characters !== undefined && !charactersLoading && !charactersError
  const active = activeFilters(filters).map((a) => {
    if (a.toggle.group !== 'characters') return a
    const c = byId.get(a.toggle.value)
    return { ...a, label: c ? c.name : listKnown ? 'Deleted character' : 'Character' }
  })
  const count = active.length
  const toggle = (change: FilterToggle) => onFiltersChange(toggleFilter(filters, change))

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 sm:max-w-sm">
        <Search aria-hidden className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2" />
        <Input
          type="search"
          aria-label="Search prompts"
          placeholder="Search prompts"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="h-8 pl-8 pr-8 text-xs [&::-webkit-search-cancel-button]:hidden"
        />
        {search && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Clear search"
            onClick={() => onSearchChange('')}
            className="text-muted-foreground absolute right-1 top-1/2 -translate-y-1/2"
          >
            <X aria-hidden />
          </Button>
        )}
      </div>

      {/* Beside the Filters button from small screens up; on phones on their own line below. */}
      {count > 0 && (
        <ul aria-label="Active filters" className="order-last flex w-full flex-wrap items-center gap-1.5 sm:order-none sm:ml-auto sm:w-auto sm:justify-end">
          {active.map((a) => <FilterChip key={a.key} label={a.label} avatar={a.toggle.group === 'characters' && byId.has(a.toggle.value) ? <Avatar character={byId.get(a.toggle.value)} /> : undefined} onRemove={() => onFiltersChange(removeFilter(filters, a))} />)}
        </ul>
      )}
      <div className={count > 0 ? 'flex items-center' : 'flex items-center sm:ml-auto'}>
        <Popover open={open} onOpenChange={setOpen}>
          <ChipTooltip tip="Filters" suppressed={open}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={count > 0 ? `Filters, ${count} active` : 'Filters'}
                className="relative h-8 gap-1.5 px-2.5"
              >
                <ListFilter aria-hidden className="size-3.5" />
                {count > 0 && (
                  <span data-testid="filters-count" aria-hidden className="bg-primary text-primary-foreground rounded-full px-1.5 text-3xs font-semibold tabular-nums leading-4">
                    {count}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
          </ChipTooltip>
          <PopoverContent align="end" aria-label="Filters" className="w-56 space-y-3 p-2">
            <Group legend="Source">
              {SOURCES.map((v) => (
                <CheckRow key={v} label={SOURCE_LABELS[v]} checked={filters.sources.includes(v)} onToggle={() => toggle({ group: 'sources', value: v })} />
              ))}
            </Group>
            <Group legend="Type">
              {KINDS.map((v) => (
                <CheckRow key={v} label={KIND_LABELS[v]} checked={filters.kinds.includes(v)} onToggle={() => toggle({ group: 'kinds', value: v })} />
              ))}
            </Group>
            {characters && characters.length > 0 && (
              <Group legend="Character">
                {characters.map((c) => (
                  <CheckRow key={c.id} label={c.name} icon={<Avatar character={c} />} checked={filters.characters.includes(c.id)} onToggle={() => toggle({ group: 'characters', value: c.id })} />
                ))}
              </Group>
            )}
            <Group legend="Show">
              <CheckRow label="Favorites only" checked={filters.favorites} onToggle={() => toggle({ group: 'favorites' })} />
              <CheckRow label="Hide runs without output" checked={filters.hidePartial} onToggle={() => toggle({ group: 'hidePartial' })} />
            </Group>
            <div className="border-border/60 flex justify-end border-t pt-2">
              <Button type="button" variant="link" size="sm" className="h-7 px-2 text-xs" disabled={count === 0} onClick={() => onFiltersChange(DEFAULT_FILTERS)}>
                Clear all
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

    </div>
  )
}

function FilterChip({ label, avatar, onRemove }: { label: string; avatar?: React.ReactNode; onRemove: () => void }) {
  return (
    <li className="border-border/70 bg-muted/40 inline-flex h-7 items-center gap-1 rounded-full border pl-2.5 pr-0.5 text-xs">
      {avatar}
      {label}
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove filter ${label}`} onClick={onRemove} className="text-muted-foreground size-6 rounded-full">
        <X aria-hidden />
      </Button>
    </li>
  )
}
