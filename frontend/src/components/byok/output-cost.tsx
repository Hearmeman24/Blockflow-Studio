'use client'

/**
 * The actual cost of a generated output, for viewers. The value comes from the
 * generation metadata on the output ref (`meta.cost`, the provider's reported
 * charge for the job). Nothing is shown when the ref carries no cost.
 * `PriceMismatchBadge` flags a charge that differed from the price list
 * (`meta.price_check.differs`).
 */
import { useState } from 'react'
import { Coins } from 'lucide-react'
import { ChipTooltip } from '@/components/chip-tooltip'
import { WarningBadge } from '@/components/warning-badge'
import { Button } from '@/components/ui/button'
import { providerName } from '@/lib/byok/catalog'
import { formatAmount, formatJobCost } from '@/lib/byok/cost'
import { useProviderCatalog } from '@/lib/byok/use-provider-catalog'
import { generationMetaByUrl, type GenerationMeta } from '@/lib/image-ref'

/**
 * Generation metadata for the URLs a viewer shows. Kept across runs for as long
 * as the viewer keeps the URLs themselves, and updated when a later value of
 * the same output brings a cost the first one lacked.
 */
export function useOutputMeta(values: readonly unknown[]): ReadonlyMap<string, GenerationMeta> {
  const [byUrl, setByUrl] = useState<ReadonlyMap<string, GenerationMeta>>(() => new Map())
  const [seen, setSeen] = useState('')
  const signature = values.map((v) => JSON.stringify(v ?? null)).join('\u0000')
  // Adjust state while rendering when the inputs change (React's "storing
  // information from previous renders" pattern), so no effect is needed.
  if (signature !== seen) {
    setSeen(signature)
    const incoming = new Map<string, GenerationMeta>()
    for (const value of values) for (const [url, meta] of generationMetaByUrl(value)) incoming.set(url, meta)
    let changed = false
    const next = new Map(byUrl)
    for (const [url, meta] of incoming) {
      const old = byUrl.get(url)
      if (!old || JSON.stringify(old) !== JSON.stringify(meta)) {
        next.set(url, meta)
        changed = true
      }
    }
    if (changed) setByUrl(next)
  }
  return byUrl
}

/** "205 credits ≈ $1.03" with a tooltip saying who reported it. Nothing without a cost. */
export function OutputCostLabel({ meta, outputsOfJob = 1 }: { meta: GenerationMeta | undefined; outputsOfJob?: number }) {
  const { catalog } = useProviderCatalog()
  if (!meta?.cost) return null
  const name = meta.provider ? providerName(catalog, meta.provider) : 'the provider'
  const tip = `Reported by ${name} for this job${outputsOfJob > 1 ? ` (${outputsOfJob} outputs)` : ''}.`
  return (
    <ChipTooltip tip={tip}>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        data-testid="output-cost"
        aria-label={`Cost ${formatJobCost(meta.cost)}. ${tip}`}
        className="text-muted-foreground hover:text-foreground h-5 shrink-0 cursor-help gap-1 rounded-full px-1.5 text-3xs font-medium tabular-nums"
      >
        <Coins aria-hidden className="size-3" />
        {formatJobCost(meta.cost)}
      </Button>
    </ChipTooltip>
  )
}

/**
 * A warning badge beside the cost when the provider charged something other
 * than the price list predicted, with an optional "Report price change" link.
 * Nothing when the prices matched or there was nothing to compare.
 */
export function PriceMismatchBadge({ meta }: { meta: GenerationMeta | undefined }) {
  const { catalog } = useProviderCatalog()
  const check = meta?.price_check
  if (!meta || !check?.differs) return null
  const name = meta.provider ? providerName(catalog, meta.provider) : 'The provider'
  const message = `${name} charged ${formatAmount(check.actual.amount, check.actual.unit)}; `
    + `the price list expected ${formatAmount(check.expected.amount, check.expected.unit)}. `
    + 'Future estimates for this model now use the charged price.'
  return (
    <WarningBadge
      text="Price changed"
      className="shrink-0"
      warnings={[{
        id: `price-check-${meta.job_id}`,
        message,
        ...(check.report_url ? { link: { label: 'Report price change', href: check.report_url } } : {}),
      }]}
    />
  )
}
