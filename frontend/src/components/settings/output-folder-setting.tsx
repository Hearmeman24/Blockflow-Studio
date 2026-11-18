'use client'

import { useState } from 'react'
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
import { useMutation } from '@/lib/mutation'
import { errorMessage, useResource } from '@/lib/resource'
import {
  forgetOutputFolder,
  getOutputFolder,
  saveOutputFolder,
  type OutputFolderStatus,
} from '@/lib/settings/output-folder'

import { OutputFolderField } from './output-folder-field'

function savedFolder(status: OutputFolderStatus): string {
  return status.configured ?? status.in_use
}

/** Settings → App: the output folder in use, a field to change it (with the
 * native folder dialog), and the earlier folders BlockFlow still reads. A
 * change applies immediately; nothing is moved or deleted. */
export function OutputFolderSetting() {
  const { resource: load, retry, refresh, setData } = useResource(() => getOutputFolder(), [])
  // What the user typed; null follows the saved folder.
  const [draft, setDraft] = useState<string | null>(null)
  const saved = load.kind === 'ready' ? savedFolder(load.data) : ''
  const value = draft ?? saved

  const save = useMutation((next: string) => saveOutputFolder(next))
  const persist = async (next: string) => {
    const submitted = draft
    if ((await save.run(next)).status !== 'done') return
    toast.success(next
      ? `New files are saved to ${next}. Earlier files stay where they are and remain available.`
      : 'New files are saved to the default folder. Earlier files stay where they are and remain available.')
    // Re-read quietly: a failed read keeps the section (the change already
    // applies), and the field follows the saved folder only if the user has
    // not typed since.
    try {
      await refresh()
    } catch {
      setData((prev) => ({ ...prev, configured: next || null, in_use: next || prev.default, configured_unavailable: false }))
    }
    setDraft((current) => (current === submitted ? null : current))
  }
  const forget = useMutation(async (path: string) => {
    try {
      const status = await forgetOutputFolder(path)
      setData(() => status)
      toast.success(`BlockFlow no longer reads ${path}. Its files were not touched.`)
    } catch (err) {
      toast.error(`Could not update the list: ${errorMessage(err)}`)
    }
  })

  const saving = save.pending
  const canSave = load.kind === 'ready' && !saving && value.trim() !== '' && value.trim() !== saved

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
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={retry}>
            Retry
          </Button>
        </AlertPanel>
      )}

      {load.kind === 'ready' && (
        <>
          <p className="text-xs text-muted-foreground">
            In use now: <span className="break-all font-mono text-foreground">{load.data.in_use}</span>
          </p>

          {load.data.configured_unavailable && load.data.configured && (
            <AlertPanel variant="warning">
              <p>
                The saved folder <span className="break-all font-mono">{load.data.configured}</span> isn&apos;t
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
              if (canSave) void persist(value.trim())
            }}
          >
            <OutputFolderField
              value={value}
              onChange={(v) => {
                setDraft(v)
                save.reset()
              }}
              picker={load.data.picker}
              disabled={saving}
            />
            {save.state.kind === 'error' && (
              <p role="alert" className="text-xs text-destructive">{save.state.message}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" variant="outline" disabled={!canSave}>
                {saving ? 'Saving…' : 'Save folder'}
              </Button>
              {load.data.configured && (
                <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => void persist('')}>
                  Use default folder
                </Button>
              )}
            </div>
          </form>

          {load.data.previous.length > 0 && (
            <div className="space-y-2 pt-2">
              <h3 className="text-sm font-medium">Earlier output folders</h3>
              <p className="text-xs text-muted-foreground">
                BlockFlow still reads files from these folders, so runs and flows that use them keep working.
              </p>
              <ul aria-label="Earlier output folders" className="space-y-1.5">
                {load.data.previous.map((item) => (
                  <li key={item.path} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 break-all font-mono">{item.path}</span>
                    {!item.available && <StatusBadge variant="warning">Not found</StatusBadge>}
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          aria-label={`Stop reading ${item.path}`}
                          disabled={forget.pending}
                        >
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
                          <AlertDialogAction onClick={() => void forget.run(item.path)}>
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
