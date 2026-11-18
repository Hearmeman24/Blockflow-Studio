'use client'

/**
 * The Load Character block's UI: a character picker, then the character's
 * files by kind (Images, Videos, Audio). Each file is a toggle; selected
 * files show their position in the send order. Audio clips are sound tiles
 * whose play button sits beside the selection toggle, never inside it; one
 * muted line under Audio says sound is sent as audio and the prompt says how
 * to use it.
 * Files are managed on the Characters page: there is no upload, rename or
 * reorder here. Notices, footers and tile statuses are the loaders' own.
 */
import Link from 'next/link'
import { RefreshCw, Star, UserRound, XCircle } from 'lucide-react'
import { AlertPanel } from '@/components/alert-panel'
import { EmptyState } from '@/components/empty-state'
import { KindHeading } from '@/components/byok/kind-heading'
import { LoaderFooter, LoaderNotice, TileStatus } from '@/components/byok/media-loader'
import { MediaThumb, useThumbPlayback } from '@/components/byok/media-thumb'
import { SoundTile } from '@/components/byok/sound-tile'
import type { LoaderRow } from '@/components/byok/use-media-loader'
import { Button } from '@/components/ui/button'
import { ListSelect, ListSelectContent, ListSelectItem, ListSelectTrigger, ListSelectValue } from '@/components/ui/list-select'
import { Skeleton } from '@/components/ui/skeleton'
import type { Character, CharacterMedia, CharacterMediaKind } from '@/lib/characters/types'
import { defaultFace, mediaOfKind } from '@/lib/characters/use-characters'
import type { BlockComponentProps } from '@/lib/pipeline/registry'
import { useMediaItemCount } from '@/lib/pipeline/use-media-item-count'
import { cn } from '@/lib/utils'
import { deletedMessage, useLoadCharacter, type CharacterKindState, type LoadCharacterState } from './use-load-character'

function editHref(id: string): string {
  return `/characters?id=${encodeURIComponent(id)}`
}

function EditLink({ id }: { id: string }) {
  return (
    <Link href={editHref(id)} className="text-link shrink-0 text-2xs underline-offset-4 hover:underline">
      Edit character
    </Link>
  )
}

function Avatar({ character }: { character: Character }) {
  const face = defaultFace(character)
  return face ? (
    // A local /outputs file; next/image cannot optimise it.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={face.local} alt="" className="size-5 shrink-0 rounded-full object-cover" />
  ) : (
    <span aria-hidden className="bg-muted flex size-5 shrink-0 items-center justify-center rounded-full">
      <UserRound className="size-3" />
    </span>
  )
}

function CharacterName({ character }: { character: Character }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Avatar character={character} />
      <span className="truncate">{character.name}</span>
    </span>
  )
}

function CharacterPicker({ state }: { state: LoadCharacterState }) {
  const { resource, retry, character, choose } = state
  if (resource.kind === 'error') {
    return (
      <div role="alert">
        <AlertPanel variant="error" icon={<XCircle aria-hidden className="size-3.5" />}>
          <p>{resource.message}</p>
          <div className="pt-0.5">
            <Button type="button" variant="outline" size="xs" onClick={retry}><RefreshCw aria-hidden />Retry</Button>
          </div>
        </AlertPanel>
      </div>
    )
  }
  if (resource.kind === 'loading') return <Skeleton data-testid="character-picker-loading" className="h-7 w-full" />
  const characters = resource.data
  if (characters.length === 0) {
    return (
      <EmptyState
        icon={UserRound}
        title="No characters yet"
        description="Create a character to reuse its images, videos and audio in your pipelines."
        className="py-6"
        action={(
          <Button asChild variant="outline" size="sm">
            <Link href="/characters?new=1">Add character</Link>
          </Button>
        )}
      />
    )
  }
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1">
        <ListSelect value={character?.id ?? null} onValueChange={choose} placeholder="Choose a character">
          <ListSelectTrigger aria-label="Character">
            <ListSelectValue>{() => (character ? <CharacterName character={character} /> : 'Choose a character')}</ListSelectValue>
          </ListSelectTrigger>
          <ListSelectContent>
            {characters.map((c) => (
              <ListSelectItem key={c.id} value={c.id} label={c.name}>
                <CharacterName character={c} />
              </ListSelectItem>
            ))}
          </ListSelectContent>
        </ListSelect>
      </div>
      {character && <EditLink id={character.id} />}
    </div>
  )
}

// ---- Files ----

