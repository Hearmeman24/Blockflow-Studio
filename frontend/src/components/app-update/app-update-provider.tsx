'use client'

/**
 * Update state shared by the nav indicator and Settings → App, plus the two
 * dialogs of the update flow:
 *
 *  - Confirm (AlertDialog): the app will restart; if generation jobs are
 *    active the backend says so and the user must choose "Update anyway".
 *  - Progress (Dialog): the step list, live status, the log on demand, and
 *    the end states (updated → reload; failed; rolled back) with next steps.
 *
 * On mount it asks the backend for the last update's progress, so a page
 * that reloaded mid-update (the dev server restarts) picks the view back up.
 * While BlockFlow restarts, the version route is polled until the backend
 * answers, then the progress says what happened. What the dialogs show is one
 * state (`update-view.ts`); the effects below only dispatch events to it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { CheckCircle2, Circle, CircleSlash, Loader2, XCircle } from 'lucide-react'
import { AlertPanel } from '@/components/alert-panel'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  acknowledgeProgress,
  applyUpdate,
  checkForUpdates,
  dismissUpdate,
  fetchProgress,
  fetchUpdateStatus,
  fetchVersion,
  UPDATE_STATUS_URL,
  type UpdateStatus,
  type UpdateStep,
} from '@/lib/app-update/client'
import { createRequestGate } from '@/lib/resource'
import { cn } from '@/lib/utils'
import {
  CLOSED,
  canCloseProgress,
  isActiveProgress,
  needsManualRestart,
  progressHeadline,
  readRestart,
  updateViewReducer,
  type CloseThen,
  type UpdateView,
} from './update-view'

type ProgressState = Extract<UpdateView, { kind: 'progress' }>

export const STATUS_REFRESH_MS = 60 * 60 * 1000
export const PROGRESS_POLL_MS = 1000
export const RESTART_POLL_MS = 2000
export const RESTART_GIVE_UP_MS = 3 * 60 * 1000

interface AppUpdateContextValue {
  status: UpdateStatus | undefined
  error: Error | undefined
  isLoading: boolean
  /** Ask GitHub now (Settings → Check now). */
  checkNow: () => Promise<void>
  /** Re-read the status (after a pref changed). */
  refresh: () => Promise<void>
  dismiss: (action: 'skip' | 'later' | 'clear') => Promise<void>
  /** Open the confirmation for the latest release. */
  requestUpdate: () => void
  updating: boolean
}

const AppUpdateContext = createContext<AppUpdateContextValue | null>(null)

/** The update state, or null outside <AppUpdateProvider> (the indicator then renders nothing). */
export function useOptionalAppUpdate(): AppUpdateContextValue | null {
  return useContext(AppUpdateContext)
}

export function useAppUpdate(): AppUpdateContextValue {
  const ctx = useContext(AppUpdateContext)
  if (!ctx) throw new Error('useAppUpdate must be used inside <AppUpdateProvider>')
  return ctx
}

function StepIcon({ status }: { status: UpdateStep['status'] }) {
  if (status === 'done') return <CheckCircle2 aria-hidden className="text-success size-4" />
  if (status === 'failed') return <XCircle aria-hidden className="text-destructive size-4" />
  if (status === 'skipped') return <CircleSlash aria-hidden className="text-muted-foreground size-4" />
  if (status === 'running') return <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
  return <Circle aria-hidden className="text-muted-foreground size-4" />
}

const STEP_STATUS_TEXT: Record<UpdateStep['status'], string> = {
  pending: 'waiting', running: 'in progress', done: 'done', skipped: 'skipped', failed: 'failed',
}

function Commands({ commands }: { commands: string[] }) {
  if (commands.length === 0) return null
  return (
    <pre
      aria-label="Commands to run in the app folder"
      className="bg-muted/40 max-h-40 overflow-auto rounded-md border border-border/60 p-2 font-mono text-2xs whitespace-pre-wrap"
    >
      {commands.join('\n')}
    </pre>
  )
}

