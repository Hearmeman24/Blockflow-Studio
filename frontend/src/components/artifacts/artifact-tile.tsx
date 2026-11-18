'use client'

/**
 * One run in the Artifacts gallery: just its media, at its own aspect ratio.
 * Hover, keyboard focus (not the focus a click leaves behind) or a tap slides a panel up over the bottom of the
 * tile, on a dark gradient that fades into the image, with one metadata line
 * (model · cost · time) and icon actions: Restore, Favorite and, when the run
 * has a prompt, a Prompt toggle that grows the panel upward to show the full
 * prompt with a Copy button. Clicking the media (or Enter/Space on the tile)
 * opens the viewer; on touch the first tap opens the panel, the next tap on
 * the media opens the viewer.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { AlertTriangle, ChevronUp, FileText, Music, Video } from 'lucide-react'
import { isKeyboardFocus } from '@/components/chip-tooltip'
import { Button } from '@/components/ui/button'
import { CopyPromptButton, FavoriteRunButton, RestoreButton, useRestoreRun, useRunFavorite } from './run-actions'
import { findPrimaryArtifact, mediaUrls, primaryMeta, runFailure, runModelId, runPrompt } from '@/lib/artifacts/run-media'
import { findModel } from '@/lib/byok/catalog'
import { formatAmount, formatUsd } from '@/lib/byok/cost'
import { useProviderCatalog } from '@/lib/byok/use-provider-catalog'
import { formatRelativeTime } from '@/lib/format-time'
import type { GenerationMeta } from '@/lib/image-ref'
import { runStatusBadge } from '@/lib/status'
import type { RunEntry } from '@/lib/types'
import { cn } from '@/lib/utils'

/** "3.24 credits", "$0.06"; PiAPI points as dollars when they convert. */
export function shortCost(cost: NonNullable<GenerationMeta['cost']>): string {
  const unit = cost.unit.toLowerCase()
  if (unit === 'usd') return formatUsd(cost.amount)
  if (unit === 'points' && typeof cost.usd_equivalent === 'number') return formatUsd(cost.usd_equivalent)
  return formatAmount(cost.amount, cost.unit)
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export interface ArtifactTileProps {
  run: RunEntry
  onFavoriteToggled?: () => void
  /** Called with width / height once the media's real size is known. */
  onAspect?: (aspect: number) => void
  /** Open this run in the viewer. */
  onOpen?: () => void
}

export function ArtifactTile({ run, onFavoriteToggled, onAspect, onOpen }: ArtifactTileProps) {
  const restoreRun = useRestoreRun()
  const { fav, toggle: toggleFavorite } = useRunFavorite(run, onFavoriteToggled)
  const { catalog } = useProviderCatalog()
  const promptId = useId()

  const primary = useMemo(() => findPrimaryArtifact(run.block_results ?? []), [run.block_results])
  const meta = primaryMeta(primary)
  const media = primary ? mediaUrls(primary.kind, primary.value)[0] : undefined
  const kind = media ? primary?.kind : undefined
  const prompt = useMemo(() => runPrompt(run), [run])
  const failure = runFailure(run)
  const modelId = runModelId(run, primary)
  const modelName = modelId ? findModel(catalog, modelId)?.name ?? modelId : ''
  const metaLine = [modelName, meta?.cost ? shortCost(meta.cost) : '', formatRelativeTime(run.created_at)].filter(Boolean).join(' · ')

  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const [duration, setDuration] = useState<number | null>(null)
  const open = !dismissed && (hovered || focused || pinned)

  const tileRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const lastPointer = useRef('mouse')

  // Videos play muted while the panel is open (hover, focus or tap).
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (open) {
      try {
        void video.play()?.catch(() => {})
      } catch {
        // Playback is a nicety; the poster frame stays.
      }
    } else {
      video.pause()
    }
  }, [open])

  const close = () => {
    setPromptOpen(false)
    setPinned(false)
  }

  // Native enter/leave: they fire only when the pointer really crosses the
  // tile's edge, not when it moves between the tile's own controls.
  useEffect(() => {
    const tile = tileRef.current
    if (!tile) return
    const enter = (e: globalThis.PointerEvent) => {
      if (e.pointerType === 'touch') return
      setHovered(true)
      setDismissed(false)
    }
    const leave = (e: globalThis.PointerEvent) => {
      if (e.pointerType === 'touch') return
      setHovered(false)
      setPromptOpen(false)
      // Focus left behind by a click does not hold the panel open; keyboard focus does.
      if (!isKeyboardFocus()) setFocused(false)
    }
    tile.addEventListener('pointerenter', enter)
    tile.addEventListener('pointerleave', leave)
    return () => {
      tile.removeEventListener('pointerenter', enter)
      tile.removeEventListener('pointerleave', leave)
    }
  }, [])
  // A click on the media opens the viewer. The panel's controls do their own
  // thing only. On touch the first tap opens the panel instead, so a tap never
  // triggers something the user could not see first.
  const onClick = (e: MouseEvent) => {
    if (panelRef.current?.contains(e.target as Node)) return
    if (lastPointer.current === 'touch' && !open) {
      setPinned(true)
      setDismissed(false)
      return
    }
    onOpen?.()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === tileRef.current) {
      e.preventDefault()
      onOpen?.()
      return
    }
    if (e.key !== 'Escape') return
    e.stopPropagation()
    if (promptOpen) {
      setPromptOpen(false)
      toggleRef.current?.focus()
    } else if (open) {
      close()
      setDismissed(true)
      tileRef.current?.focus()
    }
  }

  const name = run.name || 'Run'
  const badge = runStatusBadge(run.status)
  const statusLabel = badge?.label ?? null

  return (
    <div
      ref={tileRef}
      role="group"
      aria-label={name}
      tabIndex={0}
      data-open={open}
      data-run-tile={run.id}
      onPointerDown={(e) => { lastPointer.current = e.pointerType || 'mouse' }}
      onClick={onClick}
      onFocus={(e) => {
        // Only keyboard focus opens or holds the panel (focus-visible semantics);
        // a click's focus is covered by the hover that came with it.
        const keyboard = isKeyboardFocus()
        setFocused(keyboard)
        if (keyboard && !tileRef.current?.contains(e.relatedTarget as Node | null)) setDismissed(false)
      }}
      onBlur={(e) => {
        if (tileRef.current?.contains(e.relatedTarget as Node | null)) return
        // relatedTarget is not always set while focus moves between two controls
        // of the tile, so check where focus landed once it has moved.
        setTimeout(() => {
          const tile = tileRef.current
          if (!tile || tile.contains(document.activeElement)) return
          setFocused(false)
          setDismissed(false)
          close()
        }, 0)
      }}
      onKeyDown={onKeyDown}
      className={cn(
        'bg-muted/30 relative size-full overflow-hidden rounded-lg outline-none',
        'focus-visible:ring-ring focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-offset-2',
      )}
    >
      {/* Media */}
      {kind === 'image' && media ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={media}
          alt={name}
          loading="lazy"
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget
            if (img.naturalWidth > 0 && img.naturalHeight > 0) onAspect?.(img.naturalWidth / img.naturalHeight)
          }}
          className={cn('size-full object-cover motion-safe:transition-transform motion-safe:duration-700 motion-safe:ease-out', open && 'motion-safe:scale-103')}
        />
      ) : kind === 'video' && media ? (
        <video
          ref={videoRef}
          src={`${media}#t=0.1`}
          aria-label={name}
          muted
          loop
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget
            if (v.videoWidth > 0 && v.videoHeight > 0) onAspect?.(v.videoWidth / v.videoHeight)
            if (Number.isFinite(v.duration)) setDuration(v.duration)
          }}
          className={cn('size-full object-cover motion-safe:transition-transform motion-safe:duration-700 motion-safe:ease-out', open && 'motion-safe:scale-103')}
        />
      ) : (
        <div data-testid="artifact-placeholder" className="text-muted-foreground flex size-full flex-col items-center justify-center gap-2 p-3 text-center">
          {kind === 'audio' ? <Music aria-hidden className="size-5" /> : statusLabel ? <AlertTriangle aria-hidden className="size-5" /> : <FileText aria-hidden className="size-5" />}
          <p className="line-clamp-2 text-2xs">{name}</p>
          {kind === 'audio' && media && (
            <audio src={media} controls preload="metadata" aria-label={`Audio for ${name}`} className="h-8 w-full">
              <track kind="captions" />
            </audio>
          )}
        </div>
      )}

      {/* Marks: run status (icon + text) and video */}
      {(statusLabel || kind === 'video') && (
        <div className="pointer-events-none absolute left-2 top-2 flex gap-1">
          {statusLabel && (
            <span className={cn(
              'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium',
              badge?.tone === 'error' ? 'bg-destructive text-white' : 'bg-warning text-warning-foreground',
            )}>
              <AlertTriangle aria-hidden className="size-3" />
              {statusLabel}
            </span>
          )}
          {kind === 'video' && (
            <span className="bg-background/70 text-foreground inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium backdrop-blur-sm">
              <Video aria-hidden className="size-3" />
              {duration !== null ? formatDuration(duration) : 'Video'}
            </span>
          )}
        </div>
      )}

      {/* Sliding panel: about a fifth of the tile, more when the prompt is open */}
      <div
        ref={panelRef}
        data-testid="artifact-panel"
        data-state={open ? 'open' : 'closed'}
        inert={!open}
        className={cn(
          // Scrim: a dark gradient on the panel itself (at least 80 % behind any
          // text), and above it a band that fades from that to transparent, as a
          // pseudo-element of the same element: one box, no edge, no blur, and it
          // fades and slides as one.
          'absolute inset-x-0 bottom-0 flex min-h-1/5 flex-col justify-end gap-1 px-2 pb-1.5 pt-2',
          'from-background/95 to-background/80 bg-linear-to-t',
          'before:from-background/80 before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-10 before:bg-linear-to-t before:to-transparent',
          'motion-safe:transition-[translate,opacity,visibility] motion-safe:duration-300 motion-safe:ease-out',
          open ? 'visible translate-y-0 opacity-100' : 'invisible opacity-0 motion-safe:translate-y-full',
        )}
      >
        {promptOpen && prompt && (
          <p
            id={promptId}
            data-testid="artifact-prompt"
            className="text-foreground/90 max-h-40 overflow-y-auto whitespace-pre-wrap break-words pr-1 text-2xs leading-relaxed"
          >
            {prompt}
          </p>
        )}
        {failure && <p className="text-foreground truncate text-2xs font-medium">{failure}</p>}
        <p className="text-foreground/80 truncate text-2xs tabular-nums">{metaLine}</p>
        <div className="flex items-center gap-0.5">
          <RestoreButton name={name} onRestore={() => restoreRun(run)} className="text-foreground/90 size-7" />
          <FavoriteRunButton name={name} fav={fav} onToggle={toggleFavorite} />
          {prompt && (
            <Button
              ref={toggleRef}
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`Prompt for ${name}`}
              aria-expanded={promptOpen}
              aria-controls={promptOpen ? promptId : undefined}
              onClick={() => setPromptOpen((v) => !v)}
              className="text-foreground/90 ml-auto h-7 gap-1 px-1.5 text-2xs"
            >
              Prompt
              <ChevronUp aria-hidden className={cn('size-3 motion-safe:transition-transform', promptOpen && 'rotate-180')} />
            </Button>
          )}
          {prompt && promptOpen && (
            <CopyPromptButton name={name} prompt={prompt} className="text-foreground/90 size-7" />
          )}
        </div>
      </div>
    </div>
  )
}
