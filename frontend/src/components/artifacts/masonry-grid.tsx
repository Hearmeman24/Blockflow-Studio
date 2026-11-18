'use client'

/**
 * A masonry gallery: tiles keep their aspect ratio and are packed into the
 * shortest column (lib/artifacts/masonry.ts). Columns follow the container
 * width. New tiles fade in from a blur with a short stagger; existing tiles
 * glide to their new place when the width or the item list changes. With
 * reduced motion there is no entrance animation and no gliding.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { columnCountFor, layoutMasonry, type MasonryTile } from '@/lib/artifacts/masonry'
import { usePrefersReducedMotion } from '@/lib/use-reduced-motion'
import { cn } from '@/lib/utils'

export interface MasonryItem {
  key: string
  /** Width / height to reserve until the tile reports its real one. */
  aspect: number
  render: (ctx: { reportAspect: (aspect: number) => void }) => ReactNode
}

export function MasonryGrid({ items, label, className }: { items: readonly MasonryItem[]; label: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [measured, setMeasured] = useState<Readonly<Record<string, number>>>({})
  // Tiles glide only after the first real layout, so a freshly mounted grid
  // (first load, a filter change) does not animate them from zero size.
  const [settled, setSettled] = useState(false)
  const reduced = usePrefersReducedMotion()

  useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === 'undefined') return
    let frame = 0
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const w = Math.round(entry.contentRect.width)
      setWidth(w)
      if (w > 0 && !frame) frame = requestAnimationFrame(() => setSettled(true))
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])

  const report = useCallback((key: string, aspect: number) => {
    if (!Number.isFinite(aspect) || aspect <= 0) return
    setMeasured((m) => (m[key] !== undefined && Math.abs(m[key] - aspect) < 0.001 ? m : { ...m, [key]: aspect }))
  }, [])

  const aspects = items.map((item) => measured[item.key] ?? item.aspect)
  const aspectKey = aspects.join(',')
  const layout = useMemo(
    () => layoutMasonry(aspectKey ? aspectKey.split(',').map(Number) : [], columnCountFor(width), width),
    [aspectKey, width],
  )

  return (
    <div
      ref={ref}
      role="list"
      aria-label={label}
      className={cn('relative w-full', className)}
      // The container's height is the tallest column, known only after layout.
      style={{ height: layout.height }}
    >
      {items.map((item, index) => (
        <MasonryCell key={item.key} tile={layout.tiles[index]} index={index} reduced={reduced} glide={settled && !reduced}>
          {item.render({ reportAspect: (aspect) => report(item.key, aspect) })}
        </MasonryCell>
      ))}
    </div>
  )
}

function MasonryCell({ tile, index, reduced, glide, children }: { tile: MasonryTile; index: number; reduced: boolean; glide: boolean; children: ReactNode }) {
  const [entered, setEntered] = useState(reduced)
  useEffect(() => {
    if (entered) return
    // Enter after the hidden state has painted. Animation frames pause in a
    // background tab, so a timer makes sure tiles never stay hidden.
    const enter = () => setEntered(true)
    const frame = requestAnimationFrame(enter)
    const timer = setTimeout(enter, 150)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [entered])
  const shown = entered || reduced
  return (
    <div
      role="listitem"
      data-masonry-cell=""
      className={cn(
        'absolute left-0 top-0',
        glide && 'motion-safe:transition-[transform,width,height] motion-safe:duration-500 motion-safe:ease-out',
      )}
      // Position and size come from the masonry layout at run time.
      style={{ transform: `translate3d(${tile.x}px, ${tile.y}px, 0)`, width: tile.width, height: tile.height }}
    >
      <div
        data-masonry-enter=""
        data-entered={shown}
        className={cn(
          'size-full',
          !reduced && 'motion-safe:transition-[opacity,filter,translate] motion-safe:duration-700 motion-safe:ease-out',
          !shown && 'translate-y-6 opacity-0 blur-md',
        )}
        // Stagger: each new tile starts a little after the previous one.
        style={reduced ? undefined : { transitionDelay: `${Math.min(index, 12) * 40}ms` }}
      >
        {children}
      </div>
    </div>
  )
}
