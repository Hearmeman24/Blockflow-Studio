'use client'

/**
 * A square card for one audio clip: a waveform across the top, and at the
 * bottom a play/pause button and the file name without its extension. The
 * star (default audio), move and remove controls reveal on hover, keyboard
 * focus and touch. Playback uses one hidden <audio> per tile; starting a tile pauses any
 * other tile that is playing.
 *
 * `overlay` is a control covering the tile under the others (the Load
 * Character block's selection toggle): it is a sibling of the play button,
 * never its ancestor, so no button is nested in another.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Pause, Play, Star, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { kindAccent } from '@/lib/byok/kind-accent'
import { useWaveform } from '@/lib/byok/waveform'
import { cn } from '@/lib/utils'
import { REVEAL } from './media-loader'

/** The tile that is playing now, so starting another can stop it. */
let active: { audio: HTMLAudioElement; stop: () => void } | null = null

/** "line 1.wav" → "line 1". A name that is only an extension is kept. */
export function soundLabel(label: string): string {
  const m = /^(.+)\.[A-Za-z0-9]{1,5}$/.exec(label)
  return m ? m[1] : label
}

export interface SoundTileProps {
  /** The file to play; omitted when it is missing (the play button is disabled). */
  src?: string
  /** The full file name. */
  label: string
  /** Skips decoding the waveform of very large files. */
  sizeBytes?: number | null
  star?: { label: string; pressed: boolean; onToggle: () => void }
  onRemove?: () => void
  onMove?: (delta: -1 | 1) => void
  first?: boolean
  last?: boolean
  /** Small badges in the top-left corner (default, order). */
  badges?: ReactNode
  /** A control covering the tile, under the play, star and reveal controls. */
  overlay?: ReactNode
  /** Under the square (a status strip). */
  footer?: ReactNode
  /** Fades the waveform and name (an unselected clip in the Load Character block). */
  dimmed?: boolean
  className?: string
}

export function SoundTile({
  src,
  label,
  sizeBytes,
  star,
  onRemove,
  onMove,
  first,
  last,
  badges,
  overlay,
  footer,
  dimmed,
  className,
}: SoundTileProps) {
  const accent = kindAccent('audio')
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const { peaks, ready } = useWaveform(src, { sizeBytes })
  const stop = useCallback(() => setPlaying(false), [])

  useEffect(() => {
    const audio = audioRef.current
    return () => {
      if (audio && active?.audio === audio) {
        audio.pause()
        active = null
      }
    }
  }, [src])

  const toggle = () => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
      setPlaying(false)
      if (active?.audio === audio) active = null
      return
    }
    if (active && active.audio !== audio) {
      active.audio.pause()
      active.stop()
    }
    active = { audio, stop }
    setPlaying(true)
    void Promise.resolve(audio.play()).catch(() => {
      setPlaying(false)
      if (active?.audio === audio) active = null
    })
  }

  const ended = () => {
    setPlaying(false)
    setProgress(0)
    if (active?.audio === audioRef.current) active = null
  }

  const short = soundLabel(label)
  const hasControls = Boolean(star || onRemove || onMove)

  return (
    <div
      className={cn(
        'group relative flex min-w-0 flex-col overflow-hidden rounded-xl border',
        accent.tile,
        'transition-shadow motion-reduce:transition-none hover:ring-2 hover:ring-ring/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
        className,
      )}
    >
      <div className="relative aspect-square min-w-0">
        {overlay && <div className="absolute inset-0">{overlay}</div>}

        <div
          data-testid="waveform"
          data-state={ready ? 'ready' : 'placeholder'}
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-x-3 top-8 bottom-12 flex items-center gap-0.5 transition-opacity motion-reduce:transition-none',
            dimmed && 'opacity-45 group-hover:opacity-75',
          )}
        >
          {peaks.map((p, i) => (
            <span
              key={i}
              data-testid="waveform-bar"
              className={cn(
                'min-w-px flex-1 rounded-full bg-current',
                playing && (i + 0.5) / peaks.length <= progress ? accent.wavePlayed : accent.wave,
              )}
              style={{ height: `${Math.max(6, Math.round(p * 100))}%` }}
            />
          ))}
        </div>

        {badges && (
          <div
            className={cn(
              'pointer-events-none absolute top-1.5 left-1.5 flex items-center gap-0.5',
              // The revealed controls take the whole top edge of a small tile; the pressed star then marks the default.
              hasControls && 'transition-opacity motion-reduce:transition-none group-hover:opacity-0 group-has-[:focus-visible]:opacity-0 pointer-coarse:opacity-0',
            )}
          >
            {badges}
          </div>
        )}

        {hasControls && (
          <div data-testid="tile-controls" className={cn('pointer-events-none absolute top-1.5 right-1.5 flex gap-0.5 [&>*]:pointer-events-auto', REVEAL)}>
            {star && (
              <Button
                type="button"
                variant="secondary"
                size="icon-xs"
                aria-label={star.label}
                aria-pressed={star.pressed}
                onClick={star.onToggle}
                className="shadow-sm"
              >
                <Star aria-hidden className={cn(star.pressed && 'text-warning fill-current')} />
              </Button>
            )}
            {onMove && (
              <>
                <Button type="button" variant="secondary" size="icon-xs" aria-label={`Move ${label} earlier`} disabled={first} onClick={() => onMove(-1)} className="shadow-sm">
                  <ArrowLeft aria-hidden />
                </Button>
                <Button type="button" variant="secondary" size="icon-xs" aria-label={`Move ${label} later`} disabled={last} onClick={() => onMove(1)} className="shadow-sm">
                  <ArrowRight aria-hidden />
                </Button>
              </>
            )}
            {onRemove && (
              <Button type="button" variant="secondary" size="icon-xs" aria-label={`Remove ${label}`} onClick={onRemove} className="shadow-sm">
                <X aria-hidden />
              </Button>
            )}
          </div>
        )}

        <div data-testid="tile-bar" className="pointer-events-none absolute inset-x-1.5 bottom-1.5 flex min-w-0 items-center gap-1.5">
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            aria-label={`${playing ? 'Pause' : 'Play'} ${label}`}
            aria-pressed={playing}
            disabled={!src}
            onClick={toggle}
            className="pointer-events-auto shrink-0 rounded-full shadow-sm"
          >
            {playing ? <Pause aria-hidden className="fill-current" /> : <Play aria-hidden className="fill-current" />}
          </Button>
          <span title={label} className={cn('min-w-0 flex-1 truncate text-2xs font-medium', dimmed && 'text-muted-foreground')}>
            {short}
          </span>
        </div>

        {src && (
          <audio
            ref={audioRef}
            src={src}
            aria-label={label}
            preload="none"
            onEnded={ended}
            onPause={stop}
            onTimeUpdate={(e) => {
              const { currentTime, duration } = e.currentTarget
              setProgress(Number.isFinite(duration) && duration > 0 ? currentTime / duration : 0)
            }}
            className="hidden"
          />
        )}
      </div>
      {footer}
    </div>
  )
}
