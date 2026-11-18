'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { AlertPanel } from '@/components/alert-panel'
import { StatusBadge } from '@/components/status-badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  forgetOutputFolder,
  getOutputFolder,
  saveOutputFolder,
  type OutputFolderStatus,
} from '@/lib/settings/output-folder'

import { OutputFolderField } from './output-folder-field'

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; status: OutputFolderStatus }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Settings → App: the output folder in use, a field to change it (with the
 * native folder dialog), and the earlier folders BlockFlow still reads. A
 * change applies immediately; nothing is moved or deleted. */
export function OutputFolderSetting() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getOutputFolder()
      .then((status) => {
        if (cancelled) return
        setLoad({ kind: 'ready', status })
        setDraft(status.configured ?? status.in_use)
      })
      .catch((err) => {
        if (!cancelled) setLoad({ kind: 'error', message: errorMessage(err) })
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  const reload = () => setAttempt((n) => n + 1)
  const saved = load.kind === 'ready' ? load.status.configured ?? load.status.in_use : ''
  const canSave = load.kind === 'ready' && !saving && draft.trim() !== '' && draft.trim() !== saved

  const persist = async (value: string) => {
    setSaving(true)
    setError(null)
    try {
      await saveOutputFolder(value)
      toast.success(value
        ? `New files are saved to ${value}. Earlier files stay where they are and remain available.`
        : 'New files are saved to the default folder. Earlier files stay where they are and remain available.')
      reload()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const stopReading = async (path: string) => {
    try {
      const status = await forgetOutputFolder(path)
      setLoad({ kind: 'ready', status })
      toast.success(`BlockFlow no longer reads ${path}. Its files were not touched.`)
    } catch (err) {
      toast.error(`Could not update the list: ${errorMessage(err)}`)
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">Output folder</h2>

      {load.kind === 'loading' && (
        <div className="space-y-2" aria-busy="true">
          <span className="sr-only">Loading the output folder…</span>
          <Skeleton className="h-3 w-64" />
          <Skeleton className="h-9 w-full" />
        </div>
      )}

      {load.kind === 'error' && (
        <AlertPanel variant="error" title="Could not load the output folder">
          <p>{load.message}</p>
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => {
            setLoad({ kind: 'loading' })
            reload()
          }}>
            Retry
          </Button>
        </AlertPanel>
      )}

      {load.kind === 'ready' && (
        <>
          <p className="text-xs text-muted-foreground">
            In use now: <span className="break-all font-mono text-foreground">{load.status.in_use}</span>
          </p>

          {load.status.configured_unavailable && load.status.configured && (
            <AlertPanel variant="warning">
              <p>
                The saved folder <span className="break-all font-mono">{load.status.configured}</span> isn&apos;t
                available (for example, an unplugged drive), so new files go to the folder shown above until it
                is back.
              </p>
            </AlertPanel>
          )}

          <form
            className="space-y-2"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              if (canSave) void persist(draft.trim())
            }}
          >
            <OutputFolderField
              value={draft}
              onChange={(v) => {
                setDraft(v)
                setError(null)
              }}
              picker={load.status.picker}
              disabled={saving}
            />
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" variant="outline" disabled={!canSave}>
                {saving ? 'Saving…' : 'Save folder'}
              </Button>
              {load.status.configured && (
                <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => void persist('')}>
                  Use default folder
                </Button>
              )}
            </div>
          </form>

          {load.status.previous.length > 0 && (
            <div className="space-y-2 pt-2">
              <h3 className="text-sm font-medium">Earlier output folders</h3>
              <p className="text-xs text-muted-foreground">
                BlockFlow still reads files from these folders, so runs and flows that use them keep working.
              </p>
              <ul aria-label="Earlier output folders" className="space-y-1.5">
                {load.status.previous.map((item) => (
                  <li key={item.path} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 break-all font-mono">{item.path}</span>
                    {!item.available && <StatusBadge variant="warning">Not found</StatusBadge>}
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button type="button" size="xs" variant="ghost" aria-label={`Stop reading ${item.path}`}>
                          Stop reading
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Stop reading this folder?</AlertDialogTitle>
                          <AlertDialogDescription>
                            Files in <span className="break-all font-mono">{item.path}</span> that runs, flows
                            and loaders use will show as missing. Nothing is deleted; you can move the files into
                            the current folder yourself.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => void stopReading(item.path)}>
                            Stop reading
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  )
}
