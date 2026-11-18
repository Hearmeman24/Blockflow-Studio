'use client'

/**
 * One media section of a character (Images, Videos, Audio, or the wizard's
 * mixed "Looks"). A grid of tiles whose last cell is the Add tile (the
 * picker); the whole grid takes dropped files, sorted into the section's
 * kinds by type. Images and videos are 3:4 portrait tiles, audio clips are
 * square sound tiles; the starred clip is the default audio. The files come from a `MediaSource`:
 * staged in memory by the creation wizard, or a saved character. Errors show
 * under the grid they belong to; a refused change (remove, move, star) is a
 * toast.
 */
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { ArrowLeft, ArrowRight, Loader2, Plus, Star, X, XCircle } from 'lucide-react'
import { AlertPanel } from '@/components/alert-panel'
import { ChipTooltip } from '@/components/chip-tooltip'
import { Button } from '@/components/ui/button'
import { KindHeading } from '@/components/byok/kind-heading'
import { DropTarget, REVEAL } from '@/components/byok/media-loader'
import { MediaThumb, useThumbPlayback } from '@/components/byok/media-thumb'
import { SoundTile } from '@/components/byok/sound-tile'
import { kindAccent } from '@/lib/byok/kind-accent'
import { isKindFile } from '@/lib/byok/loader-items'
import { probeMedia } from '@/lib/byok/probe-media'
import { pickFiles } from '@/lib/file-picker'
import type { CharacterMediaKind } from '@/lib/characters/types'
import { cn } from '@/lib/utils'
import type { MediaSource, SourceItem } from './media-source'

export const TITLE: Record<CharacterMediaKind, string> = { image: 'Images', video: 'Videos', audio: 'Audio' }
export const PLURAL: Record<CharacterMediaKind, string> = { image: 'images', video: 'videos', audio: 'audio clips' }
export const ARTICLE: Record<CharacterMediaKind, string> = { image: 'an image', video: 'a video', audio: 'an audio' }
export const ACCEPT: Record<CharacterMediaKind, string> = { image: 'image/*', video: 'video/*', audio: 'audio/*' }

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "an image", "an image or a video". */
function articleFor(kinds: readonly CharacterMediaKind[]): string {
  return [...new Set(kinds.map((k) => ARTICLE[k]))].join(' or ')
}

/** Alt+arrow moves a tile; back = earlier. */
function moveKeys(first: boolean, last: boolean, onMove: (delta: -1 | 1) => void) {
  return (e: KeyboardEvent) => {
    if (!e.altKey) return
    const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft'
    const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight'
    if (!back && !forward) return
    e.preventDefault()
    if (back ? !first : !last) onMove(back ? -1 : 1)
  }
}

interface Pending {
  key: string
  name: string
  kind: CharacterMediaKind
}

let pendingSeq = 0

export interface CharacterMediaSectionProps {
  source: MediaSource
  /** The kinds this grid shows and accepts, in display order. Images and videos may share a grid. */
  kinds: readonly CharacterMediaKind[]
  /** Section name; defaults to the kind's title. */
  title?: string
  /** Accessible name of the Add tile; defaults to "Add <plural>". */
  addLabel?: string
  /** Visible text of the Add tile; defaults to "Add". */
  addText?: string
  /** Muted text beside the heading. */
  hint?: ReactNode
  /** Items shown but not removable or movable here (the face in the wizard's Looks). */
  lockedIds?: readonly string[]
  /** Show the face / default-audio star. */
  stars?: boolean
  /** Hide the heading (the wizard has its own). */
  bare?: boolean
}

