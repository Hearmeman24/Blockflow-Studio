'use client'

/**
 * An MCP generation still in flight, as a tile in the Artifacts gallery: the
 * first output once one exists, otherwise a quiet placeholder with progress
 * and the model. Replaced by the run's own tile when the job finishes.
 */
import { Loader2 } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { parseAspectRatio } from '@/lib/artifacts/run-media'
import { ACTIVE_STATUSES, type JobSnapshot } from '@/lib/types'

export function isActiveJob(j: JobSnapshot): boolean {
  return ACTIVE_STATUSES.includes(j.status)
}

/** The tile's aspect ratio: the requested one, square otherwise. */
export function jobAspect(job: JobSnapshot): number {
  return parseAspectRatio(job.request?.aspect_ratio) ?? 1
}

export function McpJobTile({ job }: { job: JobSnapshot }) {
  const pct = typeof job.progress === 'number' && Number.isFinite(job.progress) ? Math.round(job.progress * 100) : null
  const prompt = typeof job.request?.prompt === 'string' ? job.request.prompt : ''
  const output = job.outputs?.[0]
  const preview = output ? (output.local_url ?? output.url) : null
  const model = job.model || 'MCP job'

  return (
    <div
      role="status"
      aria-label={`Generating with ${model}`}
      className="bg-muted/30 border-border/40 relative size-full overflow-hidden rounded-lg border"
    >
      {preview && output?.kind === 'image' ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt={prompt || 'Generated image'} className="size-full object-cover" />
      ) : preview && output?.kind === 'video' ? (
        <video src={preview} muted playsInline className="size-full object-cover" />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-2 p-3">
          <Loader2 aria-hidden className="text-info size-5 animate-spin motion-reduce:animate-none" />
          <span className="text-muted-foreground text-2xs tabular-nums">{pct !== null ? `${pct}%` : 'Generating'}</span>
        </div>
      )}
      <div className="bg-background/70 absolute inset-x-0 bottom-0 space-y-1 p-2 backdrop-blur-md">
        <p className="text-foreground/90 truncate text-2xs">{model}</p>
        <Progress value={pct ?? undefined} aria-label={`Progress for ${model}`} className="h-1" />
      </div>
    </div>
  )
}
