'use client'

import { useId, useState, type FormEvent } from 'react'
import { toast } from 'sonner'

import { OutputFolderField } from '@/components/settings/output-folder-field'
import { ProviderSignUpLink, PROVIDER_KEY_SPECS, providerLabel } from '@/components/settings/provider-keys'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ensureAssetStorageModeDefault,
  refreshProviderCatalog,
  setCredential,
  setOnboardingCompleted,
  validateProviderKey,
  type KeyProvider,
} from '@/lib/settings/client'
import { errorMessage, useResource } from '@/lib/resource'
import { getOutputFolder, saveOutputFolder } from '@/lib/settings/output-folder'

interface Props {
  open: boolean
  /** Called after onboarding is marked completed (saved or skipped). */
  onFinished: () => void
}

/** idle (with the last error, if any), or the action in progress. */
type Phase =
  | { kind: 'idle'; error: string | null }
  | { kind: 'saving' }
  | { kind: 'skipping' }

/** What this dialog already stored, and the value it stored. A retry after a
 * partial failure skips a step whose value has not changed since. */
interface Stored {
  folder?: string
  keys: Partial<Record<KeyProvider, string>>
}

/** Fire-and-forget key checks after saving; results arrive as toasts. */
function checkKeysInBackground(providers: KeyProvider[]) {
  for (const provider of providers) {
    validateProviderKey(provider)
      .then((result) => {
        const label = providerLabel(provider)
        if (result.ok && result.valid === true) {
          const balance = result.balance !== undefined && result.balance !== null
            ? ` Balance: ${result.balance}${result.balance_unit ? ` ${result.balance_unit}` : ''}.`
            : ''
          toast.success(`${label} key works.${balance}`)
        } else if (result.ok && result.valid === false) {
          toast.warning(`${label} key check: ${result.message}`)
        }
      })
      .catch(() => {
        // The check is optional; Settings → API keys can run it again.
      })
  }
}

/** First-start dialog: explains BYOK, collects a Kie and/or PiAPI key and
 * the output folder (pre-filled with the folder in use). */
