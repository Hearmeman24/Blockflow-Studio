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
 * While BlockFlow restarts, the version route is polled until the new
 * backend answers.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import useSWR from 'swr'
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
  type Blocker,
  type UpdateProgress,
  type UpdateStatus,
  type UpdateStep,
} from '@/lib/app-update/client'
import { ACTIVE_UPDATE_STATES } from '@/lib/status'
import { cn } from '@/lib/utils'

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

const ACTIVE: ReadonlySet<string> = new Set(ACTIVE_UPDATE_STATES)

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

function headline(p: UpdateProgress, reconnecting: boolean, gaveUp: boolean): string {
  if (p.state === 'running') return `Updating to ${p.tag ?? 'the new version'}…`
  if (p.state === 'restarting') return gaveUp ? 'BlockFlow has not come back yet' : reconnecting ? 'Restarting BlockFlow…' : 'Restarting…'
  if (p.state === 'done') return p.restart?.required && !p.restart.automatic ? 'Updated, restart needed' : `Updated to ${p.tag}`
  if (p.state === 'rolled_back') return 'Update undone'
  if (p.state === 'failed') return 'Update failed'
  return 'Update'
}

function ProgressView({
  progress, reconnecting, gaveUp, onClose, onReload,
}: {
  progress: UpdateProgress
  reconnecting: boolean
  gaveUp: boolean
  onClose: () => void
  onReload: () => void
}) {
  const [showLog, setShowLog] = useState(false)
  const active = ACTIVE.has(progress.state)
  const current = progress.steps.find((s) => s.id === progress.step)
  const title = headline(progress, reconnecting, gaveUp)
  const announcement = active ? `${title} ${current ? current.label : ''}` : `${title}. ${progress.error ?? progress.message ?? ''}`
  const manualRestart = progress.state === 'done' && progress.restart?.required && !progress.restart.automatic
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
      <DialogFooter>
        {active && !gaveUp && <p className="text-muted-foreground text-xs">Keep this tab open. BlockFlow restarts by itself.</p>}
        {progress.state === 'done' && !manualRestart && <Button type="button" onClick={onReload}>Reload</Button>}
        {(!active || gaveUp) && (
          <Button type="button" variant={progress.state === 'done' && !manualRestart ? 'outline' : 'default'} onClick={onClose}>
            Close
          </Button>
        )}
      </DialogFooter>
    </>
  )
}

export function AppUpdateProvider({ children, reload }: { children: ReactNode; reload?: () => void }) {
  const { data: status, error, isLoading, mutate } = useSWR<UpdateStatus, Error>(UPDATE_STATUS_URL, fetchUpdateStatus, {
    refreshInterval: STATUS_REFRESH_MS, revalidateOnFocus: false, shouldRetryOnError: false,
  })
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [blockers, setBlockers] = useState<Blocker[]>([])
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [gaveUp, setGaveUp] = useState(false)
  const restartStarted = useRef<number | null>(null)

  // Resume a view the page lost (reload during an update, or a finished update to report).
  useEffect(() => {
    let cancelled = false
    fetchProgress()
      .then((p) => { if (!cancelled && p.state !== 'idle') setProgress(p) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Poll while an update runs; poll the version while BlockFlow restarts.
  const state = progress?.state
  const target = progress?.to_version
  useEffect(() => {
    if (state !== 'running' && state !== 'restarting') return
    let cancelled = false
    const tick = async () => {
      if (state === 'running') {
        try {
          const p = await fetchProgress()
          if (!cancelled) setProgress(p)
        } catch { /* the backend may be busy; try again */ }
        return
      }
      restartStarted.current ??= Date.now()
      try {
        const v = await fetchVersion()
        if (cancelled) return
        if (v.version === target) {
          setReconnecting(false)
          const p = await fetchProgress()
          if (!cancelled) setProgress(p)
          return
        }
      } catch {
        if (!cancelled) setReconnecting(true)
      }
      if (!cancelled && Date.now() - (restartStarted.current ?? Date.now()) > RESTART_GIVE_UP_MS) setGaveUp(true)
    }
    const id = setInterval(() => void tick(), state === 'running' ? PROGRESS_POLL_MS : RESTART_POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [state, target])

  const start = useCallback(async (allowActiveJobs: boolean) => {
    const tag = status?.latest?.tag
    if (!tag) return
    setStarting(true)
    setStartError(null)
    try {
      const res = await applyUpdate(tag, allowActiveJobs)
      if (res.ok) {
        setConfirmOpen(false)
        setBlockers([])
        restartStarted.current = null
        setGaveUp(false)
        setProgress(res.progress)
      } else if (res.blockers.length) {
        setBlockers(res.blockers)
      } else {
        setStartError(res.detail)
      }
    } catch {
      setStartError('Could not reach BlockFlow to start the update.')
    } finally {
      setStarting(false)
    }
  }, [status?.latest?.tag])

  const closeProgress = useCallback(async () => {
    setProgress(null)
    setGaveUp(false)
    restartStarted.current = null
    await acknowledgeProgress().catch(() => {})
    await mutate()
  }, [mutate])

  const value = useMemo<AppUpdateContextValue>(() => ({
    status, error, isLoading,
    checkNow: async () => { await mutate(checkForUpdates(), { revalidate: false }) },
    refresh: async () => { await mutate() },
    dismiss: async (action) => {
      const tag = status?.latest?.tag
      if (tag) await mutate(dismissUpdate(tag, action), { revalidate: false })
    },
    requestUpdate: () => {
      setBlockers([])
      setStartError(null)
      setConfirmOpen(true)
    },
    updating: !!progress && ACTIVE.has(progress.state),
  }), [status, error, isLoading, mutate, progress])

  const onlyActiveJobs = blockers.length > 0 && blockers.every((b) => b.code === 'active_jobs')
  const latest = status?.latest

  return (
    <AppUpdateContext.Provider value={value}>
      {children}
      <AlertDialog open={confirmOpen} onOpenChange={(open) => { if (!starting) setConfirmOpen(open) }}>
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
              <Button type="button" disabled={starting || (blockers.length > 0 && !onlyActiveJobs)} onClick={() => void start(false)}>
                {starting && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
                Update and restart
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={!!progress} onOpenChange={(open) => {
        if (!open && progress && (!ACTIVE.has(progress.state) || gaveUp)) void closeProgress()
      }}>
        <DialogContent showCloseButton={!!progress && (!ACTIVE.has(progress.state) || gaveUp)} className="sm:max-w-lg">
          {progress && (
            <ProgressView progress={progress} reconnecting={reconnecting} gaveUp={gaveUp}
              onClose={() => void closeProgress()}
              onReload={() => { void acknowledgeProgress().catch(() => {}).finally(() => (reload ?? (() => window.location.reload()))()) }} />
          )}
        </DialogContent>
      </Dialog>
    </AppUpdateContext.Provider>
  )
}
