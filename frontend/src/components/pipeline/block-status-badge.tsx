'use client'

import { Badge } from '@/components/ui/badge'
import type { BlockStatus } from '@/lib/pipeline/types'

/**
 * Each status's badge, and where it shows the block's status message:
 * `label` replaces the badge text (running, or an iterator's item count after
 * completing), `note` shows it in the block body (an idle block a reload found
 * interrupted), `none` hides it (an error shows its own text in the body).
 */
const STATUS_CONFIG: Record<BlockStatus, { label: string; className: string; message: 'label' | 'note' | 'none' }> = {
  idle: { label: 'Idle', className: 'bg-muted text-muted-foreground', message: 'note' },
  running: { label: 'Running', className: 'bg-blue-500/20 text-blue-400 animate-pulse', message: 'label' },
  completed: { label: 'Done', className: 'bg-green-500/20 text-green-400', message: 'label' },
  error: { label: 'Error', className: 'bg-red-500/20 text-red-400', message: 'none' },
  skipped: { label: 'Skipped', className: 'bg-muted text-muted-foreground/60', message: 'none' },
  // Neutral: the user stopped the run; nothing went wrong.
  cancelled: { label: 'Cancelled', className: 'bg-muted text-muted-foreground', message: 'none' },
}

export interface BlockStatusDisplay {
  /** The badge text. */
  label: string
  /** Text shown in the block body, or null. */
  note: string | null
}

export function blockStatusDisplay(status: BlockStatus, statusMessage: string | undefined): BlockStatusDisplay {
  const cfg = STATUS_CONFIG[status]
  const message = statusMessage || null
  return {
    label: cfg.message === 'label' && message ? message : cfg.label,
    note: cfg.message === 'note' ? message : null,
  }
}

interface BlockStatusBadgeProps {
  status: BlockStatus
  /** The block's status message; shown in the badge only for the statuses that show it there. */
  statusMessage?: string
}

export function BlockStatusBadge({ status, statusMessage }: BlockStatusBadgeProps) {
  const cfg = STATUS_CONFIG[status]
  const { label } = blockStatusDisplay(status, statusMessage)
  return (
    <Badge
      variant="outline"
      data-testid="block-status-badge"
      data-status={status}
      className={`text-[10px] px-1.5 py-0 ${cfg.className}`}
    >
      {label}
    </Badge>
  )
}
