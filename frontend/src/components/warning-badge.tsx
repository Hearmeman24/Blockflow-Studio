'use client'

/**
 * Header warning badge: a small warning-coloured badge with an icon (and a
 * count when there is more than one) that opens a small panel listing each
 * non-blocking warning and its optional fix. Opens on hover, keyboard focus
 * or click; Enter/click moves focus into the panel; Escape closes it.
 * Errors that block a run do not belong here; they stay in the block body.
 */
import { useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isKeyboardFocus } from '@/components/chip-tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { BlockWarning } from '@/lib/pipeline/registry'
import { cn } from '@/lib/utils'

/** The first sentence of a warning, for the badge's accessible name. */
function headline(message: string): string {
  return message.split(/(?<=\.)\s/)[0].replace(/\.$/, '')
}

export interface WarningBadgeProps {
  warnings: readonly BlockWarning[]
  /** Short visible label next to the icon (e.g. "Price changed"), so the badge does not rely on icon and colour alone. */
  text?: string
  className?: string
}

export function WarningBadge({ warnings, text, className }: WarningBadgeProps) {
  const [open, setOpen] = useState(false)
  // 'preview' (hover or focus) keeps focus on the badge; 'pinned' (click or Enter) moves it into the panel.
  const mode = useRef<'preview' | 'pinned'>('preview')
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  // Focus that returns to the badge right after the panel closes is not a request to reopen it.
  const justClosed = useRef(false)
  if (warnings.length === 0) return null

  const count = warnings.length
  const label = `${count} ${count === 1 ? 'warning' : 'warnings'}: ${headline(warnings[0].message)}`
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const preview = () => {
    cancelClose()
    if (!open) {
      mode.current = 'preview'
      setOpen(true)
    }
  }
  const scheduleClose = () => {
    if (mode.current === 'pinned') return
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), 150)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          mode.current = 'preview'
          justClosed.current = true
          setTimeout(() => { justClosed.current = false }, 300)
        }
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={label}
          data-testid="warning-badge"
          onPointerEnter={preview}
          onPointerLeave={scheduleClose}
          onFocus={() => {
            // Hover and keyboard focus preview the panel; a click's focus does not.
            if (justClosed.current || !isKeyboardFocus()) return
            preview()
          }}
          onClick={(e) => {
            // Radix toggles on click; a click on an open preview pins it instead of closing it.
            if (open && mode.current === 'preview') {
              e.preventDefault()
              mode.current = 'pinned'
              panel.current?.querySelector<HTMLElement>('button, a')?.focus()
              return
            }
            mode.current = 'pinned'
          }}
          className={cn(
            'border-warning/50 bg-warning/10 text-warning h-5 gap-1 rounded-full px-1.5 text-3xs font-medium',
            'hover:bg-warning/20 hover:text-warning focus-visible:ring-warning/50 transition-colors motion-reduce:transition-none',
            className,
          )}
        >
          <AlertTriangle aria-hidden className="size-3" />
          {count > 1 && <span className="tabular-nums">{count}</span>}
          {text && <span>{text}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={panel}
        align="end"
        className="w-64 space-y-2 p-2.5"
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
        onOpenAutoFocus={(e) => {
          if (mode.current === 'preview') e.preventDefault()
        }}
        onCloseAutoFocus={(e) => {
          if (mode.current === 'preview') e.preventDefault()
        }}
      >
        <ul className="space-y-2" aria-label="Warnings">
          {warnings.map((w) => (
            <li key={w.id} className="flex items-start gap-1.5 text-xs">
              <AlertTriangle aria-hidden className="text-warning mt-0.5 size-3.5 shrink-0" />
              <div className="min-w-0 space-y-1.5">
                <p>{w.message}</p>
                {w.action && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => {
                      w.action!.onClick()
                      mode.current = 'preview'
                      setOpen(false)
                    }}
                  >
                    {w.action.label}
                  </Button>
                )}
                {w.link && (
                  <Button asChild variant="link" size="xs" className="text-link h-auto p-0">
                    <a href={w.link.href} target="_blank" rel="noopener noreferrer">{w.link.label}</a>
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
