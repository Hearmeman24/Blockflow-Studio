'use client'

/**
 * The selected character's header: the 3:4 portrait (a "Drop a face" target
 * when it has none), the name, quiet in-place notes that save themselves,
 * chips with the non-zero facts, Edit (opens the wizard) and Delete.
 */
import { useCallback, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import type { Character, CharacterMediaKind } from '@/lib/characters/types'
import { cn } from '@/lib/utils'
import { CharacterPortrait } from './character-portrait'
import type { CharacterMediaActions } from './media-source'
import { always, QUIET_FIELD, useAutosaveField } from './use-autosave-field'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const COUNTED: [CharacterMediaKind, string, string][] = [
  ['image', 'image', 'images'],
  ['video', 'video', 'videos'],
  ['audio', 'audio clip', 'audio clips'],
]

/** "12 generated", "3 images", "1 video", "2 audio clips": only the non-zero facts. */
export function characterFacts(character: Character, generated: number): string[] {
  const facts: string[] = []
  if (generated > 0) facts.push(`${generated} generated`)
  for (const [kind, one, many] of COUNTED) {
    const n = character.media.filter((m) => m.kind === kind).length
    if (n > 0) facts.push(plural(n, one, many))
  }
  return facts
}

export function CharacterProfile({ character, actions, generated, onEdit, onDelete }: {
  character: Character
  actions: CharacterMediaActions
  /** Runs made with the character, once known. */
  generated: number
  onEdit: () => void
  onDelete: () => Promise<void>
}) {
  const { id } = character
  const { update } = actions
  const saveNotes = useCallback((v: string) => update(id, { description: v }), [update, id])
  const notes = useAutosaveField(character.description, saveNotes, always, 'notes')
  const [confirming, setConfirming] = useState(false)
  const facts = characterFacts(character, generated)

  return (
    <div className="flex min-w-0 flex-col gap-5 sm:flex-row sm:items-start">
      <div className="w-36 shrink-0 sm:w-44">
        <CharacterPortrait character={character} actions={actions} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <h2 className="min-w-0 flex-1 truncate pt-0.5 text-2xl font-semibold tracking-tight" title={character.name}>
            {character.name}
          </h2>
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>
            <Pencil aria-hidden />
            Edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Delete character"
            onClick={() => setConfirming(true)}
            className="text-muted-foreground hover:text-destructive shrink-0"
          >
            <Trash2 aria-hidden />
          </Button>
        </div>

        <Textarea
          aria-label="Notes"
          placeholder="Add notes. Not sent to any model."
          value={notes.value}
          onChange={(e) => notes.change(e.target.value)}
          onBlur={notes.blur}
          rows={2}
          className={cn(QUIET_FIELD, '-ml-2 field-sizing-content max-h-40 min-h-9 max-w-2xl resize-none overflow-y-auto py-1.5 text-sm md:text-sm')}
        />

        {facts.length > 0 && (
          <ul aria-label="Facts" className="flex flex-wrap gap-1.5">
            {facts.map((f) => (
              <li key={f} className="bg-muted text-muted-foreground rounded-full px-2.5 py-0.5 text-2xs">{f}</li>
            ))}
          </ul>
        )}
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Delete "${character.name}"?`}</AlertDialogTitle>
            <AlertDialogDescription>
              Its files are deleted from this computer. Flows that use this character will show it as missing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={() => void onDelete()}>
              Delete character
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export function CharacterProfileSkeleton() {
  return (
    <div data-testid="header-skeleton" className="flex flex-col gap-5 sm:flex-row" aria-hidden>
      <Skeleton className="aspect-[3/4] w-36 rounded-2xl sm:w-44" />
      <div className="flex flex-1 flex-col gap-3 pt-1">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
        <div className="flex gap-1.5">
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      </div>
    </div>
  )
}
