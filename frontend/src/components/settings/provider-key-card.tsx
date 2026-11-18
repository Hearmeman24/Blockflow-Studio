'use client'

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { toast } from 'sonner'

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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  deleteCredential,
  maskedKey,
  refreshProviderCatalog,
  setCredential,
  validateProviderKey,
  type CredentialStatus,
  type KeyCheckResult,
  type KeyProvider,
} from '@/lib/settings/client'

import { createRequestGate, errorMessage } from '@/lib/resource'
import { cn } from '@/lib/utils'

import { ProviderSignUpLink } from './provider-keys'

interface Props {
  status: CredentialStatus
  /** Card heading, e.g. "Kie". */
  title: string
  /** Name used in labels and messages, e.g. "Kie" -> "Kie API key". */
  keyLabel: string
  description?: string
  helper: string
  /** Set for Kie and PiAPI: enables "Check key" and the sign-up link. */
  provider?: KeyProvider
  /** A key check for a credential that is not a generation provider (OpenRouter). */
  checkKey?: () => Promise<KeyCheckResult>
  /** Called after the key is saved or removed. */
  onKeyChange?: () => void
  className?: string
  onStatusChange: (status: CredentialStatus) => void
}

type Check =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'result'; result: KeyCheckResult }
  | { kind: 'error' }

/** What the card is doing. The form is open while editing or saving; a failed
 * save returns to editing with the reason. */
type Mode =
  | { kind: 'view' }
  | { kind: 'editing'; error: string | null }
  | { kind: 'saving' }
  | { kind: 'removing' }

function formatBalance(result: KeyCheckResult): string | null {
  if (result.balance === undefined || result.balance === null) return null
  return `Balance: ${result.balance}${result.balance_unit ? ` ${result.balance_unit}` : ''}`
}

