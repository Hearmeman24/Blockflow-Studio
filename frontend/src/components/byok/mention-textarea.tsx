'use client'

/**
 * A prompt textarea that colours the mentions of attached references by kind
 * ("Image1", "@video_1", "<Picture 2>"). A textarea cannot colour part of its
 * text, so a layer over it repeats the same text with coloured spans, and the
 * textarea's own glyphs are transparent. The textarea stays the real control:
 * value, caret, selection, placeholder, focus ring, keyboard, IME, spellcheck,
 * resizing and the accessible name are all its own. The layer is hidden from
 * assistive technology and takes no pointer input.
 *
 * Alignment: the layer copies the textarea's box, font and spacing from its
 * computed style (so a class change on the field cannot drift it), leaves room
 * for the textarea's scrollbar, and follows its scroll position.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ComponentProps, type Ref } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { kindAccent } from '@/lib/byok/kind-accent'
import { mentionSegments, type MentionTarget } from '@/lib/byok/mentions'
import { cn } from '@/lib/utils'

export interface MentionTextareaProps extends Omit<ComponentProps<'textarea'>, 'value'> {
  value: string
  /** The mentions to colour: those of the references attached right now. */
  mentions: readonly MentionTarget[]
  ref?: Ref<HTMLTextAreaElement>
}

/** Style properties that decide where each glyph lands. */
const COPIED = [
  'boxSizing',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingBottom', 'paddingLeft',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant', 'fontFeatureSettings',
  'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'tabSize', 'direction',
] as const

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export function MentionTextarea({ value, mentions, className, ref, onScroll, disabled, ...props }: MentionTextareaProps) {
  const area = useRef<HTMLTextAreaElement | null>(null)
  const layer = useRef<HTMLDivElement>(null)

  const setArea = useCallback((el: HTMLTextAreaElement | null) => {
    area.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) (ref as { current: HTMLTextAreaElement | null }).current = el
  }, [ref])

  const segments = useMemo(() => mentionSegments(value, mentions), [value, mentions])

  const syncScroll = useCallback(() => {
    const el = area.current
    const over = layer.current
    if (!el || !over) return
    over.scrollTop = el.scrollTop
    over.scrollLeft = el.scrollLeft
  }, [])

  /** Copy the textarea's metrics, and widen the right padding by its scrollbar, if any. */
  const syncBox = useCallback(() => {
    const el = area.current
    const over = layer.current
    if (!el || !over || typeof window.getComputedStyle !== 'function') return
    const style = window.getComputedStyle(el)
    for (const prop of COPIED) over.style[prop] = style[prop]
    const borders = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0)
    const scrollbar = Math.max(0, el.offsetWidth - el.clientWidth - borders)
    over.style.paddingRight = `${(parseFloat(style.paddingRight) || 0) + scrollbar}px`
    syncScroll()
  }, [syncScroll])

  // After every change of text: the scrollbar may have appeared, and the textarea may have scrolled.
  useIsoLayoutEffect(syncBox, [value, syncBox])

  // A drag on the resize grip or a narrower block changes the wrapping width.
  useEffect(() => {
    const el = area.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => syncBox())
    observer.observe(el)
    return () => observer.disconnect()
  }, [syncBox])

  return (
    <div className="relative min-w-0" data-slot="mention-textarea">
      <Textarea
        {...props}
        ref={setArea}
        value={value}
        disabled={disabled}
        onScroll={(e) => {
          syncScroll()
          onScroll?.(e)
        }}
        // The glyphs are drawn by the layer; the caret and the selection stay the textarea's.
        className={cn(className, 'text-transparent caret-foreground selection:bg-ring/40 selection:text-transparent')}
      />
      <div
        ref={layer}
        aria-hidden="true"
        data-testid="mention-highlight"
        className={cn(
          className,
          // Same box as the textarea, but nothing of its own to see or touch.
          'pointer-events-none absolute inset-0 m-0 overflow-hidden rounded-md border border-transparent px-3 py-2',
          'resize-none bg-transparent text-foreground break-words whitespace-pre-wrap shadow-none',
          disabled && 'opacity-50',
        )}
      >
        {segments.map((segment, i) => (segment.kind
          ? <span key={i} data-mention-kind={segment.kind} className={kindAccent(segment.kind).mention}>{segment.text}</span>
          : segment.text))}
        {/* A trailing new line needs something after it to take up its line, as in the textarea. */}
        {value.endsWith('\n') ? ' ' : null}
      </div>
    </div>
  )
}
