'use client'

/**
 * The full-screen view of the Image and Video Viewer (the pop-out): a Dialog
 * over the whole app with the selected output as large as the viewport allows
 * at its own aspect ratio, previous and next buttons, the same thumbnails
 * underneath, Download and Close at the top, and the file name and cost.
 *
 * It has no selection of its own: browsing calls the viewer's `onSelect`, so
 * closing leaves the block on the last item viewed. Open or closed is the
 * only state it adds (a boolean, owned by the viewer, which also holds the
 * trigger so Radix returns focus to it on close). Esc closes, Left and Right
 * browse, focus is trapped while open.
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { OutputCostLabel, PriceMismatchBadge } from '@/components/byok/output-cost'
import { DownloadButton, downloadFileName } from '@/components/pipeline/download-button'
import { MediaStrip } from '@/components/pipeline/viewer-strip'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import type { GenerationMeta } from '@/lib/image-ref'
import { DEFAULT_MEDIA_RATIO, mediaRatio } from '@/lib/media-ratio'

/** The index `delta` steps from `from`, kept within a list of `length` (no wrap-around). */
export function stepSelection(from: number, delta: number, length: number): number {
  if (length <= 0) return 0
  const clamp = (i: number) => Math.min(length - 1, Math.max(0, i))
  return clamp(clamp(from) + delta)
}

/** Where the in-block video was when the full-screen view opened, so it carries on from there. */
export interface VideoResume {
  url: string
  time: number
  playing: boolean
}

export interface MediaLightboxProps {
  kind: 'image' | 'video'
  urls: readonly string[]
  selectedIndex: number
  onSelect: (index: number) => void
  stripStart: number
  hiddenOlder: number
  onShowOlder: () => void
  metaByUrl: ReadonlyMap<string, GenerationMeta>
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The button that opens it; focus returns to it on close. */
  trigger: ReactNode
  resume?: VideoResume | null
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function MediaLightbox({
  kind, urls, selectedIndex, onSelect, stripStart, hiddenOlder, onShowOlder, metaByUrl, open, onOpenChange, trigger, resume,
}: MediaLightboxProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const [ratio, setRatio] = useState(DEFAULT_MEDIA_RATIO)
  const onSize = (width: number, height: number) => {
    const next = mediaRatio(width, height)
    if (next !== null) setRatio(next)
  }
  const total = urls.length
  const url = urls[selectedIndex] ?? ''
  const position = selectedIndex + 1
  const meta = metaByUrl.get(url)
  const outputsOfJob = meta ? urls.filter((u) => metaByUrl.get(u)?.job_id === meta.job_id).length : 1
  const step = (delta: number) => onSelect(stepSelection(selectedIndex, delta, total))

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    // Arrow keys on a focused video seek it; leave them to the player.
    if (event.target instanceof HTMLMediaElement) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      step(-1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      step(1)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          closeRef.current?.focus()
        }}
        onKeyDown={onKeyDown}
        className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-3 rounded-none border-0 p-3 sm:max-w-none sm:p-4"
      >
        <div className="flex min-w-0 items-center gap-2">
          <DialogTitle className="sr-only">{`${capitalize(kind)} ${position} of ${total}`}</DialogTitle>
          {total > 1 && (
            <span aria-hidden className="text-muted-foreground text-2xs tabular-nums">{position} / {total}</span>
          )}
          <div className="flex-1" />
          <DownloadButton url={url} className="w-auto" />
          <DialogClose asChild>
            <Button ref={closeRef} type="button" variant="ghost" size="icon-sm" aria-label="Close" title="Close (Esc)">
              <X aria-hidden />
            </Button>
          </DialogClose>
        </div>

        <div className="flex min-h-0 flex-1 items-center gap-2">
          {total > 1 && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="rounded-full"
              aria-label={`Previous ${kind}`}
              disabled={selectedIndex <= 0}
              onClick={() => step(-1)}
            >
              <ChevronLeft aria-hidden />
            </Button>
          )}
          {/* A size container, so the frame can be as large as the free space allows at the media's ratio. */}
          <div
            data-testid="lightbox-media"
            className="flex min-h-0 min-w-0 flex-1 items-center justify-center self-stretch [container-type:size]"
          >
            <div
              data-testid="lightbox-frame"
              style={{ '--media-ratio': ratio } as React.CSSProperties}
              className="aspect-(--media-ratio) w-[min(100cqw,calc(100cqh*var(--media-ratio)))] overflow-hidden rounded-md"
            >
              {kind === 'image' ? (
                // eslint-disable-next-line @next/next/no-img-element -- dynamic output URLs
                <img
                  key={url}
                  src={url}
                  alt={`Generated image ${position}`}
                  className="size-full object-contain"
                  onLoad={(e) => onSize(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
                />
              ) : (
                <video
                  key={url}
                  src={url}
                  controls
                  playsInline
                  autoPlay={resume?.url === url && resume.playing}
                  aria-label={`Generated video ${position}`}
                  className="size-full object-contain"
                  onLoadedMetadata={(event) => {
                    onSize(event.currentTarget.videoWidth, event.currentTarget.videoHeight)
                    if (resume?.url === url && resume.time > 0) event.currentTarget.currentTime = resume.time
                  }}
                >
                  <track kind="captions" />
                </video>
              )}
            </div>
          </div>
          {total > 1 && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="rounded-full"
              aria-label={`Next ${kind}`}
              disabled={selectedIndex >= total - 1}
              onClick={() => step(1)}
            >
              <ChevronRight aria-hidden />
            </Button>
          )}
        </div>

        <DialogDescription asChild>
          <div className="text-muted-foreground flex min-w-0 items-center justify-center gap-1 text-2xs">
            <span className="min-w-0 truncate" title={url}>{downloadFileName(url)}</span>
            <OutputCostLabel meta={meta} outputsOfJob={outputsOfJob} />
            <PriceMismatchBadge meta={meta} />
          </div>
        </DialogDescription>

        {total > 1 && (
          <MediaStrip
            kind={kind}
            size="md"
            urls={urls}
            selectedIndex={selectedIndex}
            onSelect={onSelect}
            stripStart={stripStart}
            hiddenOlder={hiddenOlder}
            onShowOlder={onShowOlder}
            className="mx-auto w-fit max-w-full shrink-0"
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
