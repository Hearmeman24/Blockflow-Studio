'use client'

import { ACTIVE_JOB_STATUSES } from '@/lib/status'
import type { JobSnapshot } from '@/lib/types'
import {
  type PendingJobRun,
  type PendingJobSubmission,
  clearPendingJobRun,
  loadPendingJobRun,
  savePendingJobRun,
} from './job-pending'

// ---- Job store status (GET /api/jobs/{id}) ----

const ACTIVE_JOB_STATUS_SET: ReadonlySet<string> = new Set(ACTIVE_JOB_STATUSES)

function notFoundSnapshot(jobId: string): JobSnapshot {
  const now = Date.now() / 1000
  return {
    job_id: jobId,
    source: 'pipeline',
    provider: '',
    model: '',
    mode: '',
    status: 'FAILED',
    remote_job_id: null,
    remote_status: null,
    progress: null,
    message: null,
    error: { kind: 'not_found', message: 'Job not found' },
    outputs: [],
    request: {},
    created_at: now,
    updated_at: now,
    completed_at: now,
    cancel_requested: false,
  }
}

/**
 * Fetch one job's snapshot from the job store. An unknown id (HTTP 404) is
 * returned as a FAILED `not_found` snapshot so a resumed poll ends instead of
 * waiting forever; any other error throws and the poller retries next tick.
 */
export async function fetchJobStatus(jobId: string, signal?: AbortSignal): Promise<JobSnapshot> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'GET', signal })
  if (res.status === 404) return notFoundSnapshot(jobId)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { ok?: boolean; job?: JobSnapshot }
  if (!body?.job) throw new Error('Malformed job status response')
  return body.job
}

/** Polling callbacks for job-store snapshots; spread into a poll call and add `getArtifact`. */
export const JOB_SNAPSHOT_POLLING = {
  fetchStatus: (jobId: string) => fetchJobStatus(jobId),
  getJob: (payload: unknown): JobSnapshot | null => (
    payload && typeof payload === 'object' && typeof (payload as JobSnapshot).status === 'string'
      ? (payload as JobSnapshot)
      : null
  ),
  getStatus: (job: JobSnapshot) => job.status,
  isActiveStatus: (status: string) => ACTIVE_JOB_STATUS_SET.has(status),
  isCompletedStatus: (status: string) => status === 'COMPLETED',
  getError: (job: JobSnapshot) => job.error?.message ?? null,
}

// ---- Generic fan-out poller ----

export interface FanoutStats {
  total: number
  completed: number
  failed: number
  active: number
}

export interface FanoutPollResult<TArtifact> {
  artifacts: TArtifact[]
  stats: FanoutStats
  errors: string[]
}

export interface PollingProgressEntry<TJob> {
  idx: number
  jobId: string
  status: string
  job: TJob | null
}

interface StartPollParams<TJob, TArtifact> {
  blockId: string
  pending: PendingJobRun
  pollIntervalMs?: number
  maxPollMs?: number | null
  fetchStatus: (jobId: string) => Promise<unknown>
  getJob: (payload: unknown) => TJob | null
  getStatus: (job: TJob) => string
  isActiveStatus: (status: string) => boolean
  isCompletedStatus: (status: string) => boolean
  getError?: (job: TJob) => string | null
  getArtifact: (job: TJob) => TArtifact | null
  onProgress?: (stats: FanoutStats, progress: PollingProgressEntry<TJob>[]) => void
}

const activePolls = new Map<string, Promise<FanoutPollResult<unknown>>>()
const abortControllers = new Map<string, AbortController>()

function getPollKey(blockId: string): string {
  return `poll:${blockId}`
}

export function setPersistedBlockStatus(blockId: string, value: string) {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.setItem(`block_${blockId}_status`, JSON.stringify(value))
  } catch {
    // ignore storage errors
  }
}

/** Abort all active polls (used by pipeline cancellation). */
export function abortAllActivePolls(): void {
  for (const [key, controller] of abortControllers) {
    controller.abort()
    abortControllers.delete(key)
    activePolls.delete(key)
  }
}

/** Abort a specific block's poll. */
export function abortPoll(blockId: string): void {
  const key = getPollKey(blockId)
  const controller = abortControllers.get(key)
  if (controller) {
    controller.abort()
    abortControllers.delete(key)
  }
  activePolls.delete(key)
}