interface FileEntry {
  id: string
  label: string
  local: string
  sizeBytes: number | null
  /** Its row in the send order, when selected. */
  row: LoaderRow | null
  index: number
}

/** The character's files of one kind in library order, then selected files it no longer has (from the snapshot). */
function entriesOf(state: CharacterKindState, library: readonly CharacterMedia[]): FileEntry[] {
  const byId = new Map(state.rows.map((row, index) => [row.item.id, { row, index }]))
  const libraryIds = new Set(library.map((m) => m.id))
  const fromLibrary = library.map((m) => ({ id: m.id, label: m.label, local: m.local, sizeBytes: m.size_bytes, row: byId.get(m.id)?.row ?? null, index: byId.get(m.id)?.index ?? -1 }))
  const missing = state.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !libraryIds.has(row.item.id))
    .map(({ row, index }) => ({ id: row.item.id, label: row.item.label, local: row.item.local ?? '', sizeBytes: row.item.size_bytes ?? null, row, index }))
  return [...fromLibrary, ...missing]
}

function OrderBadge({ index }: { index: number }) {
  return (
    <span data-testid="tile-order" className="bg-primary text-primary-foreground rounded px-1 text-3xs font-medium tabular-nums">
      {index + 1}
    </span>
  )
}

function Unsupported({ title, state }: { title: string; state: CharacterKindState }) {
  return (
    <section aria-label={title} data-kind={state.kind} className="flex min-w-0 flex-col gap-1">
      <KindHeading kind={state.kind} title={title} small />
      <p className="text-muted-foreground text-2xs">Not supported by {state.strictest?.modelName} · not sent</p>
    </section>
  )
}

function MediaTile({ kind, entry, isDefault, state }: { kind: 'image' | 'video'; entry: FileEntry; isDefault: boolean; state: CharacterKindState }) {
  const { row } = entry
  const selected = row !== null
  const broken = Boolean(row?.broken)
  const problem = Boolean(row && row.flag.status !== 'ok')
  const playback = useThumbPlayback()
  const hover = kind === 'video' ? playback.containerProps : {}
  return (
    <li
      data-testid="character-tile"
      data-selected={selected || undefined}
      data-flag={row?.flag.status}
      data-broken={broken || undefined}
      title={entry.label}
      {...hover}
      className={cn(
        'group bg-muted relative aspect-square min-w-0 overflow-hidden rounded-lg ring-1 ring-border/60',
        'transition-shadow motion-reduce:transition-none hover:ring-2 hover:ring-ring/70 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
        selected && 'ring-2 ring-primary hover:ring-primary',
        problem && 'ring-warning/60 hover:ring-warning/60',
        broken && 'ring-destructive/60 hover:ring-destructive/60',
      )}
    >
      <Button
        type="button"
        variant="ghost"
        aria-pressed={selected}
        aria-label={entry.label}
        onClick={() => state.toggle(entry.id)}
        className="size-full rounded-none p-0 hover:bg-transparent focus-visible:ring-0 dark:hover:bg-transparent"
      >
        <span className={cn('block size-full transition-opacity motion-reduce:transition-none', !selected && 'opacity-45 group-hover:opacity-80')}>
          <MediaThumb kind={kind} src={broken || !entry.local ? undefined : entry.local} label={entry.label} playback={playback} />
        </span>
      </Button>
      <div className="pointer-events-none absolute top-1 left-1 flex flex-col items-start gap-0.5">
        {selected && <OrderBadge index={entry.index} />}
        {row?.role && <span className="bg-background/85 rounded px-1 text-3xs font-medium" data-testid="tile-role">{row.role}</span>}
      </div>
      {isDefault && (
        <span data-testid="default-face" title="Default face" className="bg-background/85 pointer-events-none absolute top-1 right-1 rounded p-0.5">
          <Star aria-label="Default face" className="text-foreground size-3 fill-current" />
        </span>
      )}
      {row && (
        <div className="absolute inset-x-0 bottom-0">
          <TileStatus row={row} onRemove={() => state.deselect(entry.id)} />
        </div>
      )}
    </li>
  )
}

