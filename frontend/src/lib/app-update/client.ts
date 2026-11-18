/**
 * Client for the updater routes (backend/app_update/routes.py).
 *
 * Status, check and dismiss go through the Next.js `/api` proxy. Progress,
 * apply-adjacent polling and the version check go straight to the backend
 * (`directBackendUrl`): during an update the web server is paused and then
 * restarted, so the proxy is not there to answer.
 */
import { directBackendUrl } from '@/lib/backend-url'

export const UPDATE_STATUS_URL = '/api/app/update'
export const VERSION_URL = '/api/app/version'

export interface ReleaseInfo {
  version: string
  tag: string
  name: string
  published_at: string | null
  url: string
  /** Untrusted plain text from the release. Render as text only. */
  notes: string
  notes_truncated?: boolean
  prerelease: boolean
}

export type CheckStatus =
  | 'ok' | 'disabled' | 'not_configured' | 'not_found' | 'rate_limited' | 'offline' | 'error' | 'invalid'
  | 'too_large' | 'never'

export interface UpdateStatus {
  current: string
  latest: ReleaseInfo | null
  update_available: boolean
  notify: boolean
  dismissed: 'skipped' | 'snoozed' | null
  checked_at: number | null
  status: CheckStatus
  message: string
  channel: 'beta' | 'stable'
  checks_enabled: boolean
  repo: string
  supported: boolean
  reason?: string
  install: 'git' | 'package' | 'unknown'
  restart_automatic: boolean
}

export interface VersionInfo {
  version: string
  commit: string | null
  install: 'git' | 'package' | 'unknown'
  branch: string | null
  dirty: boolean
  update_supported: boolean
  reason?: string
}

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'
export interface UpdateStep { id: string; label: string; status: StepStatus; detail?: string }
export type UpdateState = 'idle' | 'running' | 'restarting' | 'done' | 'failed' | 'rolled_back'

export interface UpdateProgress {
  state: UpdateState
  step: string | null
  steps: UpdateStep[]
  log_tail: string[]
  error: string | null
  message: string | null
  manual: string[]
  restart: { automatic: boolean; required: boolean; command: string } | null
  tag: string | null
  from_version: string | null
  to_version: string | null
}

export interface Blocker { code: string; message: string }

export type ApplyResult =
  | { ok: true; progress: UpdateProgress }
  | { ok: false; code: string; detail: string; blockers: Blocker[] }

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null)
  if (!res.ok || !body) {
    const detail = body && typeof body.detail === 'string' ? body.detail : `HTTP ${res.status}`
    throw new Error(detail)
  }
  return body as T
}

const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

export const fetchUpdateStatus = async () => json<UpdateStatus>(await fetch(UPDATE_STATUS_URL))
export const checkForUpdates = async () => json<UpdateStatus>(await post(`${UPDATE_STATUS_URL}/check`))
export const dismissUpdate = async (tag: string, action: 'skip' | 'later' | 'clear') =>
  json<UpdateStatus>(await post(`${UPDATE_STATUS_URL}/dismiss`, { tag, action }))
export const fetchVersion = async () => json<VersionInfo>(await fetch(directBackendUrl(VERSION_URL)))
export const fetchProgress = async () =>
  json<UpdateProgress>(await fetch(directBackendUrl(`${UPDATE_STATUS_URL}/progress`)))
export const acknowledgeProgress = async () =>
  json<UpdateProgress>(await post(directBackendUrl(`${UPDATE_STATUS_URL}/progress/ack`)))

export async function applyUpdate(tag: string, allowActiveJobs: boolean): Promise<ApplyResult> {
  const res = await post(directBackendUrl(`${UPDATE_STATUS_URL}/apply`), { tag, allow_active_jobs: allowActiveJobs })
  const body = await res.json().catch(() => null)
  if (res.status === 202 && body) return { ok: true, progress: body as UpdateProgress }
  return {
    ok: false,
    code: typeof body?.code === 'string' ? body.code : 'error',
    detail: typeof body?.detail === 'string' ? body.detail : `HTTP ${res.status}`,
    blockers: Array.isArray(body?.blockers) ? (body.blockers as Blocker[]) : [],
  }
}

/** Commands for updating by hand, shown when the app cannot update itself. */
export function manualUpdateCommands(tag: string): string[] {
  return [
    'git fetch --tags origin',
    `git merge --ff-only ${tag}`,
    'uv sync --frozen',
    'npm --prefix frontend ci',
    'uv run app.py',
  ]
}
