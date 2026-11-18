'use client'

/**
 * Visual-first loader UI. The media is the content: a grid of square
 * thumbnails, one Drop / Add control, at most one notice, and one muted
 * footer line with the limit. Controls appear on the tile on hover or keyboard
 * focus (always on touch screens). Audio clips are compact rows.
 */
import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CircleSlash,
  ImagePlus,
  Info,
  Loader2,
  Music,
  RefreshCw,
  Replace,
  Upload,
  X,
  XCircle,
} from 'lucide-react'
import { AlertPanel } from '@/components/alert-panel'
import { Button } from '@/components/ui/button'
import { BlockFooter } from '@/components/pipeline/block-footer'
import { ChipTooltip } from '@/components/chip-tooltip'
import { limitSource, type DownstreamLimit } from '@/lib/byok/downstream-limits'
import { kindSingular, type LoaderItem, type LoaderKind } from '@/lib/byok/loader-items'
import { HEALTH_LABEL } from '@/lib/byok/reference-health'
import type { DownstreamLimitsState } from '@/lib/byok/use-downstream-limits'
import type { ReferenceHealthState } from '@/lib/byok/use-reference-health'
import { pickFiles } from '@/lib/file-picker'
import { cn } from '@/lib/utils'
import { MediaThumb, useThumbPlayback } from './media-thumb'
import type { LoaderListState, LoaderRow } from './use-media-loader'

const ACCEPT: Record<LoaderKind, string> = { image: 'image/*', video: 'video/*', audio: 'audio/*' }
const FLAG_SHORT = { over_limit: 'Over limit', incompatible: 'Does not fit', unsupported: 'Not accepted' } as const

/**
 * What the notice and footer read: a loader list, or one kind of the Load
 * Character block's selection (which has no add messages and whose broken
 * files can only be removed).
 */
export interface LoaderSectionState {
  kind: LoaderKind
  plural: string
  items: readonly LoaderItem[]
  rows: readonly LoaderRow[]
  strictest: DownstreamLimit | null
  limits: DownstreamLimitsState
  health: ReferenceHealthState
  /** Drop the items over the limit (a loader removes them; Load Character deselects them). */
  removeExtras: () => void
  addMessages?: readonly string[]
  dismissAddMessages?: () => void
  /** False where a broken file cannot be replaced here, only removed. Defaults to true. */
  canReplace?: boolean
}