export function CharacterMediaSection({ source, kinds, title, addLabel, addText, hint, lockedIds = [], stars = true, bare = false }: CharacterMediaSectionProps) {
  const [pending, setPending] = useState<Pending[]>([])
  const [problems, setProblems] = useState<string[]>([])
  const name = title ?? TITLE[kinds[0]]
  const visual = kinds[0] === 'image' || kinds[0] === 'video'
  const locked = new Set(lockedIds)
  const count = kinds.reduce((n, k) => n + source.items(k).length, 0)

  const kindOf = (f: File) => kinds.find((k) => isKindFile(k, f))

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return
    const accepted = files.flatMap((f) => {
      const kind = kindOf(f)
      return kind ? [{ file: f, kind }] : []
    })
    setProblems(files.filter((f) => !kindOf(f)).map((f) => `${f.name} is not ${articleFor(kinds)} file.`))
    const entries = accepted.map(({ file, kind }) => ({ key: `pending-${++pendingSeq}`, name: file.name, kind }))
    setPending((prev) => [...prev, ...entries])
    // One at a time, so files keep their order and each response holds the ones before it.
    for (const [i, { file, kind }] of accepted.entries()) {
      try {
        const meta = await probeMedia(file, kind)
        await source.add(kind, file, meta)
      } catch (err) {
        setProblems((prev) => [...prev, `${file.name}: ${errorMessage(err)}`])
      } finally {
        setPending((prev) => prev.filter((p) => p.key !== entries[i].key))
      }
    }
  }

  const accept = [...new Set(kinds.map((k) => ACCEPT[k]))].join(',')
  const plural = kinds.map((k) => PLURAL[k]).join(' and ')
  const pick = () => {
    void pickFiles({ slug: `characters-${kinds.join('-')}`, accept, multiple: true, description: plural })
      .then((files) => addFiles(files ?? []))
  }

  const run = (action: string, task: () => Promise<unknown>) => {
    void task().catch((err) => toast.error(`Could not ${action}: ${errorMessage(err)}`))
  }
  const remove = (m: SourceItem) => run(`remove ${m.label}`, () => source.remove(m))
  /** Swap with the next movable neighbour; locked items keep their places. */
  const move = (m: SourceItem, movable: SourceItem[], delta: -1 | 1) => {
    const from = movable.indexOf(m)
    const neighbour = movable[from + delta]
    if (from < 0 || !neighbour) return
    const ids = source.items(m.kind).map((x) => x.id)
    const a = ids.indexOf(m.id)
    const b = ids.indexOf(neighbour.id)
    ;[ids[a], ids[b]] = [ids[b], ids[a]]
    run(`move ${m.label}`, () => source.reorder(m.kind, ids))
  }
  const toggleDefault = (m: SourceItem) => {
    const kind = m.kind as 'image' | 'audio'
    const current = source.defaultId(kind)
    // A character always has a face: pressing the current face keeps it.
    if (kind === 'image' && current === m.id) return
    run('save the default', () => source.setDefault(kind, current === m.id ? null : m.id))
  }

  return (
    <section aria-label={name} data-kind={kinds.join(' ')} className="@container flex min-w-0 flex-col gap-3">
      {!bare && (
        <div className="flex min-w-0 items-center gap-2">
          <KindHeading kind={kinds[0]} title={name} count={count} />
          {hint && <p className="text-muted-foreground min-w-0 truncate text-2xs" title={typeof hint === 'string' ? hint : undefined}>{hint}</p>}
        </div>
      )}

      <DropTarget onFiles={(files) => void addFiles(files)} className="min-w-0">
        {(dragging) => (
          <ol
            aria-label={name}
            className={cn(
              'grid gap-2',
              visual ? 'grid-cols-3 @md:grid-cols-4 @xl:grid-cols-5' : 'grid-cols-2 @sm:grid-cols-3 @lg:grid-cols-4',
            )}
          >
            {kinds.flatMap((kind) => {
              const items = source.items(kind)
              const movable = items.filter((m) => !locked.has(m.id))
              const defaultId = source.defaultId(kind)
              return items.map((m) => {
                const isLocked = locked.has(m.id)
                const index = movable.indexOf(m)
                const first = isLocked || index === 0
                const last = isLocked || index === movable.length - 1
                const isDefault = m.id === defaultId
                const onMove = (d: -1 | 1) => move(m, movable, d)
                return kind === 'image' || kind === 'video' ? (
                  <VisualTile
                    key={m.id}
                    item={m}
                    kind={kind}
                    first={first}
                    last={last}
                    locked={isLocked}
                    isDefault={kind === 'image' && isDefault}
                    removeBlocked={source.removeBlocked(m)}
                    onRemove={() => remove(m)}
                    onMove={onMove}
                    onToggleDefault={kind === 'image' && stars ? () => toggleDefault(m) : undefined}
                  />
                ) : (
                  <li key={m.id} title={m.label} onKeyDown={moveKeys(first, last, onMove)} className="min-w-0">
                    <SoundTile
                      src={m.src}
                      label={m.label}
                      sizeBytes={m.sizeBytes}
                      first={first}
                      last={last}
                      onRemove={() => remove(m)}
                      onMove={onMove}
                      star={stars ? { label: `Use ${m.label} as the default audio`, pressed: isDefault, onToggle: () => toggleDefault(m) } : undefined}
                      badges={isDefault ? <DefaultBadge>Default</DefaultBadge> : undefined}
                      className={cn(isDefault && 'border-warning/50')}
                    />
                  </li>
                )
              })
            })}
            {pending.map((p) => (
              <li
                key={p.key}
                data-testid="upload-pending"
                title={p.name}
                className={cn(
                  'bg-muted relative min-w-0 overflow-hidden rounded-xl ring-1 ring-border/60',
                  visual ? 'aspect-[3/4]' : 'aspect-square',
                )}
              >
                {p.kind === 'image' || p.kind === 'video' ? (
                  <MediaThumb kind={p.kind} label={p.name} saving />
                ) : (
                  <div className="text-muted-foreground flex size-full flex-col items-center justify-center gap-2 p-2">
                    <Loader2 aria-hidden className="size-5 animate-spin motion-reduce:animate-none" />
                    <span className="w-full truncate text-center text-2xs">{p.name}</span>
                  </div>
                )}
              </li>
            ))}
            <li className="min-w-0">
              <AddTile kind={kinds[0]} label={addLabel ?? `Add ${plural}`} text={addText} dragging={dragging} onClick={pick} />
            </li>
          </ol>
        )}
      </DropTarget>

      {problems.length > 0 && (
        <div role="alert">
          <AlertPanel variant="error" icon={<XCircle aria-hidden className="size-3.5" />}>
            <ul className="space-y-0.5">
              {problems.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
            <div className="pt-0.5">
              <Button type="button" variant="ghost" size="xs" onClick={() => setProblems([])}>Dismiss</Button>
            </div>
          </AlertPanel>
        </div>
      )}
    </section>
  )
}

