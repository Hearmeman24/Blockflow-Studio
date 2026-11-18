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

// ---- Poll registry ----
//
// One entry per block, owned by the jobs it polls. A request for the same jobs
// joins the entry; a request for other jobs replaces it (the old poll is
// aborted), so a new run never receives an old job's result. A poll that ends
// removes only its own entry and clears the block's pending record only while
// that record still names its own jobs, so a poll that settles late never
// drops a newer job's record (which a reload needs to resume it).

interface PollEntry {
  /** The polled job ids, in submission order, joined: the entry's identity. */
  jobIds: string
  promise: Promise<FanoutPollResult<unknown>>
  controller: AbortController
}

const polls = new Map<string, PollEntry>()
const pollListeners = new Set<() => void>()

function getPollKey(blockId: string): string {
  return `poll:${blockId}`
}

function jobIdsOf(pending: PendingJobRun | null): string {
  return pending ? pending.submitted.map((entry) => entry.jobId).join('\n') : ''
}

function notifyPollListeners(): void {
  for (const listener of [...pollListeners]) listener()
}

/** Whether a poll is in flight for this block. */
export function hasActivePoll(blockId: string): boolean {
  return polls.has(getPollKey(blockId))
}

/** Hear when any poll starts or ends. Returns the unsubscribe function. */
export function subscribePolls(listener: () => void): () => void {
  pollListeners.add(listener)
  return () => {
    pollListeners.delete(listener)
  }
}

function removePollEntry(key: string, entry: PollEntry): void {
  if (polls.get(key) !== entry) return
  polls.delete(key)
  notifyPollListeners()
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
  for (const [key, entry] of [...polls]) {
    entry.controller.abort()
    removePollEntry(key, entry)
  }
}

/** Abort a specific block's poll. */
export function abortPoll(blockId: string): void {
  const key = getPollKey(blockId)
  const entry = polls.get(key)
  if (!entry) return
  entry.controller.abort()
  removePollEntry(key, entry)
}

async function runFanoutPoll<TJob, TArtifact>(
  {
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
  }: StartPollParams<TJob, TArtifact>,
  abortController: AbortController,
): Promise<FanoutPollResult<TArtifact>> {
  const submitted: PendingJobSubmission[] = pending.submitted.map((entry) => ({ idx: entry.idx, jobId: entry.jobId }))
  if (submitted.length === 0) {
    throw new Error('No submitted jobs to poll')
  }

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
  const jobIds = jobIdsOf(params.pending)
  const existing = polls.get(key)
  if (existing && existing.jobIds === jobIds) {
    return existing.promise as Promise<FanoutPollResult<TArtifact>>
  }
  // Other jobs for this block: the old poll's caller has moved on (its run was
  // cancelled or replaced), so stop it rather than hand its result to this one.
  if (existing) {
    existing.controller.abort()
    removePollEntry(key, existing)
  }

  const controller = new AbortController()
  // The finally runs asynchronously, after `entry` is assigned.
  const promise = runFanoutPoll(params, controller)
    .finally(() => {
      // Clear the record first: listeners told the poll ended must see it gone.
      if (jobIdsOf(loadPendingJobRun(params.blockId)) === jobIds) clearPendingJobRun(params.blockId)
      if (polls.get(key) === entry) polls.delete(key)
      // Also when an abort removed the entry earlier: the record is gone only now.
      notifyPollListeners()
    }) as Promise<FanoutPollResult<unknown>>
  const entry: PollEntry = { jobIds, controller, promise }

  polls.set(key, entry)
  notifyPollListeners()
  return entry.promise as Promise<FanoutPollResult<TArtifact>>
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