function ProgressView({
  view, onClose, onReload,
}: {
  view: ProgressState
  onClose: () => void
  onReload: () => void
}) {
  const [showLog, setShowLog] = useState(false)
  const { progress, connection, closing } = view
  const gaveUp = connection === 'gave_up'
  const active = isActiveProgress(progress)
  const current = progress.steps.find((s) => s.id === progress.step)
  const title = progressHeadline(view)
  const announcement = active ? `${title} ${current ? current.label : ''}` : `${title}. ${progress.error ?? progress.message ?? ''}`
  const manualRestart = needsManualRestart(progress)
  const busy = closing.kind === 'pending'
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {progress.from_version && progress.to_version
            ? `BlockFlow ${progress.from_version} → ${progress.to_version}`
            : 'BlockFlow update'}
        </DialogDescription>
      </DialogHeader>
      <p aria-live="polite" role="status" className="sr-only">{announcement}</p>
      <ol aria-label="Update steps" className="space-y-1.5">
        {progress.steps.map((s) => (
          <li key={s.id} className="flex items-start gap-2 text-sm" data-testid={`update-step-${s.id}`} data-status={s.status}>
            <span className="mt-0.5"><StepIcon status={s.status} /></span>
            <span className="min-w-0 flex-1">
              <span className={cn(s.status === 'pending' || s.status === 'skipped' ? 'text-muted-foreground' : '')}>{s.label}</span>
              <span className="sr-only">: {STEP_STATUS_TEXT[s.status]}</span>
              {s.detail && <span className="text-muted-foreground block text-2xs">{s.detail}</span>}
            </span>
          </li>
        ))}
      </ol>
      {progress.state === 'restarting' && gaveUp && (
        <AlertPanel variant="warning" title="Restart it yourself">
          <p>Stop BlockFlow (Ctrl+C in its terminal) and start it again in the app folder:</p>
          <Commands commands={[progress.restart?.command ?? 'uv run app.py']} />
        </AlertPanel>
      )}
      {progress.state === 'done' && !manualRestart && (
        <AlertPanel variant="info" title={`BlockFlow ${progress.to_version} is running`}>
          <p>Reload the page to use the new version.</p>
        </AlertPanel>
      )}
      {manualRestart && (
        <AlertPanel variant="info" title="Restart BlockFlow to finish">
          <p>{progress.message}</p>
          <Commands commands={[progress.restart?.command ?? 'uv run app.py']} />
        </AlertPanel>
      )}
      {(progress.state === 'failed' || progress.state === 'rolled_back') && (
        <AlertPanel variant={progress.state === 'failed' ? 'error' : 'warning'}
          title={progress.state === 'failed' ? 'The update did not finish' : 'Nothing changed'}>
          {progress.error && <p>{progress.error}</p>}
          {progress.state === 'rolled_back' && progress.message && <p>{progress.message}</p>}
          {progress.manual.length > 0 && (
            <>
              <p className="text-muted-foreground">
                {progress.state === 'failed' ? 'Run these commands in the app folder:' : 'To update by hand instead, run these in the app folder:'}
              </p>
              <Commands commands={progress.manual} />
            </>
          )}
        </AlertPanel>
      )}
      <div>
        <Button type="button" variant="link" size="xs" className="px-0" aria-expanded={showLog} onClick={() => setShowLog((v) => !v)}>
          {showLog ? 'Hide details' : 'Show details'}
        </Button>
        {showLog && (
          <pre aria-label="Update log" className="bg-muted/40 mt-1 max-h-48 overflow-auto rounded-md border border-border/60 p-2 font-mono text-3xs whitespace-pre-wrap">
            {progress.log_tail.length ? progress.log_tail.join('\n') : 'No output yet.'}
          </pre>
        )}
      </div>
      {closing.kind === 'error' && <AlertPanel variant="error">{closing.message}</AlertPanel>}
      <DialogFooter>
        {active && !gaveUp && <p className="text-muted-foreground text-xs">Keep this tab open. BlockFlow restarts by itself.</p>}
        {progress.state === 'done' && !manualRestart && <Button type="button" disabled={busy} onClick={onReload}>Reload</Button>}
        {(!active || gaveUp) && (
          <Button type="button" variant={progress.state === 'done' && !manualRestart ? 'outline' : 'default'} disabled={busy} onClick={onClose}>
            Close
          </Button>
        )}
      </DialogFooter>
    </>
  )
}

const ACK_FAILED = 'Could not close the update report. Try again.'
const DISMISS_FAILED: Record<'skip' | 'later' | 'clear', string> = {
  skip: 'Could not hide the update notice. Try again.',
  later: 'Could not hide the update notice. Try again.',
  clear: 'Could not show the update notice again. Try again.',
}