function noun(list: Pick<LoaderSectionState, 'kind' | 'plural'>, n: number) {
  return n === 1 ? kindSingular(list.kind) : list.plural
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function mbShort(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`
}

/** Open the file picker for a list. */
async function pick(list: LoaderListState, slug: string, multiple: boolean): Promise<File[]> {
  const files = await pickFiles({ slug, accept: ACCEPT[list.kind], multiple, description: list.plural })
  return files ?? []
}

/** Drag-and-drop target that highlights while files are over it. */
export function DropTarget({ onFiles, children, className }: { onFiles: (files: File[]) => void; children: (dragging: boolean) => ReactNode; className?: string }) {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  return (
    <div
      data-testid="loader-drop-zone"
      className={className}
      onDragEnter={(e) => { e.preventDefault(); depth.current += 1; setDragging(true) }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setDragging(false) }}
      onDrop={(e: DragEvent) => {
        e.preventDefault()
        e.stopPropagation()
        depth.current = 0
        setDragging(false)
        onFiles(Array.from(e.dataTransfer?.files ?? []))
      }}
    >
      {children(dragging)}
    </div>
  )
}

// ---- Notice and footer ----

interface NoticeLine {
  severity: 'error' | 'warning' | 'info'
  text: string
}

/** At most one compact panel, only when something needs attention. */
export function LoaderNotice({ list }: { list: LoaderSectionState }) {
  const { rows, strictest, items } = list
  const addMessages = list.addMessages ?? []
  const lines: NoticeLine[] = addMessages.map((text) => ({ severity: 'error', text }))
  const broken = rows.filter((r) => r.broken).length
  if (broken > 0) {
    const them = broken === 1 ? 'it' : 'them'
    lines.push({
      severity: 'error',
      text: list.canReplace === false
        ? `${broken} ${broken === 1 ? 'file' : 'files'} could not be found. Remove ${them} here, or add ${them} again on the Characters page.`
        : `${broken} ${broken === 1 ? 'file' : 'files'} could not be found. Replace or remove ${them}.`,
    })
  }
  const unsupported = strictest && !strictest.accepted && items.length > 0
  if (unsupported) {
    lines.push({ severity: 'warning', text: `${limitSource(strictest)} does not take ${list.plural}. Nothing was removed.` })
  }
  const over = rows.some((r) => r.flag.status === 'over_limit')
  if (strictest?.accepted && over) {
    lines.push({
      severity: 'warning',
      text: items.length > strictest.maxCount
        ? `${items.length} ${list.plural}, but ${limitSource(strictest)} takes up to ${strictest.maxCount}. Nothing was removed.`
        : `Some ${list.plural} go over a limit of ${limitSource(strictest)}.`,
    })
  }
  const misfits = rows.filter((r) => r.flag.status === 'incompatible').length
  if (misfits > 0) {
    lines.push({ severity: 'warning', text: `${misfits} ${noun(list, misfits)} ${misfits === 1 ? 'does' : 'do'} not fit. Replace or remove the marked ${misfits === 1 ? 'one' : 'ones'}.` })
  }
  const unverified = list.health.status === 'failed' && items.length > 0
  if (unverified) lines.push({ severity: 'info', text: 'Could not verify the saved files.' })
  if (lines.length === 0) return null

  const variant = lines.some((l) => l.severity === 'error') ? 'error' : lines.some((l) => l.severity === 'warning') ? 'warning' : 'info'
  const Icon = variant === 'error' ? XCircle : variant === 'warning' ? AlertTriangle : Info
  return (
    <div role={addMessages.length > 0 ? 'alert' : 'status'} data-testid="loader-notice">
      <AlertPanel variant={variant} icon={<Icon aria-hidden className="size-3.5" />}>
        <ul className="space-y-0.5">
          {lines.map((l, i) => <li key={i}>{l.text}</li>)}
        </ul>
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {strictest?.accepted && over && (
            <Button type="button" variant="outline" size="xs" onClick={list.removeExtras}>Remove extras</Button>
          )}
          {(broken > 0 || unverified) && (
            <Button type="button" variant="outline" size="xs" onClick={list.health.recheck}><RefreshCw aria-hidden />Re-check</Button>
          )}
          {addMessages.length > 0 && list.dismissAddMessages && (
            <Button type="button" variant="ghost" size="xs" onClick={list.dismissAddMessages}>Dismiss</Button>
          )}
        </div>
      </AlertPanel>
    </div>
  )
}

/** One muted line: count, limit and its source, formats and size; the rest in a tooltip. */
export function LoaderFooter({ list }: { list: Pick<LoaderSectionState, 'kind' | 'plural' | 'items' | 'strictest' | 'limits'> }) {
  const { strictest, items, limits } = list
  const parts: string[] = []
  const details: string[] = []
  if (!strictest) {
    parts.push(`${items.length} ${noun(list, items.length)}`)
    details.push('No generation block reads this yet, so there is no limit. Files stay on this computer until a generation uses them.')
  } else if (!strictest.accepted) {
    parts.push(`Not supported by ${strictest.modelName}`)
    if (strictest.reason) details.push(strictest.reason)
  } else {
    parts.push(`${items.length} of ${strictest.maxCount}`, strictest.modelName)
    const limit = strictest.limit
    if (limit && limit.formats.length > 0) parts.push(limit.formats.join(', '))
    if (limit?.max_size_bytes != null) parts.push(`≤ ${mbShort(limit.max_size_bytes)}`)
    if (limit?.max_duration_s != null) parts.push(`≤ ${limit.max_duration_s} s`)
    details.push(`Limit from ${limitSource(strictest)}${limits.consumers.length > 1 ? `, the strictest of ${limits.consumers.length} blocks` : ''}.`)
    if (limit) {
      if (limit.formats.length > 0) details.push(`Formats: ${limit.formats.join(', ')}.`)
      if (limit.max_size_bytes != null) details.push(`Up to ${mbShort(limit.max_size_bytes)} each.`)
      if (limit.min_duration_s != null || limit.max_duration_s != null) {
        details.push(`${limit.min_duration_s ?? 0}–${limit.max_duration_s ?? '∞'} s each.`)
      }
      if (limit.max_total_duration_s != null) details.push(`${limit.max_total_duration_s} s in total.`)
      if (limit.min_side_px != null || limit.max_side_px != null) details.push(`Sides ${limit.min_side_px ?? 1}–${limit.max_side_px ?? '∞'} px.`)
    }
    if (strictest.frameSlots !== null) details.push('The first image is the first frame; a second is the last frame.')
    details.push('Files stay on this computer until a generation uses them.')
  }
  const line = parts.join(' · ')
  return (
    <BlockFooter testId="loader-footer">
        <span className="min-w-0 flex-1 truncate" title={line}>{line}</span>
        <ChipTooltip tip={details.join(' ')}>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`${list.plural} limit details`}>
            <Info aria-hidden />
          </Button>
        </ChipTooltip>
    </BlockFooter>
  )
}

// ---- Tiles ----

/**
 * The status strip at the bottom of a tile or row: saving, not saved, broken,
 * flagged or not verified. A broken item offers Replace, or Remove where the
 * file cannot be replaced here (`onRemove`, the Load Character block).
 */
export function TileStatus({ row, onReplace, onRemove }: { row: LoaderRow; onReplace?: () => void; onRemove?: () => void }) {
  const { item, flag, broken, health } = row
  let icon: ReactNode = null
  let text: string | null = null
  let detail: string | null = null
  if (item.status === 'saving') {
    icon = <Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />
    text = 'Saving'
  } else if (item.status === 'error') {
    icon = <XCircle aria-hidden className="text-destructive size-3" />
    text = 'Not saved'
    detail = item.error ?? null
  } else if (broken && health) {
    icon = <XCircle aria-hidden className="text-destructive size-3" />
    text = HEALTH_LABEL[health.status]
    detail = health.detail
  } else if (flag.status !== 'ok') {
    icon = flag.status === 'unsupported'
      ? <CircleSlash aria-hidden className="text-warning size-3" />
      : <AlertTriangle aria-hidden className="text-warning size-3" />
    text = FLAG_SHORT[flag.status]
    detail = flag.reason
  } else if (health?.status === 'unchecked') {
    icon = <Info aria-hidden className="size-3" />
    text = 'Not verified'
    detail = health.detail
  }
  if (!text) return null
  return (
    <div data-testid="item-status" className="bg-background/90 flex min-w-0 items-center gap-1 px-1.5 py-1 text-3xs" title={detail ?? undefined}>
      {icon}
      <span className="min-w-0 flex-1 truncate font-medium">{text}</span>
      {(broken || item.status === 'error') && onRemove && (
        <Button type="button" variant="outline" size="xs" className="h-5 px-1.5" aria-label={`Remove ${item.label}`} onClick={onRemove}>
          <X aria-hidden />Remove
        </Button>
      )}
      {(broken || item.status === 'error') && !onRemove && onReplace && (
        <Button type="button" variant="outline" size="xs" className="h-5 px-1.5" aria-label={`Replace ${item.label}`} onClick={onReplace}>
          <Replace aria-hidden />Replace
        </Button>
      )}
    </div>
  )
}

/** Shown on hover, keyboard focus (:focus-visible, so a click does not leave it stuck open) and touch. */
export const REVEAL = 'opacity-0 transition-opacity motion-reduce:transition-none group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 pointer-coarse:opacity-100'

function MediaTile({
  row,
  index,
  count,
  list,
  onReplace,
}: {
  row: LoaderRow
  index: number
  count: number
  list: LoaderListState
  onReplace: (id: string) => void
}) {
  const { item, broken } = row
  const label = item.label
  const playback = useThumbPlayback()
  const { play, pause } = playback
  const [duration, setDuration] = useState<number | null>(item.duration_s ?? null)
  const src = broken || item.status !== 'ready' ? undefined : item.local ?? item.url
  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.altKey) return
    const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft'
    const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight'
    if (!back && !forward) return
    e.preventDefault()
    list.moveItem(item.id, back ? -1 : 1)
  }
  const problem = broken || item.status === 'error' || row.flag.status !== 'ok'
  return (
    <li
      data-testid="loader-item"
      data-flag={row.flag.status}
      data-broken={broken || undefined}
      title={label}
      onKeyDown={onKeyDown}
      onMouseEnter={list.kind === 'video' ? play : undefined}
      onMouseLeave={list.kind === 'video' ? pause : undefined}
      onFocus={list.kind === 'video' ? play : undefined}
      onBlur={list.kind === 'video' ? pause : undefined}
      className={cn(
        'group bg-muted relative aspect-square min-w-0 overflow-hidden rounded-lg ring-1 ring-border/60',
        'transition-shadow motion-reduce:transition-none hover:ring-2 hover:ring-ring/70 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
        problem && 'ring-warning/60',
        (broken || item.status === 'error') && 'ring-destructive/60',
      )}
    >
      <MediaThumb
        kind={list.kind === 'video' ? 'video' : 'image'}
        src={src}
        label={label}
        saving={item.status === 'saving'}
        playback={playback}
        onDuration={setDuration}
      />

      <div aria-hidden className={cn('bg-background/30 pointer-events-none absolute inset-0', REVEAL)} />

      <div className="absolute top-1 left-1 flex flex-col items-start gap-0.5">
        <span className="bg-background/85 rounded px-1 text-3xs font-medium tabular-nums">{index + 1}</span>
        {row.role && <span className="bg-background/85 rounded px-1 text-3xs font-medium" data-testid="tile-role">{row.role}</span>}
      </div>

      <Button
        type="button"
        variant="secondary"
        size="icon-xs"
        aria-label={`Remove ${label}`}
        onClick={() => list.removeItem(item.id)}
        className={cn('absolute top-1 right-1 shadow-sm focus-visible:opacity-100', REVEAL)}
      >
        <X aria-hidden />
      </Button>

      <div className="absolute inset-x-0 bottom-0 flex flex-col">
        <div className={cn('flex items-center justify-between gap-1 px-1 pb-1', REVEAL)}>
          <div className="flex gap-0.5">
            <Button type="button" variant="secondary" size="icon-xs" aria-label={`Move ${label} earlier`}
              disabled={index === 0} onClick={() => list.moveItem(item.id, -1)}>
              <ArrowLeft aria-hidden />
            </Button>
            <Button type="button" variant="secondary" size="icon-xs" aria-label={`Move ${label} later`}
              disabled={index >= count - 1} onClick={() => list.moveItem(item.id, 1)}>
              <ArrowRight aria-hidden />
            </Button>
          </div>
        </div>
        {list.kind === 'video' && duration != null && (
          <span className="bg-background/85 absolute right-1 bottom-1 rounded px-1 text-3xs tabular-nums group-hover:opacity-0 group-has-[:focus-visible]:opacity-0">
            {formatDuration(duration)}
          </span>
        )}
        <TileStatus row={row} onReplace={() => onReplace(item.id)} />
      </div>
    </li>
  )
}

export interface VisualLoaderSectionProps {
  list: LoaderListState
  /** File picker slug, so each loader remembers its own folder. */
  pickerSlug: string
  /** Section heading (Omni loader); single-kind loaders have none. */
  title?: string
  /** A secondary control next to Drop / Add (the image loader's past generations). */
  secondaryAction?: ReactNode
}

/** Grid of tiles, Drop / Add, one notice, one footer line. */
export function VisualLoaderSection({ list, pickerSlug, title, secondaryAction }: VisualLoaderSectionProps) {
  const { rows, items, strictest } = list
  const supported = !strictest || strictest.accepted
  const add = () => { void pick(list, pickerSlug, true).then((files) => list.addFiles(files)) }
  const replace = (id: string) => {
    void pick(list, pickerSlug, false).then((files) => { if (files[0]) void list.replaceItem(id, files[0]) })
  }
  const label = title ?? (list.kind === 'image' ? 'Images' : 'Videos')
  const Icon = list.kind === 'image' ? ImagePlus : Upload

  // Without a title the section is a single-kind loader's root, and the block
  // body sets the gap between its items; a titled section is one group of a
  // multi-kind loader and keeps a tighter gap inside the group.
  return (
    <section aria-label={label} data-kind={list.kind} className={cn('@container flex min-w-0 flex-col', title && 'gap-2')}>
      {title && <h3 className="text-xs font-medium">{title}</h3>}
      {items.length > 0 && (
        <ol aria-label={label} className="grid grid-cols-2 gap-1.5 @xs:grid-cols-3">
          {rows.map((row, i) => (
            <MediaTile key={row.item.id} row={row} index={i} count={rows.length} list={list} onReplace={replace} />
          ))}
        </ol>
      )}
      {supported && (
        <div className={cn('flex min-w-0 gap-1.5', items.length === 0 && 'flex-col items-end')}>
          <DropTarget onFiles={(files) => void list.addFiles(files)} className="w-full min-w-0 flex-1">
            {(dragging) => items.length === 0 ? (
              <Button
                type="button"
                variant="outline"
                onClick={add}
                className={cn(
                  'text-muted-foreground h-auto w-full flex-col gap-2 border-dashed py-10 text-xs whitespace-normal',
                  dragging && 'border-primary bg-primary/5',
                )}
              >
                <Icon aria-hidden className="size-6" />
                {`Drop ${list.plural} or click to add`}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={add}
                className={cn('w-full border-dashed text-xs', dragging && 'border-primary bg-primary/5')}
              >
                <Icon aria-hidden />
                Drop / Add
              </Button>
            )}
          </DropTarget>
          {secondaryAction}
        </div>
      )}
      <LoaderNotice list={list} />
      <LoaderFooter list={list} />
    </section>
  )
}

// ---- Audio rows ----

export function SoundLoaderSection({ list, pickerSlug, title }: { list: LoaderListState; pickerSlug: string; title: string }) {
  const { rows, items, strictest } = list
  const supported = !strictest || strictest.accepted
  const add = () => { void pick(list, pickerSlug, true).then((files) => list.addFiles(files)) }
  const replace = (id: string) => {
    void pick(list, pickerSlug, false).then((files) => { if (files[0]) void list.replaceItem(id, files[0]) })
  }
  const Icon = Music
  return (
    <section aria-label={title} data-kind={list.kind} className="flex min-w-0 flex-col gap-2">
      <h3 className="text-xs font-medium">{title}</h3>
      {items.length > 0 && (
        <ol aria-label={title} className="space-y-1">
          {rows.map((row, i) => {
            const { item } = row
            const label = item.label
            return (
              <li
                key={item.id}
                data-testid="loader-item"
                data-flag={row.flag.status}
                data-broken={row.broken || undefined}
                title={label}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
                  e.preventDefault()
                  list.moveItem(item.id, e.key === 'ArrowUp' ? -1 : 1)
                }}
                className={cn(
                  'border-border/60 min-w-0 space-y-1 rounded-md border p-1.5',
                  row.flag.status !== 'ok' && 'border-warning/50',
                  (row.broken || item.status === 'error') && 'border-destructive/50',
                )}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-2xs">{label}</span>
                  <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${label} up`}
                    disabled={i === 0} onClick={() => list.moveItem(item.id, -1)}>
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${label} down`}
                    disabled={i >= rows.length - 1} onClick={() => list.moveItem(item.id, 1)}>
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${label}`} onClick={() => list.removeItem(item.id)}>
                    <X aria-hidden />
                  </Button>
                </div>
                {item.status === 'ready' && !row.broken && (item.local || item.url) && (
                  <audio src={item.local ?? item.url} aria-label={label} controls preload="none" className="h-7 w-full min-w-0" />
                )}
                <TileStatus row={row} onReplace={() => replace(item.id)} />
              </li>
            )
          })}
        </ol>
      )}
      {supported && (
        <DropTarget onFiles={(files) => void list.addFiles(files)}>
          {(dragging) => (
            <Button type="button" variant="outline" size="xs" onClick={add}
              className={cn('w-full border-dashed', dragging && 'border-primary bg-primary/5')}>
              <Icon aria-hidden />
              {items.length === 0 ? `Drop or add ${list.plural}` : 'Drop / Add'}
            </Button>
          )}
        </DropTarget>
      )}
      <LoaderNotice list={list} />
      <LoaderFooter list={list} />
    </section>
  )
}
