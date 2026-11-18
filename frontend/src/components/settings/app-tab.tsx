'use client'

import { useId, useState } from 'react'
import useSWR from 'swr'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { fetchVersion, VERSION_URL } from '@/lib/app-update/client'
import { useMutation } from '@/lib/mutation'
import { fromSWR, useResource } from '@/lib/resource'
import { getAppPref, setAppPref } from '@/lib/settings/client'

import { OutputFolderSetting } from './output-folder-setting'
import { PriceUpdatesSetting } from './price-updates-setting'
import { UpdatesSetting } from './updates-setting'

const RETENTION_PREF = 'run_history_retention_days'

type RetentionOption = '30' | '90' | '365' | 'forever'

const DEFAULT_RETENTION: RetentionOption = '90'

function toRetention(value: string | null): RetentionOption {
  return value && (['30', '90', '365', 'forever'] as const).includes(value as RetentionOption)
    ? value as RetentionOption
    : DEFAULT_RETENTION
}

const RETENTION_OPTIONS: { value: RetentionOption; label: string }[] = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days (default)' },
  { value: '365', label: '1 year' },
  { value: 'forever', label: 'Forever (no pruning)' },
]

export function AppTab() {
  const retentionId = useId()
  // Same SWR key as UpdatesSetting, so the version is fetched once.
  // Same SWR key as UpdatesSetting, so the version is fetched once.
  const version = fromSWR(useSWR(VERSION_URL, fetchVersion, {
    shouldRetryOnError: false,
    revalidateOnFocus: false,
  }))

  // The stored retention; `choice` is the value being saved, shown until the
  // save settles. A failed save shows the stored value again.
  const retention = useResource(async () => toRetention(await getAppPref(RETENTION_PREF)), [])
  const [choice, setChoice] = useState<RetentionOption | null>(null)
  const saveRetention = useMutation(
    async (value: RetentionOption) => {
      try {
        await setAppPref(RETENTION_PREF, value)
        retention.setData(() => value)
      } finally {
        setChoice(null)
      }
    },
    { message: () => 'Could not save this setting. Try again.' },
  )

  const handleRetentionChange = (value: RetentionOption) => {
    if (saveRetention.pending) return
    setChoice(value)
    void saveRetention.run(value)
  }

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h2 className="text-base font-semibold">About</h2>
        <p className="text-sm">
          <span className="text-muted-foreground">BlockFlow Studio </span>
          {version.kind === 'ready' ? (
            <span className="font-mono">{version.data.version}</span>
          ) : version.kind === 'error' ? (
            <span className="text-muted-foreground">(version unavailable)</span>
          ) : (
            <Skeleton className="inline-block h-4 w-24 align-middle" />
          )}
        </p>
      </section>

      <UpdatesSetting />

      <OutputFolderSetting />

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Run history retention</h2>
        <p className="text-xs text-muted-foreground">
          Non-favorited runs older than the chosen window are pruned on app launch. Favorited runs are never pruned.
        </p>
        {retention.resource.kind === 'loading' && (
          <Skeleton data-testid="retention-loading" className="h-8 w-48" />
        )}
        {retention.resource.kind === 'error' && (
          <div className="flex items-center gap-3">
            <p className="text-xs text-destructive">Could not read the retention setting.</p>
            <Button type="button" size="sm" variant="outline" onClick={retention.retry}>
              Retry
            </Button>
          </div>
        )}
        {retention.resource.kind === 'ready' && (
          <div className="flex items-center gap-3">
            <label htmlFor={retentionId} className="sr-only">
              Run history retention
            </label>
            <select
              id={retentionId}
              aria-label="Run history retention"
              value={choice ?? retention.resource.data}
              disabled={saveRetention.pending}
              onChange={(e) => handleRetentionChange(e.target.value as RetentionOption)}
              className="rounded border border-border bg-background px-3 py-1.5 text-sm"
            >
              {RETENTION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {saveRetention.state.kind === 'error' && (
          <p className="text-xs text-destructive">{saveRetention.state.message}</p>
        )}
      </section>

      <PriceUpdatesSetting />

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Links</h2>
        <ul className="text-sm space-y-1">
          <li>
            <a
              href="https://github.com/Hearmeman24/Blockflow-Studio"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              GitHub
            </a>
          </li>
          <li>
            <a
              href="https://github.com/Hearmeman24/Blockflow-Studio#readme"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              docs
            </a>
          </li>
        </ul>
      </section>
    </div>
  )
}
