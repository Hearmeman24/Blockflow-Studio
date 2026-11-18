'use client'

/**
 * Cost pieces for generation blocks:
 *
 * - `CostEstimateChip`: the pre-run estimate from the stored price table
 *   (`useCostEstimate`), as a small rounded chip with a tooltip (hover and
 *   keyboard focus, never stuck open after a click; see ChipTooltip)
 *   explaining the basis and where the price came from (`price_source`).
 * - `JobCostBadge`: a finished job's actual charge as reported by the
 *   provider (`job.cost`).
 *
 * `CostEstimateChip` shows a muted "No estimate" chip when the server said why
 * there is no estimate (`unavailable`), and nothing when no request was made.
 * `JobCostBadge` renders nothing without a cost.
 */
import { CircleSlash, Coins } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ChipTooltip } from '@/components/chip-tooltip'
import {
  formatAmount,
  formatJobCost,
  formatUsd,
  readJobCost,
  type CostEstimate,
  type EstimateUnavailable,
} from '@/lib/byok/cost'
import type { JobSnapshot } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface CostEstimateChipProps {
  estimate: CostEstimate | null | undefined
  /** Why there is no estimate (from `useCostEstimate`); shown only when `estimate` is empty. */
  unavailable?: EstimateUnavailable | null
  className?: string
  /** The selected provider's name, for "check <provider> for the actual cost". */
  providerName?: string
}

/** "Nov 14, 2026" in the viewer's locale; empty when the timestamp is unreadable. */
function shortDate(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

/** Where the estimate's unit price came from, in plain words (`price_source`). */
function priceOrigin(estimate: CostEstimate, providerName: string | undefined): string {
  const date = shortDate(estimate.price_updated_at)
  switch (estimate.price_source) {
    case 'observed':
      return `Based on what ${providerName || 'the provider'} charged for your last run of this model.`
    case 'ledger':
      return date ? `From the public price list, updated ${date}.` : 'From the public price list.'
    default:
      return date ? `From the price list shipped with this version, dated ${date}.` : 'From the price list shipped with this version.'
  }
}

const AFTER_RUN_SERVER = /\s*The actual charge will be shown after the run\.?\s*$/

/** The muted "No estimate" chip; its tooltip gives the server's reason. */
function NoEstimateChip({ unavailable, className }: { unavailable: EstimateUnavailable; className?: string }) {
  const reason = unavailable.message.replace(AFTER_RUN_SERVER, '').trim()
  return (
    <ChipTooltip
      side="top"
      contentClassName="max-w-72 space-y-1 text-left"
      tip={(
        <>
          <p className="font-medium">No cost estimate for this request.</p>
          <p>{reason}</p>
          <p className="opacity-80">The actual cost is shown in the output viewer after the run.</p>
        </>
      )}
    >
      <Button
        type="button"
        variant="outline"
        size="xs"
        aria-label={`No cost estimate: ${reason}`}
        data-testid="cost-unavailable-chip"
        data-code={unavailable.code}
        className={cn(
          'text-muted-foreground/80 h-5 cursor-help gap-1 rounded-full border-dashed px-1.5 text-3xs font-medium',
          'hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 transition-colors motion-reduce:transition-none',
          className,
        )}
      >
        <CircleSlash aria-hidden className="size-3" />
        No estimate
      </Button>
    </ChipTooltip>
  )
}

export function CostEstimateChip({ estimate, unavailable, className, providerName }: CostEstimateChipProps) {
  if (!estimate) return unavailable ? <NoEstimateChip unavailable={unavailable} className={className} /> : null
  const partial = estimate.confidence === 'partial'
  const amount = formatAmount(estimate.amount, estimate.unit)
  const text = `${partial ? '≥' : '≈'} ${amount}`
  const usd = estimate.unit !== 'usd' && typeof estimate.usd_equivalent === 'number'
    ? ` ≈ ${formatUsd(estimate.usd_equivalent)}`
    : ''
  return (
    <ChipTooltip
      side="top"
      contentClassName="max-w-72 space-y-1 text-left"
      tip={(
        <>
          <p className="font-medium">
            Estimated cost. Provider prices can change, so check {providerName || 'the provider'} for the actual cost.
          </p>
          <p>
            {text}
            {usd}
            {estimate.basis ? ` · ${estimate.basis}` : ''}
          </p>
          {partial && <p>A lower bound: part of this request&apos;s price is not fully listed.</p>}
          {estimate.price_source
            ? <p className="opacity-80">{priceOrigin(estimate, providerName)}</p>
            : estimate.as_of && <p className="opacity-80">Prices as of {estimate.as_of}</p>}
        </>
      )}
    >
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-label={`Estimated cost ${partial ? 'at least' : '≈'} ${amount}`}
            data-testid="cost-estimate-chip"
            className={cn(
              'text-muted-foreground h-5 cursor-help gap-1 rounded-full px-1.5 text-3xs font-medium tabular-nums',
              'hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 transition-colors motion-reduce:transition-none',
              className,
            )}
          >
            <Coins aria-hidden className="size-3" />
            {text}
          </Button>
    </ChipTooltip>
  )
}

export interface JobCostBadgeProps {
  job: Pick<JobSnapshot, 'cost'>
  className?: string
}

export function JobCostBadge({ job, className }: JobCostBadgeProps) {
  const cost = readJobCost(job.cost)
  if (!cost) return null
  const text = cost.amount === 0 ? `Not charged (${formatAmount(0, cost.unit)})` : `Cost: ${formatJobCost(cost)}`
  return (
    <span
      data-testid="job-cost-badge"
      title="Charge reported by the provider for this run"
      className={cn('text-muted-foreground inline-flex items-center gap-1 text-3xs tabular-nums', className)}
    >
      <Coins aria-hidden className="size-3" />
      {text}
    </span>
  )
}
