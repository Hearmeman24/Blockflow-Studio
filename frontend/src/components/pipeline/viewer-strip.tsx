'use client'

/**
 * Shared parts of the viewer strips (Image, Video and Audio Viewer), which
 * render only the latest entries of their history (`useViewerHistory`'s
 * `stripStart`): the Show older control, a video thumbnail that loads
 * nothing until it scrolls into view, and the row of thumbnails the Image
 * and Video Viewer show in their bottom row and in full screen.
 */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { VIEWER_STRIP_PAGE } from '@/lib/use-viewer-history'
import { cn } from '@/lib/utils'

/**
 * Reveals the next page of older entries; renders nothing when none are hidden.
 * `compact` shows only "+N" (for a thumbnail row); the accessible name and
 * tooltip keep the full "Show older (30 of N)".
 */
export function ShowOlderButton({ hidden, onClick, compact = false }: {
  hidden: number
  onClick: () => void
  compact?: boolean
}) {
  if (hidden <= 0) return null
  const label = `Show older (${Math.min(hidden, VIEWER_STRIP_PAGE)} of ${hidden})`
  if (compact) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="shrink-0 self-center px-1.5 text-3xs tabular-nums"
        onClick={onClick}
        aria-label={label}
        title={label}
      >
        +{hidden}
      </Button>
    )
  }
  return (
    <Button type="button" variant="ghost" size="xs" className="w-full" onClick={onClick}>
      {label}
    </Button>
  )
}

/** True once `ref`'s element has been on screen (true at once without IntersectionObserver). */
function useSeen(ref: React.RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (seen || !ref.current) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true)
        observer.disconnect()
      }
    }, { rootMargin: '200px' })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [seen, ref])
  return seen
}

/**
 * A strip thumbnail of a video: no source and `preload="none"` until it is on
 * screen, then its metadata and the frame at 0.1 s (a recognisable picture,
 * no poster file needed). Off-screen thumbnails hold no decoder.
 */
export function LazyVideoThumb({ url, label, className = 'w-full bg-black/30' }: {
  url: string
  label: string
  className?: string
}) {
  const ref = useRef<HTMLVideoElement>(null)
  const seen = useSeen(ref)
  return (
    <video
      ref={ref}
      src={seen ? `${url}#t=0.1` : undefined}
      muted
      playsInline
      preload={seen ? 'metadata' : 'none'}
      className={className}
      aria-label={label}
    >
      <track kind="captions" />
    </video>
  )
}

const THUMB_SIZE = {
  /** The block's bottom row. */
  sm: 'size-8.5',
  /** Full screen. */
  md: 'size-14',
} as const

/**
 * The thumbnails of a viewer's history in one horizontal, scrolling row:
 * Show older first, then the latest entries (`stripStart` on), each a button
 * "Select image 3" numbered by its place in the whole history. The selected
 * one is marked and kept scrolled into view.
 */
export function MediaStrip({
  kind, urls, selectedIndex, onSelect, stripStart, hiddenOlder, onShowOlder, size = 'sm', className,
}: {
  kind: 'image' | 'video'
  urls: readonly string[]
  selectedIndex: number
  onSelect: (index: number) => void
  stripStart: number
  hiddenOlder: number
  onShowOlder: () => void
  size?: keyof typeof THUMB_SIZE
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Scroll only the strip itself (never its ancestors, such as the canvas).
    const strip = ref.current
    const thumb = strip?.querySelector<HTMLElement>('[aria-current="true"]')
    if (!strip || !thumb) return
    if (thumb.offsetLeft < strip.scrollLeft) strip.scrollLeft = thumb.offsetLeft
    else if (thumb.offsetLeft + thumb.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = thumb.offsetLeft + thumb.offsetWidth - strip.clientWidth
    }
  }, [selectedIndex, urls.length, stripStart])

  return (
    <div ref={ref} className={cn('relative flex items-center gap-1 overflow-x-auto py-0.5', className)}>
      <ShowOlderButton compact hidden={hiddenOlder} onClick={onShowOlder} />
      {urls.slice(stripStart).map((url, i) => {
        const idx = stripStart + i
        const active = idx === selectedIndex
        return (
          <button
            key={`${url}-${idx}`}
            type="button"
            onClick={() => onSelect(idx)}
            aria-label={`Select ${kind} ${idx + 1}`}
            aria-current={active ? 'true' : undefined}
            title={`${idx + 1}`}
            className={cn(
              'bg-muted shrink-0 overflow-hidden rounded border outline-none transition-colors',
              'focus-visible:ring-ring/50 focus-visible:ring-2',
              THUMB_SIZE[size],
              active ? 'border-foreground' : 'border-border/60 opacity-70 hover:border-border hover:opacity-100',
            )}
          >
            {kind === 'image' ? (
              // eslint-disable-next-line @next/next/no-img-element -- dynamic output URLs
              <img src={url} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
            ) : (
              <LazyVideoThumb url={url} label={`Video preview ${idx + 1}`} className="size-full object-cover" />
            )}
          </button>
        )
      })}
    </div>
  )
}
