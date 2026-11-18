'use client'

/**
 * Settings → App → Updates: version and commit, channel, automatic checks,
 * Check now (with the last result), and the same Update action as the nav
 * indicator. Prefs: `update_checks`, `update_channel`
 * (backend/app_update/settings.py).
 */
import { useId, useState } from 'react'
import useSWR from 'swr'
import { AlertPanel } from '@/components/alert-panel'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useAppUpdate } from '@/components/app-update/app-update-provider'
import { ManualUpdate, ReleaseNotes } from '@/components/app-update/update-indicator'
import { fetchVersion, VERSION_URL } from '@/lib/app-update/client'
import { formatRelativeTime } from '@/lib/format-time'
import { setAppPref } from '@/lib/settings/client'

export function UpdatesSetting() {
  const labelId = useId()
  const channelId = useId()
  const { status, error, isLoading, checkNow, refresh, requestUpdate, dismiss, updating } = useAppUpdate()
  const { data: version } = useSWR(VERSION_URL, fetchVersion, { shouldRetryOnError: false, revalidateOnFocus: false })
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const savePref = async (name: string, value: string) => {
    setBusy(true)
    setSaveError(null)
    try {
      await setAppPref(name, value)
      await refresh()
    } catch {
      setSaveError('Could not save this setting. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const check = async () => {
    setBusy(true)
    setSaveError(null)
    try {
      await checkNow()
    } catch {
      setSaveError('Could not check for updates. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const latest = status?.latest
  return (
    <section className="space-y-3" aria-labelledby={labelId}>
      <h2 id={labelId} className="text-base font-semibold">Updates</h2>
      <p className="text-xs text-muted-foreground">
        BlockFlow asks GitHub for new releases at most every 6 hours. It sends nothing about you.
      </p>
      {isLoading && !status && <Skeleton data-testid="updates-loading" className="h-24 w-full max-w-md" />}
      {!status && error && !isLoading && (
        <AlertPanel variant="error" title="Could not read the update status">
          <p>BlockFlow did not answer. It may still be starting.</p>
          <Button type="button" size="xs" variant="outline" onClick={() => void refresh()}>Retry</Button>
        </AlertPanel>
      )}
      {status && (
        <div className="space-y-3 rounded-md border border-border/40 px-4 py-3">
          <p className="text-sm">
            <span className="text-muted-foreground">Version </span>
            <span className="font-mono">{status.current}</span>
            {version?.commit && <span className="text-muted-foreground font-mono"> ({version.commit})</span>}
            {version?.branch && <span className="text-muted-foreground"> on {version.branch}</span>}
          </p>
          <div className="flex items-center justify-between gap-4">
            <label htmlFor={channelId} className="text-sm">Channel</label>
            <Select value={status.channel} disabled={busy} onValueChange={(v) => void savePref('update_channel', v)}>
              <SelectTrigger id={channelId} aria-label="Update channel" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="beta">Beta</SelectItem>
                <SelectItem value="stable">Stable</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-muted-foreground text-2xs">
            Beta includes pre-releases. Stable offers only full releases.
          </p>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm">Check for updates automatically</span>
            <Switch aria-label="Check for updates automatically" checked={status.checks_enabled} disabled={busy}
              onCheckedChange={(checked) => void savePref('update_checks', checked ? 'true' : 'false')} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" variant="outline" disabled={busy || !status.checks_enabled} onClick={() => void check()}>
              Check now
            </Button>
            <p className="text-muted-foreground text-xs" aria-live="polite">
              {status.checked_at ? `Last checked ${formatRelativeTime(new Date(status.checked_at * 1000).toISOString())}. ` : ''}
              {status.status === 'ok' && !status.update_available ? 'BlockFlow is up to date.' : status.message}
            </p>
          </div>
          {status.update_available && latest && (
            <div className="space-y-2 border-t border-border/40 pt-3">
              <p className="text-sm font-medium">
                {latest.tag} is available{latest.prerelease ? ' (beta)' : ''}
                {status.dismissed === 'skipped' && <span className="text-muted-foreground font-normal"> (skipped)</span>}
              </p>
              <ReleaseNotes release={latest} />
              <a href={latest.url} target="_blank" rel="noopener noreferrer" className="text-link text-2xs hover:underline">
                View the release on GitHub
              </a>
              {status.supported ? (
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" disabled={updating} onClick={requestUpdate}>Update now</Button>
                  {status.dismissed && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => void dismiss('clear')}>
                      Show the update notice again
                    </Button>
                  )}
                </div>
              ) : (
                <ManualUpdate status={status} />
              )}
            </div>
          )}
          {!status.update_available && !status.supported && status.reason && (
            <p className="text-muted-foreground text-2xs">This copy cannot update itself: {status.reason}</p>
          )}
          {saveError && <p className="text-xs text-destructive">{saveError}</p>}
        </div>
      )}
    </section>
  )
}
