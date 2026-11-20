'use client'

import { Zap } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { LipsIcon } from './lips-icon'

/** Accessible description for NSFW models. It must not suggest anything is allowed. */
export const NSFW_DESCRIPTION = 'NSFW. Provider content rules still apply.'

/** Accessible description for fast models. */
export const FAST_DESCRIPTION = 'Fast. Generates quicker than the standard model.'

/** The fast marker on its own: a bolt plus screen-reader text, with a tooltip on hover and keyboard focus. */
export function FastBadge({ className }: { className?: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-slot="fast-badge"
            data-fast=""
            tabIndex={0}
            className={cn(
              'text-fast focus-visible:ring-ring/50 inline-flex items-center rounded-sm outline-none focus-visible:ring-[3px]',
              className,
            )}
          >
            <Zap className="size-3.5" aria-hidden="true" />
            <span className="sr-only">Fast</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p className="font-medium">Fast</p>
          <p>Generates quicker than the standard model.</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * The NSFW marker on its own: lips icon plus screen-reader text, with a
 * tooltip on hover and keyboard focus. Never colour alone.
 */
export function NsfwBadge({ className }: { className?: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-slot="nsfw-badge"
            tabIndex={0}
            className={cn(
              'text-nsfw focus-visible:ring-ring/50 inline-flex items-center rounded-sm outline-none focus-visible:ring-[3px]',
              className,
            )}
          >
            <LipsIcon />
            <span className="sr-only">NSFW</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p className="font-medium">NSFW</p>
          <p>Provider content rules still apply.</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * A model's display name. NSFW models get the `--nsfw` colour, the lips icon
 * and "NSFW" screen-reader text. Fast models get a `--fast` bolt after the
 * name (after the lips when both) with "Fast" screen-reader text; the name
 * keeps its own colour. Use `interactive` where the name stands on
 * its own; inside an option or a trigger (which take focus themselves) keep it
 * non-interactive and put `NSFW_DESCRIPTION` / `FAST_DESCRIPTION` on the focusable element.
 */
export function ModelName({
  name,
  nsfw,
  fast = false,
  interactive = false,
  className,
}: {
  name: string
  nsfw: boolean
  fast?: boolean
  interactive?: boolean
  className?: string
}) {
  if (!nsfw && !fast) return <span className={cn('min-w-0 truncate', className)}>{name}</span>
  const bolt = fast ? (
    interactive ? (
      <FastBadge />
    ) : (
      <span data-fast="" className="text-fast inline-flex items-center" title={FAST_DESCRIPTION}>
        <Zap className="size-3.5" aria-hidden="true" />
        <span className="sr-only">Fast</span>
      </span>
    )
  ) : null
  const label = nsfw ? (
    <span data-nsfw="" className="text-nsfw inline-flex min-w-0 items-center gap-1">
      <span className="min-w-0 truncate">{name}</span>
      {interactive ? (
        <NsfwBadge />
      ) : (
        <span className="inline-flex items-center" title={NSFW_DESCRIPTION}>
          <LipsIcon />
          <span className="sr-only">NSFW</span>
        </span>
      )}
    </span>
  ) : (
    <span className="min-w-0 truncate">{name}</span>
  )
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      {label}
      {bolt}
    </span>
  )
}
