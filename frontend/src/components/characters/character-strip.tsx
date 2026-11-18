'use client'

/**
 * The row of characters at the top of the page: one round portrait per
 * character with its name under it, in creation order, scrolling sideways
 * when long. The last item is the dashed New button that opens the wizard.
 */
import { useId } from 'react'
import { Plus, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { MediaThumb } from '@/components/byok/media-thumb'
import { kindAccent } from '@/lib/byok/kind-accent'
import { defaultFace } from '@/lib/characters/use-characters'
import type { Character } from '@/lib/characters/types'
import { cn } from '@/lib/utils'

const ITEM = 'flex w-20 shrink-0 flex-col items-center gap-1.5'
const CIRCLE = 'size-16 rounded-full'

export function CharacterStrip({ characters, selectedId, onSelect, onNew }: {
  characters: readonly Character[]
  selectedId: string | null
  onSelect: (id: string) => void
  onNew: () => void
}) {
  return (
    <nav aria-label="Characters" className="-mx-4 overflow-x-auto px-4 pt-1 pb-2">
      <ul className="flex w-max gap-3">
        {characters.map((c) => (
          <li key={c.id}>
            <StripItem character={c} selected={c.id === selectedId} onSelect={() => onSelect(c.id)} />
          </li>
        ))}
        <li>
          <div className={ITEM}>
            <Button
              type="button"
              variant="outline"
              aria-label="New character"
              onClick={onNew}
              className={cn(CIRCLE, 'text-muted-foreground border-2 border-dashed bg-transparent p-0 dark:bg-transparent')}
            >
              <Plus aria-hidden className="size-6" />
            </Button>
            <span aria-hidden className="text-muted-foreground text-xs">New</span>
          </div>
        </li>
      </ul>
    </nav>
  )
}

function StripItem({ character, selected, onSelect }: { character: Character; selected: boolean; onSelect: () => void }) {
  const markerId = useId()
  const face = defaultFace(character)
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={character.name}
      aria-current={selected ? 'true' : undefined}
      aria-describedby={face ? undefined : markerId}
      onClick={onSelect}
      className={cn(ITEM, 'group h-auto rounded-xl p-1 font-normal whitespace-normal hover:bg-transparent dark:hover:bg-transparent')}
    >
      <span
        data-testid="strip-portrait"
        className={cn(
          CIRCLE,
          'relative block overflow-hidden ring-offset-background transition-shadow motion-reduce:transition-none',
          face ? 'bg-muted' : cn('border', kindAccent('image').tile),
          selected ? 'ring-primary ring-2 ring-offset-2' : 'ring-1 ring-border/60 group-hover:ring-ring/70',
        )}
      >
        <MediaThumb
          kind="image"
          src={face?.local}
          label={character.name}
          placeholder={<User data-testid="avatar-placeholder" className="text-muted-foreground size-7" strokeWidth={1.5} />}
        />
      </span>
      <span className={cn('block w-full truncate text-center text-xs', selected ? 'text-foreground font-medium' : 'text-muted-foreground')} title={character.name}>
        {character.name}
      </span>
      {!face && (
        <span id={markerId} className="text-warning -mt-1 block text-3xs font-medium">Needs a face</span>
      )}
    </Button>
  )
}

export function CharacterStripSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="flex gap-3 pt-1 pb-2" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={ITEM}>
          <Skeleton data-testid="strip-skeleton" className={CIRCLE} />
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  )
}
