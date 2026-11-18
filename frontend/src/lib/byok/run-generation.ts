'use client'

/**
 * One generation run: validate -> submit -> poll the job store, with
 * cancellation and resume after reload. React-free so blocks and tests share it.
 */
import type { GenerationMeta, ImageRef } from '@/lib/image-ref'
import { readJobCost, readPriceCheck } from './cost'
import type { VideoRef } from '@/lib/video-ref'
import { loadPendingJobRun, type PendingJobRun } from '@/lib/pipeline/job-pending'
import { JOB_SNAPSHOT_POLLING, abortPoll, resumePendingPoll, startNewPendingPoll } from '@/lib/pipeline/job-poller'
import type { JobSnapshot, JobStatus } from '@/lib/types'
import { cancelJob, newClientRequestId, submitGeneration, validateGeneration } from './api'
import type { GenerationIssue, GenerationRequest } from './types'

export type RunStatus =
  | 'validating'
  | 'submitting'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'

export interface RunUpdate {
  status: RunStatus
  jobId?: string
  progress?: number | null
  message?: string | null
  /** Warnings from validation (errors stop the run instead). */
  issues?: GenerationIssue[]
}

export class GenerationRunError extends Error {
  readonly issues: GenerationIssue[]
  readonly kind: string
  constructor(message: string, kind: string, issues: GenerationIssue[] = []) {
    super(message)
    this.name = 'GenerationRunError'
    this.kind = kind
    this.issues = issues
  }
}

const PENDING_KIND = 'generation'
const STATUS_BY_JOB: Record<JobStatus, RunStatus> = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
}

function abortError(): DOMException {
  return new DOMException('Generation cancelled', 'AbortError')
}

function errorsOf(issues: GenerationIssue[]): GenerationIssue[] {
  return issues.filter((i) => i.severity === 'error')
}

function issuesMessage(issues: GenerationIssue[]): string {
  const errors = errorsOf(issues)
  if (errors.length === 1) return errors[0].message
  return `Fix ${errors.length} issues before running: ${errors.map((e) => e.message).join(' ')}`
}

function pollJob(
  blockId: string,
  pending: PendingJobRun | null,
  pollIntervalMs: number | undefined,
  onUpdate: ((u: RunUpdate) => void) | undefined,
): Promise<JobSnapshot> | null {
  const params = {
    blockId,
    pollIntervalMs,
    // The backend owns timeouts (TIMED_OUT); the client never gives up on a paid job.
    maxPollMs: null,
    ...JOB_SNAPSHOT_POLLING,
    getArtifact: (snapshot: JobSnapshot) => snapshot,
    onProgress: (_stats: unknown, progress: Array<{ job: JobSnapshot | null }>) => {
      const snapshot = progress[0]?.job
      if (!snapshot) return
      onUpdate?.({
        status: STATUS_BY_JOB[snapshot.status] ?? 'running',
        jobId: snapshot.job_id,
        progress: snapshot.progress,
        message: snapshot.message,
      })
    },
  }
  const promise = pending ? startNewPendingPoll({ ...params, pending }) : resumePendingPoll(params)
  if (!promise) return null
  return promise.then((result) => {
    const snapshot = result.artifacts[0]
    if (!snapshot) throw new GenerationRunError('The job status could not be read.', 'unknown')
    return snapshot
  })
}

export interface RunGenerationOptions {
  blockId: string
  request: GenerationRequest
  signal: AbortSignal
  pollIntervalMs?: number
  onUpdate?: (update: RunUpdate) => void
}

