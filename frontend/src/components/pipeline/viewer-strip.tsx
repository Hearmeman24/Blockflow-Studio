'use client'

/**
 * Shared parts of the viewer strips (Image, Video and Audio Viewer), which
 * render only the latest entries of their history (`useViewerHistory`'s
 * `stripStart`): the Show older control, and a video thumbnail that loads
 * nothing until it scrolls into view.
 */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { VIEWER_STRIP_PAGE } from '@/lib/use-viewer-history'

/** Reveals the next page of older entries; renders nothing when none are hidden. */
export function ShowOlderButton({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  if (hidden <= 0) return null
  return (
    <Button type="button" variant="ghost" size="xs" className="w-full" onClick={onClick}>
      Show older ({Math.min(hidden, VIEWER_STRIP_PAGE)} of {hidden})
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
export function LazyVideoThumb({ url, label }: { url: string; label: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const seen = useSeen(ref)
  return (
    <video
      ref={ref}
      src={seen ? `${url}#t=0.1` : undefined}
      muted
      playsInline
      preload={seen ? 'metadata' : 'none'}
      className="w-full bg-black/30"
      aria-label={label}
    >
      <track kind="captions" />
    </video>
  )
}
