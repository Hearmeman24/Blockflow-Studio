'use client'

import { useId, useMemo, useState, type KeyboardEvent } from 'react'
import { BookOpen, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { DeleteIconButton } from '@/components/delete-icon-button'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import {
  MAX_PROMPT_CONTENT_LENGTH,
  MAX_PROMPT_NAME_LENGTH,
  PROMPT_TYPE_LABELS,
  promptsOfType,
  type PromptType,
  type SavedPrompt,
} from '@/lib/prompt-library/api'
import { usePromptLibrary } from '@/lib/prompt-library/use-prompt-library'
import { cn } from '@/lib/utils'

/** Above this many saved prompts of a type, the list gets a search field. */
export const SEARCH_THRESHOLD = 5

export interface PromptLibraryButtonProps {
  type: PromptType
  /** The prompt box's current text: what "Save current prompt" saves. */
  value: string
  /** Replace the prompt box's text (a saved prompt, or the previous text on Undo). */
  onChange: (text: string) => void
  className?: string
}

/**
 * The book button next to a prompt box's label. It opens the saved prompts of
 * one type: use one (replaces the box, with Undo), delete one, or save the
 * box's text under a name. The same component serves all three prompt types.
 */
export function PromptLibraryButton({ type, value, onChange, className }: PromptLibraryButtonProps) {
  const [open, setOpen] = useState(false)
  const label = `Saved ${PROMPT_TYPE_LABELS[type].plural}`

  const use = (prompt: SavedPrompt) => {
    const previous = value
    onChange(prompt.content)
    setOpen(false)
    toast(`Used "${prompt.name}"`, {
      description: 'It replaced the text in the box.',
      action: { label: 'Undo', onClick: () => onChange(previous) },
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          title={label}
          className={cn('text-muted-foreground hover:text-foreground size-5 [&_svg]:size-3.5', className)}
        >
          <BookOpen aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={label}
        // The canvas pans and zooms on drag and wheel; these classes exclude the popover.
        className="panningDisabled wheelDisabled w-80 space-y-2 p-2"
        // Keys typed here belong to the popover, not to the block or canvas shortcuts.
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key !== 'Escape') e.stopPropagation()
        }}
      >
        {open && <LibraryPanel type={type} value={value} onUse={use} />}
      </PopoverContent>
    </Popover>
  )
}

function LibraryPanel({ type, value, onUse }: { type: PromptType; value: string; onUse: (prompt: SavedPrompt) => void }) {
  const library = usePromptLibrary()
  const nouns = PROMPT_TYPE_LABELS[type]
  const saved = useMemo(() => promptsOfType(library.prompts, type), [library.prompts, type])

  return (
    <>
      <p className="text-2xs font-medium">Saved {nouns.plural}</p>
      {library.isLoading && (
        <div aria-busy="true" aria-label="Loading saved prompts" className="space-y-1.5">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      )}
      {!library.isLoading && library.error && !library.prompts && (
        <div className="space-y-1.5">
          <p className="text-destructive text-2xs">{library.error.message}</p>
          <Button type="button" variant="outline" size="xs" onClick={library.retry}>
            <RefreshCw aria-hidden />Retry
          </Button>
        </div>
      )}
      {library.prompts && saved.length === 0 && (
        <EmptyState
          className="gap-1 py-3"
          title={`No saved ${nouns.plural} yet`}
          description="Write a prompt in the box, name it below and press Save."
        />
      )}
      {library.prompts && saved.length > 0 && (
        <SavedList type={type} prompts={saved} onUse={onUse} onDelete={library.remove} />
      )}
      <SaveForm type={type} value={value} onSave={library.save} />
    </>
  )
}

function SavedList({ type, prompts, onUse, onDelete }: {
  type: PromptType
  prompts: SavedPrompt[]
  onUse: (prompt: SavedPrompt) => void
  onDelete: (id: string) => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const needle = query.trim().toLocaleLowerCase()
  const shown = needle
    ? prompts.filter((p) => `${p.name}\n${p.content}`.toLocaleLowerCase().includes(needle))
    : prompts

  const confirmDelete = async (id: string) => {
    setDeleting(true)
    setDeleteError(null)
    try {
      await onDelete(id)
      setConfirming(null)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Could not delete the prompt.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-1.5">
      {prompts.length > SEARCH_THRESHOLD && (
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={`Search saved ${PROMPT_TYPE_LABELS[type].plural}`}
          placeholder="Search by name or text"
          className="h-7 text-xs"
        />
      )}
      {shown.length === 0 && <p className="text-muted-foreground text-2xs">No saved prompt matches.</p>}
      <ul className="max-h-60 space-y-0.5 overflow-y-auto">
        {shown.map((prompt) => (
          <li key={prompt.id}>
            {confirming === prompt.id ? (
              <div className="bg-muted/50 space-y-1 rounded-md p-1.5">
                <p className="text-2xs">Delete &quot;{prompt.name}&quot;?</p>
                {deleteError && <p role="alert" className="text-destructive text-3xs">{deleteError}</p>}
                <div className="flex justify-end gap-1">
                  <Button type="button" variant="ghost" size="xs" onClick={() => { setConfirming(null); setDeleteError(null) }}>
                    Cancel
                  </Button>
                  <Button type="button" variant="destructive" size="xs" disabled={deleting} onClick={() => void confirmDelete(prompt.id)}>
                    Delete
                  </Button>
                </div>
              </div>
            ) : (
              <div className="hover:bg-accent/60 flex min-w-0 items-start gap-1 rounded-md">
                <button
                  type="button"
                  aria-label={`Use ${prompt.name}`}
                  onClick={() => onUse(prompt)}
                  className="focus-visible:ring-ring min-w-0 flex-1 rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-1"
                >
                  <span className="block truncate text-xs font-medium">{prompt.name}</span>
                  <span className="text-muted-foreground line-clamp-2 text-3xs break-words whitespace-pre-line">{prompt.content}</span>
                </button>
                <DeleteIconButton
                  label={`Delete ${prompt.name}`}
                  className="size-6 shrink-0"
                  onClick={() => { setConfirming(prompt.id); setDeleteError(null) }}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function SaveForm({ type, value, onSave }: {
  type: PromptType
  value: string
  onSave: (name: string, type: PromptType, content: string) => Promise<SavedPrompt>
}) {
  const nameId = useId()
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const empty = !value.trim()
  const tooLong = value.length > MAX_PROMPT_CONTENT_LENGTH
  const blocked = empty || tooLong
  const canSave = !blocked && Boolean(name.trim()) && !saving

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      const saved = await onSave(name, type, value)
      setName('')
      toast.success(`Saved "${saved.name}"`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the prompt.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-border/70 space-y-1 border-t pt-2">
      <label htmlFor={nameId} className="text-2xs font-medium">Save current prompt</label>
      <div className="flex gap-1">
        <Input
          id={nameId}
          aria-label="Name"
          value={name}
          maxLength={MAX_PROMPT_NAME_LENGTH}
          onChange={(e) => { setName(e.target.value); setError(null) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void save()
            }
          }}
          placeholder="Name"
          className="h-7 text-xs"
        />
        <Button type="button" size="xs" className="h-7" disabled={!canSave} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {empty && <p className="text-muted-foreground text-3xs">Write a prompt in the box first.</p>}
      {tooLong && (
        <p className="text-muted-foreground text-3xs">
          The prompt is longer than {MAX_PROMPT_CONTENT_LENGTH.toLocaleString('en-US')} characters, too long to save.
        </p>
      )}
      {error && <p role="alert" className="text-destructive text-3xs">{error}</p>}
    </div>
  )
}