/** The dashed last cell of a grid, the same shape as the tiles. */
function AddTile({ kind, label, text, dragging, onClick }: { kind: CharacterMediaKind; label: string; text?: string; dragging: boolean; onClick: () => void }) {
  const accent = kindAccent(kind)
  const visual = kind === 'image' || kind === 'video'
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={label}
      onClick={onClick}
      className={cn(
        'h-auto w-full flex-col gap-1.5 rounded-xl border-2 border-dashed text-xs font-medium whitespace-normal',
        visual ? 'aspect-[3/4]' : 'aspect-square',
        accent.add,
        dragging && accent.addDragging,
      )}
    >
      <Plus aria-hidden className="size-5" />
      {text ?? 'Add'}
    </Button>
  )
}

export function DefaultBadge({ children }: { children: string }) {
  return (
    <span data-testid="default-badge" className="bg-background/85 inline-flex items-center gap-0.5 rounded px-1 py-px text-3xs font-medium shadow-sm">
      <Star aria-hidden className="text-warning size-2.5 fill-current" />
      {children}
    </span>
  )
}

interface VisualTileProps {
  item: SourceItem
  kind: 'image' | 'video'
  first: boolean
  last: boolean
  locked: boolean
  isDefault: boolean
  removeBlocked: string | null
  onRemove: () => void
  onMove: (delta: -1 | 1) => void
  onToggleDefault?: () => void
}

function VisualTile({ item, kind, first, last, locked, isDefault, removeBlocked, onRemove, onMove, onToggleDefault }: VisualTileProps) {
  const label = item.label
  const playback = useThumbPlayback()
  const [duration, setDuration] = useState<number | null>(item.durationS)
  const blockedId = useId()
  return (
    <li
      title={label}
      onKeyDown={locked ? undefined : moveKeys(first, last, onMove)}
      {...(kind === 'video' ? playback.containerProps : {})}
      className={cn(
        'group bg-muted relative aspect-[3/4] min-w-0 overflow-hidden rounded-xl ring-1 ring-border/60',
        'transition-shadow motion-reduce:transition-none hover:ring-2 hover:ring-ring/70 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
        isDefault && 'ring-2 ring-warning/70',
      )}
    >
      <MediaThumb kind={kind} src={item.src} label={label} playback={playback} onDuration={setDuration} />
      <div aria-hidden className={cn('bg-background/30 pointer-events-none absolute inset-0', REVEAL)} />

      {!locked && (
        <>
          <div className={cn('absolute top-1 left-1 flex gap-0.5', REVEAL)}>
            <Button type="button" variant="secondary" size="icon-xs" aria-label={`Move ${label} earlier`} disabled={first} onClick={() => onMove(-1)} className="shadow-sm">
              <ArrowLeft aria-hidden />
            </Button>
            <Button type="button" variant="secondary" size="icon-xs" aria-label={`Move ${label} later`} disabled={last} onClick={() => onMove(1)} className="shadow-sm">
              <ArrowRight aria-hidden />
            </Button>
          </div>

          {removeBlocked ? (
            <ChipTooltip tip={removeBlocked} side="top">
              <Button
                type="button"
                variant="secondary"
                size="icon-xs"
                aria-label={`Remove ${label}`}
                aria-disabled="true"
                aria-describedby={blockedId}
                onClick={(e) => e.preventDefault()}
                className={cn('absolute top-1 right-1 cursor-not-allowed opacity-50 shadow-sm', REVEAL, 'group-hover:opacity-50')}
              >
                <X aria-hidden />
                <span id={blockedId} className="sr-only">{removeBlocked}</span>
              </Button>
            </ChipTooltip>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="icon-xs"
              aria-label={`Remove ${label}`}
              onClick={onRemove}
              className={cn('absolute top-1 right-1 shadow-sm', REVEAL)}
            >
              <X aria-hidden />
            </Button>
          )}
        </>
      )}

      {isDefault && (
        <div className="pointer-events-none absolute bottom-1 left-1">
          <DefaultBadge>Face</DefaultBadge>
        </div>
      )}

      {onToggleDefault && (
        <Button
          type="button"
          variant="secondary"
          size="icon-xs"
          aria-label={`Use ${label} as the face`}
          aria-pressed={isDefault}
          onClick={onToggleDefault}
          className={cn('absolute right-1 bottom-1 shadow-sm', REVEAL)}
        >
          <Star aria-hidden className={cn(isDefault && 'text-warning fill-current')} />
        </Button>
      )}

      {kind === 'video' && duration != null && (
        <span className="bg-background/85 pointer-events-none absolute right-1 bottom-1 rounded px-1 text-3xs tabular-nums group-hover:opacity-0 group-has-[:focus-visible]:opacity-0">
          {formatDuration(duration)}
        </span>
      )}
    </li>
  )
}
