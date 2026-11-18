'use client'

/**
 * Tooltips for small controls (setting chips, footer info buttons) that never
 * get stuck open. A tip opens on pointer hover and on keyboard focus only; it
 * does not open from focus caused by a click, nor from focus returning to the
 * control after its menu or popover closes. It closes on pointer leave, blur,
 * pointer down, Escape, and while the control's own menu or popover is open.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

// Last input modality in the document: focus counts as "keyboard focus" only
// when the most recent input was a key press (`:focus-visible` semantics).
let lastInput: 'keyboard' | 'pointer' = 'pointer'
let listening = false
function trackModality() {
  if (listening || typeof document === 'undefined') return
  listening = true
  document.addEventListener('keydown', () => { lastInput = 'keyboard' }, true)
  document.addEventListener('pointerdown', () => { lastInput = 'pointer' }, true)
  document.addEventListener('mousedown', () => { lastInput = 'pointer' }, true)
}
// Start at module load: an effect-only start missed key presses after a hot reload,
// so keyboard focus did not show the tip until the page was reloaded.
trackModality()

/** True when the latest input was a key press, so a focus now is keyboard focus. Starts tracking on first call. */
export function isKeyboardFocus(): boolean {
  trackModality()
  return lastInput === 'keyboard'
}

/**
 * Open/close state for a hover-or-keyboard-focus surface. `suppressed` is
 * true while the control's own menu or popover is open; the focus that comes
 * back to the control when it closes is ignored.
 */
export function useKeyboardHint(suppressed = false) {
  const [open, setOpen] = useState(false)
  const ignoreFocus = useRef(false)
  const wasSuppressed = useRef(suppressed)
  useEffect(() => {
    trackModality()
  }, [])
  useEffect(() => {
    if (wasSuppressed.current && !suppressed) {
      // The menu just closed: the focus return that follows is not a request for the tip.
      ignoreFocus.current = true
      const timer = setTimeout(() => { ignoreFocus.current = false }, 300)
      wasSuppressed.current = suppressed
      return () => clearTimeout(timer)
    }
    wasSuppressed.current = suppressed
  }, [suppressed])

  return {
    open: open && !suppressed,
    close: () => setOpen(false),
    handlers: {
      onPointerEnter: () => {
        if (!suppressed) setOpen(true)
      },
      onPointerLeave: () => setOpen(false),
      // Radix opens tooltips itself on pointer move (after its delay) and on focus.
      // That second, internal "open" broadcasts its tooltip-open event, which made an
      // already-open tip close itself about 300 ms after the pointer arrived. This
      // hook owns opening, so Radix's handlers are skipped (they honour defaultPrevented).
      onPointerMove: (e: { preventDefault: () => void }) => e.preventDefault(),
      onPointerDown: () => setOpen(false),
      onFocus: (e: { preventDefault: () => void }) => {
        e.preventDefault()
        if (ignoreFocus.current) {
          ignoreFocus.current = false
          return
        }
        if (lastInput === 'keyboard' && !suppressed) setOpen(true)
      },
      onBlur: () => setOpen(false),
      onKeyDown: (e: { key: string }) => {
        if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') setOpen(false)
      },
    },
  }
}

/** A tooltip on one control. `suppressed` = the control's menu or popover is open. */
export function ChipTooltip({
  tip,
  suppressed = false,
  side,
  contentClassName,
  children,
}: {
  tip: ReactNode
  suppressed?: boolean
  side?: 'top' | 'right' | 'bottom' | 'left'
  contentClassName?: string
  children: ReactNode
}) {
  const hint = useKeyboardHint(suppressed)
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip open={hint.open} onOpenChange={(next) => { if (!next) hint.close() }}>
        <TooltipTrigger asChild {...hint.handlers}>{children}</TooltipTrigger>
        <TooltipContent side={side} className={contentClassName ?? 'max-w-64'}>{tip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** "Output resolution", or the name and a description that adds something, on two lines. */
export function settingTip(name: string, description: string): ReactNode {
  const full = description.trim()
  const short = full.replace(/\.$/, '')
  if (!short) return name
  if (short.toLowerCase().includes(name.toLowerCase())) return short
  return (
    <>
      <span className="block font-medium">{name}</span>
      <span className="block">{full}</span>
    </>
  )
}
