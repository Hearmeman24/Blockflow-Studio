'use client'

/**
 * Settings → App: "Keep cost estimates current". Turns the price-list
 * download (`price_ledger_updates` app pref) on or off and says which price
 * list the estimates use. On by default (the public ledger repository);
 * inactive only when `PRICE_LEDGER_URL` is overridden to empty.
 */
import { useCallback, useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
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
  const [status, setStatus] = useState<PricingStatus | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetchStatus()
      .then((s) => {
        if (cancelled) return
        setStatus(s)
        setLoadError(false)
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  const toggle = useCallback(async (next: boolean) => {
    setSaving(true)
    setSaveError(false)
    try {
      await setAppPref(PRICE_LEDGER_UPDATES_PREF, next ? 'true' : 'false')
      setStatus(await fetchStatus())
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }, [])

  const date = status?.ledger.generated_at.slice(0, 10)
  return (
    <section className="space-y-3" aria-labelledby={labelId}>
      <h2 id={labelId} className="text-base font-semibold">Price list</h2>
      <p className="text-xs text-muted-foreground">
        To keep cost estimates current, BlockFlow downloads a public price list from Hearmeman24/blockflow-prices
        on GitHub, at most twice a day. It sends nothing about you, your keys or your runs.
      </p>
      {!status && !loadError && <Skeleton className="h-9 w-full max-w-md" />}
      {!status && loadError && (
        <div className="flex items-center gap-3">
          <p className="text-xs text-destructive">Could not read the price list status.</p>
          <Button type="button" size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
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
              disabled={!status.remote.configured || saving}
              onCheckedChange={(checked) => void toggle(checked)}
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
          {saveError && <p className="text-xs text-destructive">Could not save this setting. Try again.</p>}
        </>
      )}
    </section>
  )
}
