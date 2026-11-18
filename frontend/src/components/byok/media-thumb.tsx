'use client'

/**
 * The picture inside a square media tile: an image, a video poster that plays
 * on hover or focus, or a placeholder when there is no file to show. Used by
 * the loader blocks, the Characters page and the Load Character block. The
 * parent sizes it (it fills its box) and owns any overlays.
 */
import { useCallback, useRef, type ReactNode } from 'react'
import { CircleSlash, Loader2 } from 'lucide-react'

/**
 * Hover and focus playback for a video thumb. Bind `containerProps` to the tile
 * so hovering or focusing the tile's own controls keeps the video playing, and
 * pass the result to `MediaThumb` as `playback`.
 */
export function useThumbPlayback() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const play = useCallback(() => { void videoRef.current?.play()?.catch(() => undefined) }, [])
  const pause = useCallback(() => { videoRef.current?.pause() }, [])
  return {
    videoRef,
    play,
    pause,
    containerProps: { onMouseEnter: play, onMouseLeave: pause, onFocus: play, onBlur: pause },
  }
}

export type ThumbPlayback = ReturnType<typeof useThumbPlayback>

export interface MediaThumbProps {
  kind: 'image' | 'video'
  /** Omitted while saving, when broken, or when there is no file: the placeholder shows. */
  src?: string
  /** Alt text / accessible name of the media. */
  label: string
  /** Placeholder shows a spinner. */
  saving?: boolean
  /** Placeholder icon instead of the default. */
  placeholder?: ReactNode
  /** Hover playback owned by the parent tile; without it the video handles its own hover and focus. */
  playback?: ThumbPlayback
  /** Called with the video duration once its metadata loads. */
  onDuration?: (seconds: number) => void
}

export function MediaThumb({ kind, src, label, saving, placeholder, playback, onDuration }: MediaThumbProps) {
  const own = useThumbPlayback()
  const { videoRef, play, pause } = playback ?? own
  const hover = playback ? {} : own.containerProps
  if (!src) {
    return (
      <div data-testid="media-thumb-placeholder" className="text-muted-foreground flex size-full items-center justify-center" aria-hidden>
        {saving
          ? <Loader2 className="size-5 animate-spin motion-reduce:animate-none" />
          : placeholder ?? <CircleSlash className="size-5" />}
      </div>
    )
  }
  if (kind === 'image') {
    return (
      // Thumbnails of /outputs files; next/image cannot optimise them.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={label}
        loading="lazy"
        className="size-full object-cover transition-transform duration-200 group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100"
      />
    )
  }
  return (
    <video
      ref={videoRef}
      src={`${src}#t=0.1`}
      aria-label={label}
      muted
      loop
      playsInline
      preload="metadata"
      {...hover}
      onLoadedMetadata={(e) => { if (Number.isFinite(e.currentTarget.duration)) onDuration?.(e.currentTarget.duration) }}
      onClick={(e) => (e.currentTarget.paused ? play() : pause())}
      className="size-full object-cover"
    />
  )
}
