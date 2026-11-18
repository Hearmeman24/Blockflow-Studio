/**
 * Credits and cost: response types for `/api/providers/balances` and
 * `/api/generation/estimate`, plus the display formatting shared by the
 * credits panel and the cost chips.
 */
import type { BalanceStatus } from '@/lib/status'
import type { JobCost, PriceCheck } from '@/lib/types'

export const BALANCES_URL = '/api/providers/balances'
export const ESTIMATE_URL = '/api/generation/estimate'

// Declared in `@/lib/status`; re-exported for existing imports.
export type { BalanceStatus }

export interface ProviderBalance {
  provider: string
  label: string
  configured: boolean
  status: BalanceStatus
  amount?: number
  unit?: string
  usd_equivalent?: number | null
  message?: string
  kind?: string
  /** Epoch seconds. */
  fetched_at: number
}

export interface CostEstimate {
  amount: number
  /** `credits` (Kie) or `usd` (PiAPI). */
  unit: string
  usd_equivalent: number | null
  /** Human readable, e.g. "5 s × 41 credits/s at 720p". */
  basis: string
  source: string
  /** Date of the price snapshot, YYYY-MM-DD. */
  as_of: string
  confidence: 'listed' | 'partial'
  /** Where the unit price came from: learned from this install's last charge
   * for the model, the downloaded public price list, or the copy shipped with
   * the app. Absent from older servers. */
  price_source?: PriceSource
  /** ISO timestamp of that price (or price list). */
  price_updated_at?: string
}

export type PriceSource = 'observed' | 'ledger' | 'bundled'
const PRICE_SOURCES: readonly PriceSource[] = ['observed', 'ledger', 'bundled']

function trim(value: number, maxFractionDigits: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: maxFractionDigits })
}

export function formatUsd(value: number): string {
  const abs = Math.abs(value)
  const digits = abs > 0 && abs < 0.01 ? 4 : 2
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits })}`
}

/** "205 credits", "$1.25", "6,000,000 points". */
export function formatAmount(amount: number, unit: string | undefined): string {
  const u = (unit ?? '').toLowerCase()
  if (u === 'usd') return formatUsd(amount)
  const digits = Math.abs(amount) >= 100 ? 0 : 2
  const label = u === 'credits' && amount === 1 ? 'credit' : u || 'units'
  return `${trim(amount, digits)} ${label}`
}

/** Compact amount for the credits pill: "1.2K credits", "$12.34". */
export function formatCompactAmount(amount: number, unit: string | undefined): string {
  if ((unit ?? '').toLowerCase() === 'usd') return formatUsd(amount)
  const compact = amount.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })
  return `${compact} ${(unit ?? '').toLowerCase() === 'credits' ? 'credits' : unit ?? ''}`.trim()
}

/** Text for a balance: "1,234 credits ≈ $6.17" or "$12.34". */
export function formatBalance(b: Pick<ProviderBalance, 'amount' | 'unit' | 'usd_equivalent'>): string {
  if (typeof b.amount !== 'number') return ''
  const main = formatAmount(b.amount, b.unit)
  if ((b.unit ?? '').toLowerCase() === 'usd' || typeof b.usd_equivalent !== 'number') return main
  return `${main} ≈ ${formatUsd(b.usd_equivalent)}`
}

/** "≈ 205 credits" or "≈ $1.00". */
export function formatEstimate(e: CostEstimate): string {
  return `≈ ${formatAmount(e.amount, e.unit)}`
}

/** "205 credits ≈ $1.03"; PiAPI points show the dollars first: "$0.60 (6,000,000 points)". */
export function formatJobCost(cost: JobCost): string {
  const unit = cost.unit.toLowerCase()
  if (unit === 'usd') return formatUsd(cost.amount)
  if (unit === 'points' && typeof cost.usd_equivalent === 'number') {
    return `${formatUsd(cost.usd_equivalent)} (${formatAmount(cost.amount, cost.unit)})`
  }
  const main = formatAmount(cost.amount, cost.unit)
  return typeof cost.usd_equivalent === 'number' ? `${main} ≈ ${formatUsd(cost.usd_equivalent)}` : main
}

/** Validates a cost object from a job snapshot; anything malformed is null. */
export function readJobCost(value: unknown): JobCost | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.amount !== 'number' || !Number.isFinite(v.amount) || typeof v.unit !== 'string' || !v.unit) return null
  const usd = typeof v.usd_equivalent === 'number' && Number.isFinite(v.usd_equivalent) ? v.usd_equivalent : null
  return { amount: v.amount, unit: v.unit, usd_equivalent: usd }
}

/** Why `/api/generation/estimate` has no estimate. `code` is stable:
 * priced_per_token | input_video_billing_unknown | conflicting_sources |
 * no_published_price | auto_duration | not_priceable_request. */
export interface EstimateUnavailable {
  code: string
  message: string
}

/** Validates `unavailable` from `/api/generation/estimate`; malformed is null. */
export function readUnavailable(value: unknown): EstimateUnavailable | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.code !== 'string' || !v.code || typeof v.message !== 'string' || !v.message) return null
  return { code: v.code, message: v.message }
}

/** Validates an estimate from `/api/generation/estimate`; malformed is null. */
export function readEstimate(value: unknown): CostEstimate | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.amount !== 'number' || !Number.isFinite(v.amount) || typeof v.unit !== 'string') return null
  return {
    amount: v.amount,
    unit: v.unit,
    usd_equivalent: typeof v.usd_equivalent === 'number' ? v.usd_equivalent : null,
    basis: typeof v.basis === 'string' ? v.basis : '',
    source: typeof v.source === 'string' ? v.source : '',
    as_of: typeof v.as_of === 'string' ? v.as_of : '',
    confidence: v.confidence === 'partial' ? 'partial' : 'listed',
    ...(PRICE_SOURCES.includes(v.price_source as PriceSource) ? { price_source: v.price_source as PriceSource } : {}),
    ...(typeof v.price_updated_at === 'string' && v.price_updated_at ? { price_updated_at: v.price_updated_at } : {}),
  }
}

function readAmount(value: unknown): { amount: number; unit: string } | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.amount !== 'number' || !Number.isFinite(v.amount) || typeof v.unit !== 'string' || !v.unit) return null
  return { amount: v.amount, unit: v.unit }
}

/** Validates a job's `price_check`; malformed is null. A report link that is
 * not a plain https URL is dropped (it is opened from the viewer). */
export function readPriceCheck(value: unknown): PriceCheck | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const expected = readAmount(v.expected)
  const actual = readAmount(v.actual)
  if (!expected || !actual || typeof v.differs !== 'boolean') return null
  if (v.source !== 'ledger' && v.source !== 'bundled') return null
  let report: string | null = null
  if (typeof v.report_url === 'string') {
    try {
      if (new URL(v.report_url).protocol === 'https:') report = v.report_url
    } catch {
      report = null
    }
  }
  return {
    expected, actual, source: v.source, differs: v.differs,
    checked_at: typeof v.checked_at === 'string' ? v.checked_at : '', report_url: report,
  }
}

/** "just now", "2m ago" from epoch seconds. */
export function formatUpdated(epochSeconds: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round(now / 1000 - epochSeconds))
  if (secs < 10) return 'just now'
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ago`
}
