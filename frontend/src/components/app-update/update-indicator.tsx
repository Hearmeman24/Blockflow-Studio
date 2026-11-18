'use client'

/**
 * Nav-bar update indicator, next to the Settings gear. Renders nothing unless
 * a newer release is available and not skipped or snoozed. Click opens a
 * popover: current → new version, date, the release notes as plain text, a
 * link to the release page, and the primary action (Update now, or how to
 * update by hand when this install cannot update itself).
 */
import { useState } from 'react'
import { CircleArrowUp } from 'lucide-react'
import { AlertPanel } from '@/components/alert-panel'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { manualUpdateCommands, type ReleaseInfo, type UpdateStatus } from '@/lib/app-update/client'
import { useOptionalAppUpdate } from './app-update-provider'

export function formatReleaseDate(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Release notes: untrusted text, rendered as text in a scrollable box. Never HTML. */
export function ReleaseNotes({ release }: { release: ReleaseInfo }) {
  if (!release.notes) return <p className="text-muted-foreground text-xs">No release notes.</p>
  return (
    <div
      data-testid="release-notes"
      tabIndex={0}
      aria-label="Release notes"
      className="bg-muted/30 max-h-48 overflow-y-auto rounded-md border border-border/60 p-2 text-xs whitespace-pre-wrap break-words"
    >
      {release.notes}
    </div>
  )
}

/** What to do when the app cannot update itself. */
export function ManualUpdate({ status }: { status: UpdateStatus }) {
  const tag = status.latest?.tag ?? ''
  return (
    <AlertPanel variant="info" title="Update by hand">
      {status.reason && <p>{status.reason}</p>}
      {status.install === 'git' && tag && (
        <>
          <p className="text-muted-foreground">Stop BlockFlow, then run in the app folder:</p>
          <pre className="bg-muted/40 overflow-x-auto rounded-md border border-border/60 p-2 font-mono text-2xs whitespace-pre-wrap">
            {manualUpdateCommands(tag).join('\n')}
          </pre>
        </>
      )}
    </AlertPanel>
  )
}

export function UpdateIndicator() {
  const update = useOptionalAppUpdate()
  const [open, setOpen] = useState(false)
  const status = update?.status
  const latest = status?.latest
  if (!update || !status || !status.notify || !latest) return null
  const { dismiss, requestUpdate, updating } = update
  const date = formatReleaseDate(latest.published_at)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Update available: ${latest.tag}`}
          title={`Update available: ${latest.tag}`}
          className="relative rounded-full text-muted-foreground hover:text-foreground"
        >
          <CircleArrowUp aria-hidden className="size-4" />
          <span aria-hidden className="bg-info absolute top-1 right-1 size-1.5 rounded-full ring-2 ring-card" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} aria-label="Update available" className="w-[min(22rem,calc(100vw-2rem))] space-y-3 p-3">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold">Update available</p>
          <p className="text-sm">
            <span className="font-mono">v{status.current}</span>
            <span aria-hidden> → </span>
            <span className="sr-only"> to </span>
            <span className="font-mono">{latest.tag}</span>
            {latest.prerelease && <span className="text-muted-foreground"> (beta)</span>}
          </p>
          {date && <p className="text-muted-foreground text-2xs">Released {date}</p>}
        </div>
        <ReleaseNotes release={latest} />
        <a href={latest.url} target="_blank" rel="noopener noreferrer" className="text-link text-2xs hover:underline">
          View the release on GitHub
        </a>
        {status.supported ? (
          <Button type="button" size="sm" className="w-full" disabled={updating}
            onClick={() => { setOpen(false); requestUpdate() }}>
            Update now
          </Button>
        ) : (
          <ManualUpdate status={status} />
        )}
        <div className="flex justify-between gap-2">
          <Button type="button" variant="ghost" size="xs" onClick={() => { setOpen(false); void dismiss('later') }}>
            Remind me later
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => { setOpen(false); void dismiss('skip') }}>
            Skip this version
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