export function ProviderKeyCard({
  status, title, keyLabel, description, helper, provider, checkKey, onKeyChange, className, onStatusChange,
}: Props) {
  const runCheck = checkKey ?? (provider ? () => validateProviderKey(provider) : undefined)
  const titleId = useId()
  const inputId = useId()
  const helperId = useId()
  const [mode, setMode] = useState<Mode>({ kind: 'view' })
  const [draft, setDraft] = useState('')
  const [check, setCheck] = useState<Check>({ kind: 'idle' })
  // A check answers for the key that was saved when it started: saving or
  // removing a key makes a check still in flight stale, so its late answer is
  // dropped instead of showing "Valid" or a balance for a key that is gone.
  const [checkGate] = useState(createRequestGate)
  const inputRef = useRef<HTMLInputElement>(null)
  const actionRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)

  const formOpen = mode.kind === 'editing' || mode.kind === 'saving'
  const saving = mode.kind === 'saving'
  const removing = mode.kind === 'removing'
  const saveError = mode.kind === 'editing' ? mode.error : null

  useEffect(() => {
    if (formOpen) inputRef.current?.focus()
    else if (restoreFocus.current) {
      restoreFocus.current = false
      actionRef.current?.focus()
    }
  }, [formOpen, status.configured])

  useEffect(() => () => checkGate.invalidate(), [checkGate])

  const closeForm = () => {
    restoreFocus.current = true
    setMode({ kind: 'view' })
    setDraft('')
  }

  const forgetCheck = () => {
    checkGate.invalidate()
    setCheck({ kind: 'idle' })
  }

  const handleSave = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft.trim() || mode.kind !== 'editing') return
    setMode({ kind: 'saving' })
    try {
      const next = await setCredential(status.name, draft)
      onStatusChange(next)
      forgetCheck()
      closeForm()
      if (provider) refreshProviderCatalog()
      onKeyChange?.()
      toast.success(`${keyLabel} key saved.`)
    } catch (err) {
      setMode({ kind: 'editing', error: errorMessage(err) })
    }
  }

  const handleRemove = async () => {
    if (mode.kind !== 'view') return
    setMode({ kind: 'removing' })
    try {
      await deleteCredential(status.name)
      onStatusChange({ ...status, configured: false, last4: null, updated_at: null })
      forgetCheck()
      if (provider) refreshProviderCatalog()
      onKeyChange?.()
      toast.success(`${keyLabel} key removed.`)
    } catch (err) {
      toast.error(`Could not remove the ${keyLabel} key: ${errorMessage(err)}`)
    } finally {
      setMode({ kind: 'view' })
    }
  }

  const handleCheck = async () => {
    if (!runCheck) return
    const token = checkGate.begin()
    setCheck({ kind: 'checking' })
    try {
      const result = await runCheck()
      if (checkGate.isCurrent(token)) setCheck({ kind: 'result', result })
    } catch {
      if (checkGate.isCurrent(token)) setCheck({ kind: 'error' })
    }
  }

  const onFormKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeForm()
    }
  }

  return (
    <Card role="region" aria-labelledby={titleId} className={cn('gap-4 py-5', className)}>
      <CardHeader className="px-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle id={titleId} className="text-base">{title}</CardTitle>
          <StatusBadge variant={status.configured ? 'success' : 'neutral'}>
            {status.configured ? 'Configured' : 'Not configured'}
          </StatusBadge>
        </div>
        {description && <CardDescription className="text-xs">{description}</CardDescription>}
      </CardHeader>

      <CardContent className="space-y-3 px-5">
        {status.configured && (
          <p className="text-xs text-muted-foreground">
            Saved key: <span className="font-mono text-foreground">{maskedKey(status.last4)}</span>
          </p>
        )}

        {formOpen ? (
          <form className="space-y-2" onSubmit={handleSave} onKeyDown={onFormKeyDown} noValidate>
            <Label htmlFor={inputId}>
              {status.configured ? `New ${keyLabel} API key` : `${keyLabel} API key`}
            </Label>
            <Input
              ref={inputRef}
              id={inputId}
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={helperId}
              aria-invalid={saveError ? true : undefined}
              className="font-mono"
            />
            <p id={helperId} className="text-xs text-muted-foreground">{helper}</p>
            {saveError && (
              <p role="alert" className="text-xs text-destructive">{saveError}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" variant="secondary" disabled={!draft.trim() || saving}>
                {saving ? 'Saving…' : 'Save key'}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={closeForm} disabled={saving}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              ref={actionRef}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setMode({ kind: 'editing', error: null })}
              disabled={removing}
            >
              {status.configured ? 'Replace key' : 'Add key'}
            </Button>
            {status.configured && runCheck && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void handleCheck()}
                disabled={check.kind === 'checking' || removing}
              >
                {check.kind === 'checking' ? 'Checking…' : 'Check key'}
              </Button>
            )}
            {status.configured && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button type="button" size="sm" variant="ghost" className="text-destructive" disabled={removing}>
                    {removing ? 'Removing…' : 'Remove'}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove the {keyLabel} API key?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The key is deleted from this machine. Anything that needs it stops working until you add a key again.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-white hover:bg-destructive/90"
                      onClick={() => void handleRemove()}
                    >
                      Remove key
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        )}

        {runCheck && (
          <div role="status" aria-live="polite" className="space-y-1 text-xs">
            <CheckOutcome check={check} keyLabel={keyLabel} />
          </div>
        )}

        {provider && <ProviderSignUpLink provider={provider} />}
      </CardContent>
    </Card>
  )
}

function CheckOutcome({ check, keyLabel }: { check: Check; keyLabel: string }) {
  if (check.kind === 'idle') return null
  if (check.kind === 'checking') {
    return <p className="text-muted-foreground">Checking the {keyLabel} key…</p>
  }
  if (check.kind === 'error') {
    return (
      <p className="text-muted-foreground">
        <StatusBadge variant="warning" className="mr-2">Not checked</StatusBadge>
        Could not check the key. Make sure BlockFlow is running, then try again.
      </p>
    )
  }
  const { result } = check
  const balance = formatBalance(result)
  if (!result.ok || result.valid === null) {
    return (
      <p className="text-muted-foreground">
        <StatusBadge variant="warning" className="mr-2">Not checked</StatusBadge>
        {result.message}
      </p>
    )
  }
  return (
    <>
      <p className="text-muted-foreground">
        <StatusBadge variant={result.valid ? 'success' : 'error'} className="mr-2">
          {result.valid ? 'Valid' : 'Invalid'}
        </StatusBadge>
        {result.message}
      </p>
      {result.valid && balance && <p className="text-muted-foreground">{balance}</p>}
    </>
  )
}
