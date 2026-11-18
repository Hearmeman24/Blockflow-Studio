'use client'

/**
 * The Artifacts viewer: one run, large. The media sits on the left (about
 * 70 %), fitted without cropping or upscaling, with previous/next arrows and a
 * strip of the run's other outputs; the metadata sits on the right (about
 * 30 %) and scrolls on its own: model, provider, cost, time, duration, status,
 * the settings used, the prompt with Copy, the references, and the Restore and
 * Favorite actions. Below medium width the panes stack and the dialog scrolls.
 * ←/→ move through the runs on the page without closing the dialog.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, FileText, Music } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  findPrimaryArtifact, primaryMeta, runFailure, runModelId, runOutputs, runPrompt, runProviderId, runReferences, runSettings,
  type RunMedia,
} from '@/lib/artifacts/run-media'
import { findModel, providerName } from '@/lib/byok/catalog'
import { formatJobCost } from '@/lib/byok/cost'
import { useProviderCatalog } from '@/lib/byok/use-provider-catalog'
import { fmtDurationSeconds, formatRelativeTime } from '@/lib/format-time'
import { runStatusBadge } from '@/lib/status'
import type { RunEntry } from '@/lib/types'
import { cn } from '@/lib/utils'
import { CopyPromptButton, FavoriteRunButton, RestoreButton, useRestoreRun, useRunFavorite } from './run-actions'

export interface ArtifactViewerProps {
  /** The runs on the current page, in grid order. */
  runs: readonly RunEntry[]
  /** The run shown, or null when the viewer is closed. */
  index: number | null
  onIndexChange: (index: number | null) => void
  onFavoriteToggled?: () => void
}

/** Keys that media controls and text fields use themselves. */
function ownsArrowKeys(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.matches('input, textarea, video, audio, [role="slider"]') || target.isContentEditable)
}

export function ArtifactViewer({ runs, index, onIndexChange, onFavoriteToggled }: ArtifactViewerProps) {
  const run = index !== null ? runs[index] : undefined
  const shownId = useRef<string | null>(null)
  useEffect(() => {
    if (run) shownId.current = run.id
  }, [run])

  const go = (delta: number) => {
    if (index === null) return
    const next = index + delta
    if (next >= 0 && next < runs.length) onIndexChange(next)
  }

  // ←/→ on the whole document while open: focus can drop to the page when the
  // arrow button that was used becomes disabled at the first or last run.
  const goRef = useRef(go)
  useEffect(() => {
    goRef.current = go
  })
  const open = !!run
  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || ownsArrowKeys(e.target)) return
      if (e.key === 'ArrowLeft') goRef.current(-1)
      else if (e.key === 'ArrowRight') goRef.current(1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <Dialog open={!!run} onOpenChange={(open) => { if (!open) onIndexChange(null) }}>
      {run && (
        <DialogContent
          onCloseAutoFocus={(e) => {
            // Return focus to the tile of the run shown last (it may differ from the one opened).
            const id = shownId.current
            const tile = id ? document.querySelector<HTMLElement>(`[data-run-tile="${CSS.escape(id)}"]`) : null
            if (tile) {
              e.preventDefault()
              tile.focus()
            }
          }}
          className={cn(
            'flex flex-col gap-2 overflow-y-auto p-2 sm:max-w-[calc(100%-4rem)] md:flex-row md:overflow-hidden',
            // Most of the viewport, with margins: no static size class covers this.
            'h-[calc(100dvh-2rem)] sm:h-[calc(100dvh-4rem)]',
            'motion-reduce:animate-none',
          )}
        >
          <section aria-label="Media" className="bg-muted/30 relative flex shrink-0 flex-col rounded-lg md:min-w-0 md:shrink md:basis-7/10">
            <MediaPane key={run.id} run={run} />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Previous run"
              disabled={index === null || index <= 0}
              onClick={() => go(-1)}
              className="bg-background/70 absolute left-2 top-1/2 -translate-y-1/2 backdrop-blur-sm"
            >
              <ChevronLeft aria-hidden />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Next run"
              disabled={index === null || index >= runs.length - 1}
              onClick={() => go(1)}
              className="bg-background/70 absolute right-2 top-1/2 -translate-y-1/2 backdrop-blur-sm"
            >
              <ChevronRight aria-hidden />
            </Button>
          </section>
          <aside aria-label="Details" className="bg-muted/30 shrink-0 rounded-lg p-4 md:min-w-0 md:shrink md:basis-3/10 md:overflow-y-auto">
            <DetailsPane
              key={run.id}
              run={run}
              onFavoriteToggled={onFavoriteToggled}
              onClose={() => onIndexChange(null)}
            />
          </aside>
        </DialogContent>
      )}
    </Dialog>
  )
}

function MediaView({ media, name, className }: { media: RunMedia; name: string; className?: string }) {
  if (media.kind === 'image') {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={media.url} alt={name} className={cn('max-h-full max-w-full object-contain', className)} />
  }
  if (media.kind === 'video') {
    return <video src={media.url} aria-label={name} controls playsInline preload="metadata" className={cn('max-h-full max-w-full object-contain', className)} />
  }
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-4">
      <div className="bg-muted text-muted-foreground flex size-24 items-center justify-center rounded-full">
        <Music aria-hidden className="size-10" />
      </div>
      <audio src={media.url} controls preload="metadata" aria-label={`Audio for ${name}`} className="w-full">
        <track kind="captions" />
      </audio>
    </div>
  )
}

