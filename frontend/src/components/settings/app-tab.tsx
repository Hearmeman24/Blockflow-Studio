'use client'

import { useEffect, useId, useState } from 'react'
import useSWR from 'swr'

import { Skeleton } from '@/components/ui/skeleton'
import { fetchVersion, VERSION_URL } from '@/lib/app-update/client'
import { getAppPref, setAppPref } from '@/lib/settings/client'

import { OutputFolderSetting } from './output-folder-setting'
import { PriceUpdatesSetting } from './price-updates-setting'
import { UpdatesSetting } from './updates-setting'

const DEFAULT_RETENTION = '90'

type RetentionOption = '30' | '90' | '365' | 'forever'

const RETENTION_OPTIONS: { value: RetentionOption; label: string }[] = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days (default)' },
  { value: '365', label: '1 year' },
  { value: 'forever', label: 'Forever (no pruning)' },
]

export function AppTab() {
  const retentionId = useId()
  // Same SWR key as UpdatesSetting, so the version is fetched once.
  const { data: versionInfo, error: versionError } = useSWR(VERSION_URL, fetchVersion, {
    shouldRetryOnError: false,
    revalidateOnFocus: false,
  })

  const [retention, setRetention] = useState<RetentionOption>(DEFAULT_RETENTION)

  useEffect(() => {
    let cancelled = false
    getAppPref('run_history_retention_days')
      .then((ret) => {
        if (cancelled) return
        if (ret && (['30', '90', '365', 'forever'] as const).includes(ret as RetentionOption)) {
          setRetention(ret as RetentionOption)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const handleRetentionChange = async (value: RetentionOption) => {
    setRetention(value)
    try {
      await setAppPref('run_history_retention_days', value)
    } catch {
      // Setting persistence failure is silently ignored here; the next page
      // load will re-fetch from the server, surfacing the actual stored value.
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h2 className="text-base font-semibold">About</h2>
        <p className="text-sm">
          <span className="text-muted-foreground">BlockFlow Studio </span>
          {versionInfo ? (
            <span className="font-mono">{versionInfo.version}</span>
          ) : versionError ? (
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
        <div className="flex items-center gap-3">
          <label htmlFor={retentionId} className="sr-only">
            Run history retention
          </label>
          <select
            id={retentionId}
            aria-label="Run history retention"
            value={retention}
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
