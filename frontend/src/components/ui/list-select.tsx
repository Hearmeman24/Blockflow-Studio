'use client'

/**
 * A single-value select built on the Vercel UI SDK (`@ui-sdk/react/select`),
 * styled with the app tokens to match `components/ui/select.tsx`.
 *
 * It exists for one behaviour the Radix select lacks: options that are
 * unavailable but still reachable. An item with `unavailableReason` stays in
 * the keyboard order (arrow keys and typeahead reach it, so the reason can be
 * read), is exposed with `aria-disabled="true"` plus `aria-description`, and
 * cannot be chosen by click, Enter, Space or typeahead: the root refuses the
 * change through the SDK's cancellable change details and keeps the list open.
 * The SDK's own `disabled` items are skipped by the keyboard, which would hide
 * the reason from keyboard and screen-reader users.
 */
import * as React from 'react'
import { CheckIcon, ChevronDownIcon } from 'lucide-react'
import {
  Select as SelectPrimitive,
  SelectContent as SelectContentPrimitive,
  SelectItem as SelectItemPrimitive,
  SelectItemIndicator,
  SelectTrigger as SelectTriggerPrimitive,
  SelectValue as SelectValuePrimitive,
} from '@ui-sdk/react/select'
import { cn } from '@/lib/utils'

interface ListSelectProps {
  value: string | null
  onValueChange: (value: string) => void
  /** Values that are listed but cannot be chosen. */
  isValueUnavailable?: (value: string) => boolean
  placeholder?: string
  disabled?: boolean
  children: React.ReactNode
}

function ListSelect({ value, onValueChange, isValueUnavailable, placeholder, disabled, children }: ListSelectProps) {
  // Set when a press on an unavailable item was refused, so the close that
  // the same press requests is refused too and the list stays open.
  const refusedPress = React.useRef(false)
  return (
    <SelectPrimitive<string>
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onValueChange={(next, details) => {
        if (next === null || isValueUnavailable?.(next)) {
          refusedPress.current = details.reason === 'item-press'
          details.cancel()
          return
        }
        onValueChange(next)
      }}
      onOpenChange={(open, details) => {
        if (!open && details.reason === 'item-press' && refusedPress.current) {
          refusedPress.current = false
          details.cancel()
        }
      }}
    >
      {children}
    </SelectPrimitive>
  )
}

function ListSelectTrigger({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof SelectTriggerPrimitive>, 'children'> & { children?: React.ReactNode }) {
  return (
    <SelectTriggerPrimitive
      className={cn(
        'border-input data-placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50 flex h-7 w-full min-w-0 items-center justify-between gap-2 rounded-md border bg-transparent px-2.5 text-xs shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] data-disabled:cursor-not-allowed data-disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left">{children}</span>
      <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 opacity-50" />
    </SelectTriggerPrimitive>
  )
}

const ListSelectValue = SelectValuePrimitive

function ListSelectContent({ className, ...props }: React.ComponentProps<typeof SelectContentPrimitive>) {
  return (
    <SelectContentPrimitive
      sideOffset={4}
      className={cn(
        'bg-popover text-popover-foreground min-w-(--anchor-width) max-h-(--available-height) overflow-y-auto rounded-md border p-1 shadow-md',
        className,
      )}
      {...props}
    />
  )
}

interface ListSelectItemProps extends Omit<React.ComponentProps<typeof SelectItemPrimitive>, 'disabled' | 'value' | 'children'> {
  value: string
  children?: React.ReactNode
  /** Why this option cannot be chosen. The option stays focusable and announces it. */
  unavailableReason?: string | null
}

function ListSelectItem({ className, children, unavailableReason, ...props }: ListSelectItemProps) {
  const unavailable = Boolean(unavailableReason)
  return (
    <SelectItemPrimitive
      className={cn(
        'relative flex w-full cursor-default items-start gap-2 rounded-sm py-1.5 pr-7 pl-2 text-xs outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-unavailable:cursor-not-allowed',
        className,
      )}
      {...(unavailable
        ? { 'aria-disabled': true, 'aria-description': unavailableReason ?? undefined, 'data-unavailable': '' }
        : {})}
      {...props}
    >
      <span className="min-w-0 flex-1">{children}</span>
      <SelectItemIndicator className="absolute top-2 right-2 flex size-3.5 items-center justify-center">
        <CheckIcon aria-hidden className="size-3.5" />
      </SelectItemIndicator>
    </SelectItemPrimitive>
  )
}

export { ListSelect, ListSelectContent, ListSelectItem, ListSelectTrigger, ListSelectValue }