/** Resolves with the job's terminal snapshot. Rejects with an AbortError when cancelled. */
export async function runGeneration({ blockId, request, signal, pollIntervalMs, onUpdate }: RunGenerationOptions): Promise<JobSnapshot> {
  if (signal.aborted) throw abortError()
  onUpdate?.({ status: 'validating' })
  const validation = await validateGeneration(request, signal)
  if (!validation.ok) throw new GenerationRunError(issuesMessage(validation.issues), 'validation', validation.issues)
  if (signal.aborted) throw abortError()

  onUpdate?.({ status: 'submitting', issues: validation.issues })
  // Not passed the signal: once the request is sent the job may exist, so the
  // response is always read and the job cancelled if the run was aborted.
  const submitted = await submitGeneration({ ...request, source: 'pipeline', client_request_id: newClientRequestId() })
  if (!submitted.ok) {
    if (signal.aborted) throw abortError()
    throw new GenerationRunError(
      submitted.kind === 'validation' && errorsOf(submitted.issues).length > 0 ? issuesMessage(submitted.issues) : submitted.error,
      submitted.kind,
      submitted.issues,
    )
  }
  const jobId = submitted.job.job_id
  if (signal.aborted) {
    await cancelJob(jobId)
    throw abortError()
  }
  onUpdate?.({ status: 'queued', jobId, progress: submitted.job.progress, message: submitted.job.message })

  const onAbort = () => {
    abortPoll(blockId)
    void cancelJob(jobId)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const pending: PendingJobRun = {
      kind: PENDING_KIND,
      total: 1,
      submissionFailures: 0,
      submitted: [{ idx: 0, jobId }],
      startedAt: Date.now(),
    }
    const snapshot = await pollJob(blockId, pending, pollIntervalMs, onUpdate)!
    if (signal.aborted) throw abortError()
    return snapshot
  } catch (err) {
    if (signal.aborted) throw abortError()
    throw err
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export interface ResumedGeneration {
  jobId: string
  promise: Promise<JobSnapshot>
}

/** Rejoin a job submitted before a reload, or null when the block has none pending. */
export function resumeGeneration({
  blockId,
  pollIntervalMs,
  onUpdate,
}: {
  blockId: string
  pollIntervalMs?: number
  onUpdate?: (update: RunUpdate) => void
}): ResumedGeneration | null {
  const pending = loadPendingJobRun(blockId)
  if (!pending || pending.kind !== PENDING_KIND) return null
  const promise = pollJob(blockId, null, pollIntervalMs, onUpdate)
  if (!promise) return null
  return { jobId: pending.submitted[0].jobId, promise }
}

/** Stop following a resumed job and ask the backend to cancel it. */
export function cancelResumedGeneration(blockId: string, jobId: string): void {
  abortPoll(blockId)
  void cancelJob(jobId)
}

const GENERIC_FAILURE = 'The generation failed. Try again, or check the provider status.'

/**
 * The output port value for a terminal job, or the error to show. Job errors
 * are shown as the backend wrote them.
 */
export function jobOutputValue(job: JobSnapshot, kind: 'image' | 'video'): ImageRef | VideoRef | Array<ImageRef | VideoRef> {
  if (job.status === 'COMPLETED') {
    // Which job made the output and what it cost travels with the ref, for viewers.
    const price_check = readPriceCheck(job.price_check)
    const meta: GenerationMeta = {
      job_id: job.job_id, provider: job.provider, model: job.model, cost: readJobCost(job.cost),
      ...(price_check ? { price_check } : {}),
    }
    const refs = job.outputs
      .filter((o) => o.kind === kind && (o.local_url || o.url))
      .map((o) => {
        const local = o.local_url || o.url
        const url = /^https?:\/\//i.test(o.url) ? o.url : undefined
        return kind === 'image'
          ? ({ kind: 'image-ref', local, ...(url ? { url } : {}), meta } as ImageRef)
          : ({ kind: 'video-ref', local, ...(url ? { url } : {}), meta } as VideoRef)
      })
    if (refs.length === 0) throw new GenerationRunError(`The job finished without ${kind === 'image' ? 'an image' : 'a video'}.`, 'no_output')
    return refs.length === 1 ? refs[0] : refs
  }
  if (job.status === 'CANCELLED') throw new GenerationRunError(job.error?.message || 'The generation was cancelled.', 'cancelled')
  if (job.status === 'TIMED_OUT') {
    throw new GenerationRunError(job.error?.message || 'The provider did not finish in time.', job.error?.kind ?? 'timeout')
  }
  throw new GenerationRunError(job.error?.message || GENERIC_FAILURE, job.error?.kind ?? 'unknown')
}