export function AppUpdateProvider({ children, reload }: { children: ReactNode; reload?: () => void }) {
  const { data: status, error, isLoading, mutate } = useSWR<UpdateStatus, Error>(UPDATE_STATUS_URL, fetchUpdateStatus, {
    refreshInterval: STATUS_REFRESH_MS, revalidateOnFocus: false, shouldRetryOnError: false,
  })
  const [view, dispatch] = useReducer(updateViewReducer, CLOSED)
  // The page-load progress read is stale once an update is started here.
  const [resumeGate] = useState(createRequestGate)

  // Resume a view the page lost (reload during an update, or a finished update to report).
  useEffect(() => {
    let cancelled = false
    const token = resumeGate.begin()
    fetchProgress()
      .then((p) => { if (!cancelled && resumeGate.isCurrent(token)) dispatch({ type: 'progress_resumed', progress: p }) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [resumeGate])

  // Poll while an update runs; poll the version while BlockFlow restarts.
  const state = view.kind === 'progress' ? view.progress.state : null
  useEffect(() => {
    if (state !== 'running' && state !== 'restarting') return
    let cancelled = false
    const since = Date.now()
    const tick = async () => {
      if (state === 'running') {
        try {
          const p = await fetchProgress()
          if (!cancelled) dispatch({ type: 'progress_read', progress: p })
        } catch { /* the backend may be busy; try again */ }
        return
      }
      const events = await readRestart({ fetchVersion, fetchProgress })
      if (cancelled) return
      for (const event of events) dispatch(event)
      if (Date.now() - since > RESTART_GIVE_UP_MS) dispatch({ type: 'restart_timed_out' })
    }
    const id = setInterval(() => void tick(), state === 'running' ? PROGRESS_POLL_MS : RESTART_POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [state])

  const starting = view.kind === 'confirm' && view.phase.kind === 'starting'
  const start = useCallback(async (allowActiveJobs: boolean) => {
    const tag = status?.latest?.tag
    if (!tag || starting) return
    resumeGate.invalidate()
    dispatch({ type: 'start_requested' })
    try {
      const res = await applyUpdate(tag, allowActiveJobs)
      if (res.ok) dispatch({ type: 'start_succeeded', progress: res.progress })
      else if (res.blockers.length) dispatch({ type: 'start_blocked', blockers: res.blockers })
      else dispatch({ type: 'start_failed', message: res.detail })
    } catch {
      dispatch({ type: 'start_failed', message: 'Could not reach BlockFlow to start the update.' })
    }
  }, [status?.latest?.tag, starting, resumeGate])

  // Closing the report acknowledges it, so it does not come back on the next
  // page load. A failed acknowledge keeps the dialog open; Close tries again.
  const closeProgress = useCallback(async (then: CloseThen) => {
    if (!canCloseProgress(view)) return
    dispatch({ type: 'close_requested', then })
    try {
      await acknowledgeProgress()
    } catch {
      // While BlockFlow has not come back the backend cannot answer; closing must still work.
      if (view.kind === 'progress' && view.connection === 'gave_up' && then === 'close') {
        dispatch({ type: 'close_done' })
        return
      }
      dispatch({ type: 'close_failed', message: ACK_FAILED })
      return
    }
    dispatch({ type: 'close_done' })
    if (then === 'reload') (reload ?? (() => window.location.reload()))()
    else await mutate().catch(() => undefined)
  }, [view, mutate, reload])

  const value = useMemo<AppUpdateContextValue>(() => ({
    status, error, isLoading,
    checkNow: async () => { await mutate(checkForUpdates(), { revalidate: false }) },
    refresh: async () => { await mutate() },
    dismiss: async (action) => {
      const tag = status?.latest?.tag
      if (!tag) return
      try {
        await mutate(dismissUpdate(tag, action), { revalidate: false })
      } catch {
        toast.error(DISMISS_FAILED[action])
      }
    },
    requestUpdate: () => dispatch({ type: 'confirm_opened' }),
    updating: view.kind === 'progress' && isActiveProgress(view.progress),
  }), [status, error, isLoading, mutate, view])

  const phase = view.kind === 'confirm' ? view.phase : null
  const blockers = phase && phase.kind !== 'idle' ? phase.blockers : []
  const onlyActiveJobs = blockers.length > 0 && blockers.every((b) => b.code === 'active_jobs')
  const startError = phase?.kind === 'error' ? phase.message : null
  const latest = status?.latest
  const closable = canCloseProgress(view)

  return (
    <AppUpdateContext.Provider value={value}>
      {children}
      <AlertDialog open={view.kind === 'confirm'} onOpenChange={(open) => { if (!open) dispatch({ type: 'confirm_cancelled' }) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update to {latest?.tag}?</AlertDialogTitle>
            <AlertDialogDescription>
              BlockFlow downloads {latest?.tag} from GitHub, installs it and restarts. This page reconnects by itself.
              Your files, settings, outputs and private blocks are not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {blockers.length > 0 && (
            <AlertPanel variant={onlyActiveJobs ? 'warning' : 'error'}
              title={onlyActiveJobs ? 'Generation jobs are running' : 'BlockFlow cannot update right now'}>
              <ul className="list-disc space-y-1 pl-4">
                {blockers.map((b) => <li key={b.code}>{b.message}</li>)}
              </ul>
            </AlertPanel>
          )}
          {startError && <AlertPanel variant="error">{startError}</AlertPanel>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={starting}>Cancel</AlertDialogCancel>
            {onlyActiveJobs ? (
              <Button type="button" variant="destructive" disabled={starting} onClick={() => void start(true)}>
                Update anyway
              </Button>
            ) : (
              <Button type="button" disabled={starting || phase?.kind === 'blocked'} onClick={() => void start(false)}>
                {starting && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
                Update and restart
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={view.kind === 'progress'} onOpenChange={(open) => { if (!open) void closeProgress('close') }}>
        <DialogContent showCloseButton={closable || (view.kind === 'progress' && view.closing.kind === 'pending')} className="sm:max-w-lg">
          {view.kind === 'progress' && (
            <ProgressView view={view} onClose={() => void closeProgress('close')} onReload={() => void closeProgress('reload')} />
          )}
        </DialogContent>
      </Dialog>
    </AppUpdateContext.Provider>
  )
}
