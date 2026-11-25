'use client'

/**
 * The body of the Image and Video Viewer, built around the output:
 *
 * - The media spans the block at its own aspect ratio: the frame takes the
 *   ratio of the loaded media (`--media-ratio`), and its width is capped so
 *   its height stays within `MAX_FRAME_HEIGHT` (a tall portrait output is
 *   narrower, never a thin strip in a tall box).
 * - On the media: the "n / N" counter and "Previous run" (top left), and the
 *   "Open full screen" button (top right), which opens `MediaLightbox`.
 * - One thin bottom row (a `BlockFooter`): the earlier outputs as small
 *   thumbnails (`MediaStrip`), the cost, Clear, and an icon Download link
 *   whose tooltip is the file path.
 *
 * The selection is `useViewerHistory`'s, shared with the full-screen view. A
 * video in the block pauses when the full-screen view opens, which carries on
 * from the same point.
 */
import { useRef, useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { OutputCostLabel, PriceMismatchBadge } from '@/components/byok/output-cost'
import { BlockFooter } from '@/components/pipeline/block-footer'
import { DownloadButton } from '@/components/pipeline/download-button'
import { MediaLightbox, type VideoResume } from '@/components/pipeline/media-lightbox'
import { MediaStrip } from '@/components/pipeline/viewer-strip'
import { Button } from '@/components/ui/button'
import type { GenerationMeta } from '@/lib/image-ref'
import { DEFAULT_MEDIA_RATIO, mediaRatio } from '@/lib/media-ratio'
import type { ViewerHistory } from '@/lib/use-viewer-history'
import { cn } from '@/lib/utils'

export type MediaKind = 'image' | 'video'

/**
 * The frame: as wide as the block, and as tall as the ratio makes it up to
 * 28rem (448 px); a taller item gets narrower instead. Written as one class
 * so the cap lives in one place.
 */
const FRAME_SIZE = 'aspect-(--media-ratio) w-[min(100%,calc(28rem*var(--media-ratio)))]'

export interface MediaViewerProps {
  kind: MediaKind
  viewer: ViewerHistory
  metaByUrl: ReadonlyMap<string, GenerationMeta>
  /** The output shown is from an earlier run (dimmed, marked "Previous run"). */
  stale: boolean
}

export function MediaViewer({ kind, viewer, metaByUrl, stale }: MediaViewerProps) {
  const { history, displayUrls, selectedIndex, select, clear, stripStart, hiddenOlder, showOlder } = viewer
  const [ratio, setRatio] = useState(DEFAULT_MEDIA_RATIO)
  const [open, setOpen] = useState(false)
  const [resume, setResume] = useState<VideoResume | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  if (displayUrls.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Waiting for {kind} input…</p>
      </div>
    )
  }

  const url = displayUrls[selectedIndex]
  const position = selectedIndex + 1
  const total = displayUrls.length
  const meta = metaByUrl.get(url)
  const outputsOfJob = meta ? displayUrls.filter((u) => metaByUrl.get(u)?.job_id === meta.job_id).length : 1
  const onSize = (width: number, height: number) => {
    const next = mediaRatio(width, height)
    if (next !== null) setRatio(next)
  }

  const onOpenChange = (next: boolean) => {
    const video = videoRef.current
    if (next && video) {
      // One copy plays at a time: the full-screen one carries on from here.
      setResume({ url, time: video.currentTime, playing: !video.paused })
      video.pause()
    }
    setOpen(next)
  }

  return (
    <div data-viewer-root className={cn('transition-opacity duration-300', stale && 'opacity-40')}>
      <div
        data-testid="media-frame"
        style={{ '--media-ratio': ratio } as React.CSSProperties}
        className={cn('bg-muted relative mx-auto shrink-0 overflow-hidden rounded-md', FRAME_SIZE)}
      >
        {kind === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element -- dynamic output URLs
          <img
            src={url}
            alt={`Generated image ${position}`}
            className="size-full object-contain"
            onLoad={(e) => onSize(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
          />
        ) : (
          <video
            ref={videoRef}
            src={`${url}#t=0.1`}
            controls
            playsInline
            preload="metadata"
            aria-label={`Generated video ${position}`}
            className="size-full object-contain"
            onLoadedMetadata={(e) => onSize(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
          >
            <track kind="captions" />
          </video>
        )}

        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-1.5">
          <div className="flex items-center gap-1">
            {total > 1 && (
              <span
                data-testid="viewer-counter"
                className="bg-background/80 text-foreground rounded px-1.5 py-0.5 text-3xs font-medium tabular-nums"
              >
                {position} / {total}
              </span>
            )}
            {stale && (
              <span className="bg-background/80 text-warning rounded px-1.5 py-0.5 text-3xs font-medium">Previous run</span>
            )}
          </div>
          <MediaLightbox
            kind={kind}
            urls={displayUrls}
            selectedIndex={selectedIndex}
            onSelect={select}
            stripStart={stripStart}
            hiddenOlder={hiddenOlder}
            onShowOlder={showOlder}
            metaByUrl={metaByUrl}
            open={open}
            onOpenChange={onOpenChange}
            resume={resume}
            trigger={
              <Button
                type="button"
                variant="secondary"
                size="icon-xs"
                className="bg-background/80 hover:bg-background pointer-events-auto"
                aria-label="Open full screen"
                title="Open full screen"
              >
                <Maximize2 aria-hidden />
              </Button>
            }
          />
        </div>
      </div>

      <BlockFooter testId="viewer-footer">
        {total > 1 ? (
          <MediaStrip
            kind={kind}
            urls={displayUrls}
            selectedIndex={selectedIndex}
            onSelect={select}
            stripStart={stripStart}
            hiddenOlder={hiddenOlder}
            onShowOlder={showOlder}
            className="min-w-0 flex-1"
          />
        ) : (
          <div className="flex-1" />
        )}
        <OutputCostLabel meta={meta} outputsOfJob={outputsOfJob} />
        <PriceMismatchBadge meta={meta} />
        {history.length > 1 && (
          <Button type="button" variant="ghost" size="xs" className="text-muted-foreground shrink-0 px-1.5 text-3xs" onClick={clear}>
            Clear
          </Button>
        )}
        <DownloadButton url={url} iconOnly />
      </BlockFooter>
    </div>
  )
}
