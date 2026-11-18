'use client'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { LipsIcon } from './lips-icon'

/** Accessible description for NSFW models. It must not suggest anything is allowed. */
export const NSFW_DESCRIPTION = 'NSFW. Provider content rules still apply.'

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
 * and "NSFW" screen-reader text. Use `interactive` where the name stands on
 * its own; inside an option or a trigger (which take focus themselves) keep it
 * non-interactive and put `NSFW_DESCRIPTION` on the focusable element.
 */
export function ModelName({
  name,
  nsfw,
  interactive = false,
  className,
}: {
  name: string
  nsfw: boolean
  interactive?: boolean
  className?: string
}) {
  if (!nsfw) return <span className={cn('min-w-0 truncate', className)}>{name}</span>
  return (
    <span data-nsfw="" className={cn('text-nsfw inline-flex min-w-0 items-center gap-1', className)}>
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
  )
}