function VisualSection({ title, kind, state, character }: { title: string; kind: 'image' | 'video'; state: CharacterKindState; character: Character | null }) {
  if (state.skipped) return <Unsupported title={title} state={state} />
  const entries = entriesOf(state, character ? mediaOfKind(character, kind) : [])
  const faceId = kind === 'image' && character ? defaultFace(character)?.id : undefined
  return (
    <section aria-label={title} data-kind={kind} className="@container flex min-w-0 flex-col gap-2">
      <KindHeading kind={kind} title={title} small />
      <ul aria-label={title} className="grid grid-cols-2 gap-1.5 @xs:grid-cols-3">
        {entries.map((entry) => <MediaTile key={entry.id} kind={kind} entry={entry} isDefault={entry.id === faceId} state={state} />)}
      </ul>
      <LoaderNotice list={{ ...state, canReplace: false }} />
      <LoaderFooter list={state} />
    </section>
  )
}

/** Under the Audio heading: how a character's sound reaches the model. */
export const AUDIO_TRANSPARENCY = 'Sent as audio. Your prompt says how to use it.'

function AudioSection({ state, character }: { state: CharacterKindState; character: Character | null }) {
  const title = 'Audio'
  if (state.skipped) return <Unsupported title={title} state={state} />
  const entries = entriesOf(state, character ? mediaOfKind(character, 'audio') : [])
  return (
    <section aria-label={title} data-kind="audio" className="@container flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <KindHeading kind="audio" title={title} small />
        <p className="text-muted-foreground text-2xs">{AUDIO_TRANSPARENCY}</p>
      </div>
      <ul aria-label={title} className="grid grid-cols-2 gap-1.5 @xs:grid-cols-3">
        {entries.map((entry) => {
          const { row } = entry
          const selected = row !== null
          const broken = Boolean(row?.broken)
          return (
            <li
              key={entry.id}
              data-testid="character-tile"
              data-selected={selected || undefined}
              data-flag={row?.flag.status}
              data-broken={broken || undefined}
              title={entry.label}
              className="min-w-0"
            >
              <SoundTile
                src={broken || !entry.local ? undefined : entry.local}
                label={entry.label}
                sizeBytes={entry.sizeBytes}
                dimmed={!selected}
                badges={selected ? <OrderBadge index={entry.index} /> : undefined}
                overlay={(
                  <Button
                    type="button"
                    variant="ghost"
                    aria-pressed={selected}
                    aria-label={entry.label}
                    onClick={() => state.toggle(entry.id)}
                    className="size-full rounded-none p-0 hover:bg-transparent focus-visible:ring-0 dark:hover:bg-transparent"
                  />
                )}
                footer={row ? <TileStatus row={row} onRemove={() => state.deselect(entry.id)} /> : undefined}
                className={cn(
                  selected && 'ring-2 ring-primary hover:ring-primary',
                  row && row.flag.status !== 'ok' && 'ring-warning/60 hover:ring-warning/60',
                  broken && 'ring-destructive/60 hover:ring-destructive/60',
                )}
              />
            </li>
          )
        })}
      </ul>
      <LoaderNotice list={{ ...state, canReplace: false }} />
      <LoaderFooter list={state} />
    </section>
  )
}

export function LoadCharacterBlock(props: BlockComponentProps) {
  const state = useLoadCharacter(props)
  const { characterId, character, deleted, snapshot, image, video, audio } = state
  const shows = (kind: CharacterMediaKind, s: CharacterKindState) => s.items.length > 0 || Boolean(character && mediaOfKind(character, kind).length > 0)
  const show = { image: shows('image', image), video: shows('video', video), audio: shows('audio', audio) }
  const anything = show.image || show.video || show.audio
  // Tiles a section shows (the character's files of that kind), so the card can narrow while there are few.
  const tiles = (kind: CharacterMediaKind, s: CharacterKindState) =>
    characterId && show[kind] && !s.skipped ? entriesOf(s, character ? mediaOfKind(character, kind) : []).length : 0
  useMediaItemCount(props.setMediaItemCount, [tiles('image', image), tiles('video', video), tiles('audio', audio)])
  // The block body sets the gap between these (see block-card.tsx).
  return (
    <div className="@container min-w-0" data-testid="load-character">
      <CharacterPicker state={state} />
      {deleted && (
        <AlertPanel variant="error" icon={<XCircle aria-hidden className="size-3.5" />}>
          <p>{deletedMessage(snapshot.name)}</p>
        </AlertPanel>
      )}
      {character && !anything && (
        <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-2xs">
          This character has no files yet.
          <EditLink id={character.id} />
        </p>
      )}
      {characterId && show.image && <VisualSection title="Images" kind="image" state={image} character={character} />}
      {characterId && show.video && <VisualSection title="Videos" kind="video" state={video} character={character} />}
      {characterId && show.audio && <AudioSection state={audio} character={character} />}
    </div>
  )
}