async function runFanoutPoll<TJob, TArtifact>({
  blockId,
  pending,
  pollIntervalMs = 3000,
  maxPollMs = 30 * 60 * 1000,
  fetchStatus,
  getJob,
  getStatus,
  isActiveStatus,
  isCompletedStatus,
  getError,
  getArtifact,
  onProgress,
}: StartPollParams<TJob, TArtifact>): Promise<FanoutPollResult<TArtifact>> {
  const submitted: PendingJobSubmission[] = pending.submitted.map((entry) => ({ idx: entry.idx, jobId: entry.jobId }))
  if (submitted.length === 0) {
    throw new Error('No submitted jobs to poll')
  }

  const key = getPollKey(blockId)
  const abortController = new AbortController()
  abortControllers.set(key, abortController)

  const sleep = (ms: number) => new Promise<void>((resolve, reject) => {
    if (abortController.signal.aborted) {
      reject(new DOMException('Poll cancelled', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    abortController.signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Poll cancelled', 'AbortError'))
    }, { once: true })
  })
  const jobMap = new Map<number, TJob>()
  const startedAt = Number.isFinite(Number(pending.startedAt))
    ? Number(pending.startedAt)
    : Date.now()

  while (true) {
    if (abortController.signal.aborted) {
      throw new DOMException('Poll cancelled', 'AbortError')
    }
    if (typeof maxPollMs === 'number' && maxPollMs > 0 && Date.now() - startedAt > maxPollMs) {
      throw new Error('Polling timed out before jobs reached terminal state')
    }

    const results = await Promise.allSettled(submitted.map((entry) => fetchStatus(entry.jobId)))
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status !== 'fulfilled') continue
      const job = getJob(result.value)
      if (!job) continue
      jobMap.set(submitted[i].idx, job)
    }

    let completed = 0
    let failed = pending.submissionFailures
    let active = 0

    for (const entry of submitted) {
      const job = jobMap.get(entry.idx)
      if (!job) {
        active++
        continue
      }
      const status = getStatus(job)
      if (isActiveStatus(status)) active++
      else if (isCompletedStatus(status)) completed++
      else failed++
    }

    const progress: PollingProgressEntry<TJob>[] = submitted.map((entry) => {
      const job = jobMap.get(entry.idx) ?? null
      const status = job ? getStatus(job) : 'PENDING'
      return {
        idx: entry.idx,
        jobId: entry.jobId,
        status,
        job,
      }
    })

    const stats: FanoutStats = {
      total: pending.total,
      completed,
      failed,
      active,
    }
    onProgress?.(stats, progress)

    const allTerminal = submitted.every((entry) => {
      const job = jobMap.get(entry.idx)
      if (!job) return false
      return !isActiveStatus(getStatus(job))
    })

    if (allTerminal) {
      const artifacts = submitted
        .map((entry) => jobMap.get(entry.idx))
        .filter((job): job is TJob => Boolean(job))
        .map((job) => getArtifact(job))
        .filter((artifact): artifact is TArtifact => artifact !== null)

      const errors = getError
        ? submitted
            .map((entry) => jobMap.get(entry.idx))
            .filter((job): job is TJob => Boolean(job))
            .map((job) => getError(job))
            .filter((err): err is string => Boolean(err))
        : []

      return { artifacts, stats, errors }
    }

    await sleep(pollIntervalMs)
  }
}

export function startOrJoinPendingPoll<TJob, TArtifact>(
  params: StartPollParams<TJob, TArtifact>,
): Promise<FanoutPollResult<TArtifact>> {
  const key = getPollKey(params.blockId)
  const existing = activePolls.get(key)
  if (existing) {
    return existing as Promise<FanoutPollResult<TArtifact>>
  }

  const promise = runFanoutPoll(params)
    .finally(() => {
      activePolls.delete(key)
      abortControllers.delete(key)
      clearPendingJobRun(params.blockId)
    }) as Promise<FanoutPollResult<unknown>>

  activePolls.set(key, promise)
  return promise as Promise<FanoutPollResult<TArtifact>>
}

export function startNewPendingPoll<TJob, TArtifact>(
  params: Omit<StartPollParams<TJob, TArtifact>, 'pending'> & { pending: PendingJobRun },
): Promise<FanoutPollResult<TArtifact>> {
  savePendingJobRun(params.blockId, params.pending)
  return startOrJoinPendingPoll(params)
}

export function resumePendingPoll<TJob, TArtifact>(
  params: Omit<StartPollParams<TJob, TArtifact>, 'pending'>,
): Promise<FanoutPollResult<TArtifact>> | null {
  const pending = loadPendingJobRun(params.blockId)
  if (!pending) return null
  return startOrJoinPendingPoll({ ...params, pending })
}

export type PendingPollingRun = PendingJobRun
export type PollingStats = FanoutStats
export type PollingResult<TArtifact> = FanoutPollResult<TArtifact>
export const startOrJoinPollingRun = startOrJoinPendingPoll
export const startNewPollingRun = startNewPendingPoll
export const resumePollingRun = resumePendingPoll
