'use client'

/**
 * Session-persisted record of a block's in-flight jobs, so a page reload can
 * resume polling the job store instead of losing a paid generation.
 */

export const JOB_PENDING_SUFFIX = '_pending_jobs_v1'

export interface PendingJobSubmission {
  idx: number
  jobId: string
}

export interface PendingJobRun {
  kind: string
  total: number
  submissionFailures: number
  submitted: PendingJobSubmission[]
  startedAt: number
}

export function getPendingJobRunKey(blockId: string): string {
  return `block_${blockId}${JOB_PENDING_SUFFIX}`
}

export function isPendingJobRun(value: unknown): value is PendingJobRun {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>

  if (typeof row.kind !== 'string' || !row.kind.trim()) return false
  if (!Number.isFinite(Number(row.total))) return false
  if (!Number.isFinite(Number(row.submissionFailures))) return false
  if (!Number.isFinite(Number(row.startedAt))) return false
  if (!Array.isArray(row.submitted) || row.submitted.length === 0) return false

  return row.submitted.every((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const e = entry as Record<string, unknown>
    return Number.isFinite(Number(e.idx)) && typeof e.jobId === 'string' && e.jobId.trim().length > 0
  })
}

export function loadPendingJobRun(blockId: string): PendingJobRun | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(getPendingJobRunKey(blockId))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isPendingJobRun(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function hasPendingJobRunForBlock(blockId: string): boolean {
  return loadPendingJobRun(blockId) !== null
}

export function savePendingJobRun(blockId: string, pending: PendingJobRun) {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.setItem(getPendingJobRunKey(blockId), JSON.stringify(pending))
  } catch {
    // ignore storage errors
  }
}

export function clearPendingJobRun(blockId: string) {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.removeItem(getPendingJobRunKey(blockId))
  } catch {
    // ignore storage errors
  }
}

export function hasAnyPendingJobRuns(): boolean {
  if (typeof window === 'undefined') return false
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)
      if (!key || !key.endsWith(JOB_PENDING_SUFFIX)) continue
      const raw = sessionStorage.getItem(key)
      if (!raw) continue
      try {
        if (isPendingJobRun(JSON.parse(raw))) return true
      } catch {
        // skip malformed entries
      }
    }
  } catch {
    // ignore storage access errors
  }
  return false
}
