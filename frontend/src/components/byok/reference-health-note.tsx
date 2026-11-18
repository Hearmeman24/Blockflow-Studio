import { AlertTriangle, HelpCircle, XCircle } from 'lucide-react'
import { HEALTH_LABEL, isBrokenStatus, type ReferenceHealth } from '@/lib/byok/reference-health'
import { cn } from '@/lib/utils'

/**
 * The health of one saved reference, as text with an icon (never colour
 * alone): broken references say why; provider assets say "not verified".
 * Renders nothing for a reference that was found.
 */
export function ReferenceHealthNote({ health, className }: { health: ReferenceHealth | undefined; className?: string }) {
  if (!health || health.status === 'ok') return null
  const broken = isBrokenStatus(health.status)
  const Icon = broken ? XCircle : HelpCircle
  return (
    <p
      data-testid="reference-health"
      data-status={health.status}
      className={cn('flex min-w-0 items-start gap-1 text-3xs', broken ? 'text-destructive' : 'text-muted-foreground', className)}
    >
      <Icon aria-hidden className="mt-px size-3 shrink-0" />
      <span className="min-w-0">
        <span className="font-medium">{broken ? `Broken: ${HEALTH_LABEL[health.status]}.` : `${HEALTH_LABEL[health.status]}.`}</span>
        {health.detail ? ` ${health.detail}` : ''}
      </span>
    </p>
  )
}

/** A limit or compatibility flag on one item, as text with an icon. */
export function ItemFlagNote({ label, reason, className }: { label: string; reason: string | null; className?: string }) {
  return (
    <p data-testid="item-flag" className={cn('flex min-w-0 items-start gap-1 text-3xs text-warning', className)}>
      <AlertTriangle aria-hidden className="mt-px size-3 shrink-0" />
      <span className="min-w-0">
        <span className="font-medium">{label}.</span>
        {reason ? ` ${reason}` : ''}
      </span>
    </p>
  )
}