export function OnboardingDialog({ open, onFinished }: Props) {
  const ids = { kie: useId(), piapi: useId() }
  const [values, setValues] = useState<Record<KeyProvider, string>>({ kie: '', piapi: '' })
  const [phase, setPhase] = useState<Phase>({ kind: 'idle', error: null })
  const [statusText, setStatusText] = useState('')
  const [stored, setStored] = useState<Stored>({ keys: {} })
  // The folder in use, read when the dialog opens. A failed read leaves the
  // field empty (the default folder); it is not an error for onboarding.
  const { resource: folderLoad } = useResource(() => getOutputFolder(), [open], { enabled: open })
  // What the user typed or chose; null follows the folder loaded at open.
  const [folderDraft, setFolderDraft] = useState<string | null>(null)

  const busy = phase.kind === 'saving' ? 'saving' : phase.kind === 'skipping' ? 'skipping' : null
  const error = phase.kind === 'idle' ? phase.error : null
  const initialFolder = folderLoad.kind === 'ready'
    ? folderLoad.data.configured ?? folderLoad.data.in_use
    : ''
  const folder = folderDraft ?? initialFolder
  const folderChanged = folderLoad.kind !== 'loading' && folder.trim() !== '' && folder.trim() !== initialFolder
  const entered = PROVIDER_KEY_SPECS.filter((s) => values[s.provider].trim())
  const canSave = (entered.length > 0 || folderChanged) && busy === null

  const finish = async () => {
    await ensureAssetStorageModeDefault()
    await setOnboardingCompleted()
  }

  const handleSave = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!canSave) return
    setPhase({ kind: 'saving' })
    setStatusText('Saving…')
    // Record each step as it succeeds, so a retry only does what is left.
    const done: Stored = { folder: stored.folder, keys: { ...stored.keys } }
    const savedNow: KeyProvider[] = []
    const targetFolder = folderChanged ? folder.trim() : undefined
    try {
      if (targetFolder !== undefined && done.folder !== targetFolder) {
        try {
          await saveOutputFolder(targetFolder)
        } catch (err) {
          throw new Error(`Could not use that folder: ${errorMessage(err)}`)
        }
        done.folder = targetFolder
      }
      for (const spec of entered) {
        const value = values[spec.provider]
        if (done.keys[spec.provider] === value) continue
        try {
          await setCredential(spec.credential, value)
        } catch (err) {
          throw new Error(`Could not save the ${spec.label} key: ${errorMessage(err)}`)
        }
        done.keys[spec.provider] = value
        savedNow.push(spec.provider)
      }
      if (savedNow.length) refreshProviderCatalog()
      await finish()
    } catch (err) {
      if (savedNow.length) refreshProviderCatalog()
      setStored(done)
      setStatusText('')
      setPhase({ kind: 'idle', error: errorMessage(err) })
      return
    }
    setStored(done)
    // Report what this dialog stored, including steps saved by an earlier attempt.
    const keysSaved = entered.map((spec) => spec.provider).filter((p) => done.keys[p] === values[p])
    setStatusText('Saved.')
    if (keysSaved.length) toast.success('Keys saved. You can change them any time in Settings → API keys.')
    if (targetFolder !== undefined) {
      toast.info(`New files are saved to ${targetFolder}. You can change it in Settings → App.`)
    }
    checkKeysInBackground(keysSaved)
    setPhase({ kind: 'idle', error: null })
    onFinished()
  }

  const handleSkip = async () => {
    if (busy) return
    setPhase({ kind: 'skipping' })
    try {
      await finish()
    } catch (err) {
      setPhase({ kind: 'idle', error: `Could not finish setup: ${errorMessage(err)}` })
      return
    }
    toast.info('You can add your Kie or PiAPI key later in Settings → API keys.')
    setPhase({ kind: 'idle', error: null })
    onFinished()
  }

  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        // Leaving the dialog is an explicit choice: "Skip for now" or save.
        // Escape or a stray click must not throw away typed keys.
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <form className="grid gap-5" onSubmit={handleSave} noValidate>
          <DialogHeader>
            <DialogTitle>Welcome to BlockFlow</DialogTitle>
            <DialogDescription>
              You bring your own Kie or PiAPI key; you pay the provider directly. Either key is enough to
              start, and keys are stored locally on this machine.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            {PROVIDER_KEY_SPECS.map((spec, index) => (
              <div key={spec.provider} className="grid gap-1.5">
                <Label htmlFor={ids[spec.provider]}>{spec.label} API key</Label>
                <Input
                  id={ids[spec.provider]}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus={index === 0}
                  className="font-mono"
                  value={values[spec.provider]}
                  onChange={(e) => setValues((v) => ({ ...v, [spec.provider]: e.target.value }))}
                  disabled={busy !== null}
                />
                <ProviderSignUpLink provider={spec.provider} />
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Some models are only available with a Kie key. You can add or change keys later in Settings.
            </p>
          </div>

          <section className="grid gap-1.5 border-t pt-4">
            {folderLoad.kind === 'loading' ? (
              <div className="grid gap-2" aria-busy="true">
                <span className="sr-only">Loading the output folder…</span>
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : (
              <OutputFolderField
                value={folder}
                onChange={setFolderDraft}
                picker={folderLoad.kind === 'ready' ? folderLoad.data.picker : null}
                disabled={busy !== null}
                note={folderLoad.kind === 'error'
                  ? "Couldn't read the default folder. Leave it empty to use the default folder."
                  : undefined}
              />
            )}
          </section>

          {error && (
            <p role="alert" className="text-xs text-destructive">{error}</p>
          )}
          <p role="status" aria-live="polite" className="sr-only">{statusText}</p>

          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => void handleSkip()} disabled={busy !== null}>
              {busy === 'skipping' ? 'Finishing…' : 'Skip for now'}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {busy === 'saving' ? 'Saving…' : 'Save and continue'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
