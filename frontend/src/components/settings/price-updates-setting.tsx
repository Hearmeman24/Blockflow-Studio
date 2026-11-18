'use client'

/**
 * Settings → App: "Keep cost estimates current". Turns the price-list
 * download (`price_ledger_updates` app pref) on or off and says which price
 * list the estimates use. On by default (the public ledger repository);
 * inactive only when `PRICE_LEDGER_URL` is overridden to empty.
 */
import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useMutation } from '@/lib/mutation'
import { useResource } from '@/lib/resource'
import { setAppPref } from '@/lib/settings/client'

export const PRICE_LEDGER_UPDATES_PREF = 'price_ledger_updates'
export const PRICING_STATUS_URL = '/api/pricing/status'

interface PricingStatus {
  active: 'ledger' | 'bundled'
  ledger: { generated_at: string; entries: number }
  remote: { configured: boolean; enabled: boolean }
  last_refresh?: { status: string } | null
}

async function fetchStatus(): Promise<PricingStatus> {
  const res = await fetch(PRICING_STATUS_URL)
  const body = (await res.json().catch(() => null)) as Partial<PricingStatus> | null
  if (!res.ok || !body?.remote || !body.ledger) throw new Error(`HTTP ${res.status}`)
  return body as PricingStatus
}

export function PriceUpdatesSetting() {
  const labelId = useId()
  const load = useResource(() => fetchStatus(), [])
  const toggle = useMutation(async (next: boolean) => {
    await setAppPref(PRICE_LEDGER_UPDATES_PREF, next ? 'true' : 'false')
    const fresh = await fetchStatus()
    load.setData(() => fresh)
  })

  const status = load.resource.kind === 'ready' ? load.resource.data : null
  const date = status?.ledger.generated_at.slice(0, 10)
  return (
    <section className="space-y-3" aria-labelledby={labelId}>
      <h2 id={labelId} className="text-base font-semibold">Price list</h2>
      <p className="text-xs text-muted-foreground">
        To keep cost estimates current, BlockFlow downloads a public price list from Hearmeman24/blockflow-prices
        on GitHub, at most twice a day. It sends nothing about you, your keys or your runs.
      </p>
      {load.resource.kind === 'loading' && <Skeleton className="h-9 w-full max-w-md" />}
      {load.resource.kind === 'error' && (
        <div className="flex items-center gap-3">
          <p className="text-xs text-destructive">Could not read the price list status.</p>
          <Button type="button" size="sm" variant="outline" onClick={load.retry}>
            Retry
          </Button>
        </div>
      )}
      {status && (
        <>
          <div className="flex items-center justify-between gap-4 rounded-md border border-border/40 px-4 py-3">
            <div>
              <div className="text-sm font-medium">Keep cost estimates current</div>
              <div className="text-xs text-muted-foreground">
                {status.active === 'ledger'
                  ? `Using the downloaded price list from ${date}.`
                  : `Using the prices bundled with this version (${date}).`}
              </div>
            </div>
            <Switch
              aria-label="Keep cost estimates current"
              checked={status.remote.enabled}
              disabled={!status.remote.configured || toggle.pending}
              onCheckedChange={(checked) => void toggle.run(checked)}
            />
          </div>
          {!status.remote.configured && (
            <p className="text-xs text-muted-foreground">
              Inactive: no price list address is configured, so the prices bundled with this version are used.
            </p>
          )}
          {status.remote.configured && status.remote.enabled && status.last_refresh?.status === 'not_available' && (
            <p className="text-xs text-muted-foreground">
              The online price list is not available yet, so the prices bundled with this version are used.
            </p>
          )}
          {toggle.state.kind === 'error' && <p className="text-xs text-destructive">Could not save this setting. Try again.</p>}
        </>
      )}
    </section>
  )
}