function MediaPane({ run }: { run: RunEntry }) {
  const outputs = useMemo(() => runOutputs(run), [run])
  const [selected, setSelected] = useState(0)
  const current = outputs[Math.min(selected, Math.max(0, outputs.length - 1))]
  const name = run.name || 'Run'
  return (
    <>
      {/* Stacked: a fixed share of the screen; side by side: the full height. */}
      <div className="flex h-[60dvh] min-h-0 items-center justify-center p-2 md:h-auto md:flex-1">
        {current ? (
          <MediaView media={current} name={name} />
        ) : (
          <div className="text-muted-foreground flex flex-col items-center gap-2 text-sm">
            <FileText aria-hidden className="size-8" />
            No media in this run.
          </div>
        )}
      </div>
      {outputs.length > 1 && (
        <ul aria-label="Outputs" className="flex shrink-0 gap-2 overflow-x-auto px-2 pb-2">
          {outputs.map((o, i) => (
            <li key={`${o.url}-${i}`}>
              <button
                type="button"
                aria-label={`Output ${i + 1}`}
                aria-current={i === selected}
                onClick={() => setSelected(i)}
                className={cn(
                  'focus-visible:ring-ring block size-14 overflow-hidden rounded-md border-2 outline-none focus-visible:ring-2',
                  i === selected ? 'border-foreground' : 'border-transparent opacity-70 hover:opacity-100',
                )}
              >
                {o.kind === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={o.url} alt="" className="size-full object-cover" />
                ) : o.kind === 'video' ? (
                  <video src={`${o.url}#t=0.1`} muted preload="metadata" className="size-full object-cover" />
                ) : (
                  <Music aria-hidden className="m-auto size-5" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

function DetailsPane({ run, onFavoriteToggled, onClose }: { run: RunEntry; onFavoriteToggled?: () => void; onClose: () => void }) {
  const { catalog } = useProviderCatalog()
  const restoreRun = useRestoreRun()
  const { fav, toggle } = useRunFavorite(run, onFavoriteToggled)
  const primary = useMemo(() => findPrimaryArtifact(run.block_results ?? []), [run])
  const meta = primaryMeta(primary)
  const modelId = runModelId(run, primary)
  const providerId = runProviderId(run, primary)
  const prompt = useMemo(() => runPrompt(run), [run])
  const settings = useMemo(() => runSettings(run), [run])
  const references = useMemo(() => runReferences(run), [run])
  const failure = runFailure(run)
  const name = run.name || 'Run'
  const created = new Date(run.created_at)
  const badge = runStatusBadge(run.status)
  const statusLabel = badge?.label ?? null

  return (
    <div className="space-y-5 text-xs">
      <div className="flex items-start gap-2 pr-8">
        <DialogTitle className="min-w-0 flex-1 text-sm leading-snug font-medium break-words">{name}</DialogTitle>
      </div>
      <DialogDescription className="sr-only">The run&apos;s media and the details of how it was made.</DialogDescription>
      <div className="-ml-2 flex items-center gap-0.5">
        <RestoreButton name={name} onRestore={() => { onClose(); restoreRun(run) }} className="size-8" />
        <FavoriteRunButton name={name} fav={fav} onToggle={toggle} />
      </div>

      <dl className="space-y-1.5">
        {modelId && <Row label="Model">{findModel(catalog, modelId)?.name ?? modelId}</Row>}
        {providerId && <Row label="Provider">{providerName(catalog, providerId)}</Row>}
        {meta?.cost && <Row label="Cost">{formatJobCost(meta.cost)}</Row>}
        {!Number.isNaN(created.getTime()) && (
          <Row label="Created">
            {created.toLocaleString()} <span className="text-muted-foreground">({formatRelativeTime(run.created_at)})</span>
          </Row>
        )}
        {typeof run.duration_ms === 'number' && run.duration_ms > 0 && <Row label="Took">{fmtDurationSeconds(run.duration_ms / 1000)}</Row>}
        {statusLabel && (
          <Row label="Status">
            <span className="inline-flex items-center gap-1 font-medium">
              <AlertTriangle aria-hidden className={cn('size-3.5', badge?.tone === 'error' ? 'text-destructive' : 'text-warning')} />
              {statusLabel}
            </span>
            {failure && <span className="block">{failure}</span>}
          </Row>
        )}
      </dl>

      {settings.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-muted-foreground text-2xs font-medium uppercase tracking-wide">Settings</h3>
          <ul aria-label="Settings" className="space-y-1">
            {settings.map((s) => (
              <li key={s.label} className="grid grid-cols-[6.5rem_1fr] gap-2">
                <span className="text-muted-foreground">{s.label}</span>
                <span className="min-w-0 break-words">{s.value}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {prompt && (
        <section className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-muted-foreground text-2xs font-medium uppercase tracking-wide">Prompt</h3>
            <CopyPromptButton name={name} prompt={prompt} className="size-7" />
          </div>
          <p data-testid="viewer-prompt" className="whitespace-pre-wrap break-words leading-relaxed">{prompt}</p>
        </section>
      )}

      {references.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-muted-foreground text-2xs font-medium uppercase tracking-wide">References</h3>
          <ul aria-label="References" className="flex flex-wrap gap-2">
            {references.map((r, i) => (
              <li key={`${r.url}-${i}`} title={r.label} className="bg-muted size-14 overflow-hidden rounded-md">
                {r.kind === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.url} alt={r.label} className="size-full object-cover" />
                ) : r.kind === 'video' ? (
                  <video src={`${r.url}#t=0.1`} aria-label={r.label} muted preload="metadata" className="size-full object-cover" />
                ) : (
                  <span className="text-muted-foreground flex size-full items-center justify-center" role="img" aria-label={r.label}>
                    <Music aria-hidden className="size-5" />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
