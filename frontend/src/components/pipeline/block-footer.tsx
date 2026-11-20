import type { ReactNode } from 'react'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

/**
 * A block's bottom metadata strip: a divider and one muted line. The block
 * body makes the block's root a full-height flex column with the standard gap
 * (block-card.tsx), so `mt-auto` pins this to the bottom edge of the card
 * whatever the card height, when it is a top-level item of the block.
 */
export function BlockFooter({ children, className, testId, actions }: {
  children: ReactNode
  className?: string
  testId?: string
  /** Optional action (for example a Download button), rendered directly above the divider. */
  actions?: ReactNode
}) {
  return (
    <div data-slot="block-footer" className={cn('mt-auto space-y-1.5', className)}>
      {actions}
      <Separator />
      <div data-testid={testId} className="text-muted-foreground flex min-w-0 items-center gap-1 text-3xs">
        {children}
      </div>
    </div>
  )
}
