'use client'

import { useMemo, useState } from 'react'
import { SearchIcon, StarIcon } from 'lucide-react'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { blockRoleStyle } from '@/lib/pipeline/block-role'
import type { BlockSuggestionContext } from '@/lib/pipeline/block-suggestions'
import type { NodeTypeDef } from '@/lib/pipeline/registry'
import { cn } from '@/lib/utils'
import { getBlockPickerGroups, type BlockPickerGroup } from './block-picker-groups'
import { BlockRoleTile } from './block-role-tile'

interface BlockPickerMenuContentProps {
  validTypes: NodeTypeDef[]
  onSelect: (type: string) => void
  upstreamType?: string
  suggestionContext?: BlockSuggestionContext
}

/** Section header: a role section in its role colour and icon; Suggested stays neutral. */
function GroupLabel({ group }: { group: BlockPickerGroup }) {
  const style = group.key === 'suggested' ? null : blockRoleStyle(group.key)
  const Icon = style?.icon ?? StarIcon
  return (
    <div
      data-testid="block-picker-group-label"
      data-role={group.key === 'suggested' ? undefined : group.key}
      className={cn(
        'flex items-center gap-1.5 px-2 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wide',
        style ? style.heading : 'text-muted-foreground',
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      <span>{group.label}</span>
    </div>
  )
}

export function BlockPickerMenuContent({
  validTypes,
  onSelect,
  upstreamType,
  suggestionContext,
}: BlockPickerMenuContentProps) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const filteredTypes = useMemo(() => {
    if (!normalizedQuery) return validTypes
    return validTypes.filter((def) => {
      const haystack = `${def.label} ${def.description} ${def.type}`.toLowerCase()
      return haystack.includes(normalizedQuery)
    })
  }, [normalizedQuery, validTypes])
  const context = suggestionContext ?? (upstreamType ? { kind: 'upstream' as const, upstreamType } : undefined)
  const groups = getBlockPickerGroups(filteredTypes, context)

  return (
    <DropdownMenuContent
      align="start"
      // Opening upward from mid-screen, the menu must fit the space above the
      // "+" button: cap it by the height Radix measured on that side (minus
      // the padding), so the search field at the top is never cut off.
      collisionPadding={8}
      className="w-[min(440px,calc(100vw-2rem))] max-h-[min(70vh,560px,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto p-1.5"
    >
      <div className="sticky top-0 z-10 bg-popover pb-1">
        <div className="flex items-center gap-2 rounded-md border border-border/70 bg-background/70 px-2.5 py-1.5">
          <SearchIcon className="size-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete') {
                event.stopPropagation()
              }
            }}
            autoFocus
            aria-label="Search blocks"
            placeholder="Search blocks..."
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
      {groups.length === 0 && (
        <div className="px-2 py-6 text-center text-xs text-muted-foreground">
          No blocks match.
        </div>
      )}
      {groups.map((group, index) => (
        <div key={group.key}>
          {index > 0 && <DropdownMenuSeparator className="my-1.5" />}
          <GroupLabel group={group} />
          <div className="space-y-0.5">
            {group.items.map(({ def, role }) => (
              <DropdownMenuItem
                key={def.type}
                data-role={role}
                onClick={() => onSelect(def.type)}
                className="items-start gap-2.5 rounded-md px-2 py-1.5"
              >
                <BlockRoleTile role={role} className="mt-0.5 size-7" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium leading-tight">{def.label}</div>
                  <div className="mt-0.5 line-clamp-2 whitespace-normal break-words text-xs leading-snug text-muted-foreground">
                    {def.description}
                  </div>
                </div>
              </DropdownMenuItem>
            ))}
          </div>
        </div>
      ))}
    </DropdownMenuContent>
  )
}
