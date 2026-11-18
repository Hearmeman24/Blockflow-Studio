'use client'

import { useEffect, useId, useState, type FormEvent } from 'react'
import { toast } from 'sonner'

import { AlertPanel } from '@/components/alert-panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { refreshWriterProviders } from '@/lib/prompt-writer/api'
import { LOCAL_LLM_SERVERS, getAppPref, setAppPref, type LocalLlmServer } from '@/lib/settings/client'

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; values: Record<string, string> }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Base URLs of the local Ollama and LM Studio servers used by the Prompt
 * Writer block. The backend validates each URL (http/https, no credentials,
 * query or fragment) and stores it normalised; an empty value means the default.
 */
export function LocalLlmServers() {
  const headingId = useId()
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    Promise.all(LOCAL_LLM_SERVERS.map((s) => getAppPref(s.pref)))
      .then((values) => {
        if (cancelled) return
        setLoad({ kind: 'ready', values: Object.fromEntries(LOCAL_LLM_SERVERS.map((s, i) => [s.pref, values[i] ?? ''])) })
      })
      .catch((err) => {
        if (!cancelled) setLoad({ kind: 'error', message: errorMessage(err) })
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-xl border p-5">
      <div className="space-y-1">
        <h3 id={headingId} className="text-sm font-semibold">Local LLM servers</h3>
        <p className="text-xs leading-5 text-muted-foreground">
          Optional. The Prompt Writer block can use Ollama or LM Studio running on this computer or your network.
          A server shows up as available in the block only while it is running with a model.
        </p>
      </div>

      {load.kind === 'loading' && (
        <div aria-busy="true" className="space-y-3">
          <span className="sr-only">Loading local server settings…</span>
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-8 w-full" />
        </div>
      )}

      {load.kind === 'error' && (
        <AlertPanel variant="error" title="Could not load the local server settings">
          <p>{load.message}</p>
          <Button type="button" size="sm" variant="outline" className="mt-2"
            onClick={() => { setLoad({ kind: 'loading' }); setAttempt((n) => n + 1) }}>
            Retry
          </Button>
        </AlertPanel>
      )}

      {load.kind === 'ready' && LOCAL_LLM_SERVERS.map((server) => (
        <ServerUrlField key={server.id} server={server} saved={load.values[server.pref] ?? ''} />
      ))}
    </section>
  )
}

function ServerUrlField({ server, saved }: { server: LocalLlmServer; saved: string }) {
  const inputId = useId()
  const hintId = useId()
  const [current, setCurrent] = useState(saved)
  const [draft, setDraft] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (value: string) => {
    setSaving(true)
    setError(null)
    try {
      await setAppPref(server.pref, value)
      const stored = value.trim() ? (await getAppPref(server.pref)) ?? '' : ''
      setCurrent(stored)
      setDraft(stored)
      refreshWriterProviders()
      toast.success(value.trim() ? `${server.label} URL saved.` : `${server.label} URL reset to the default.`)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!saving) void save(draft)
  }

  const changed = draft.trim() !== current.trim()
  return (
    <form className="space-y-1.5" onSubmit={onSubmit} noValidate>
      <Label htmlFor={inputId}>{server.label} URL</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={inputId}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setError(null) }}
          placeholder={server.defaultUrl}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={hintId}
          aria-invalid={error ? true : undefined}
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button type="submit" size="sm" variant="outline" disabled={saving || !changed}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {current && (
          <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => void save('')}>
            Use default
          </Button>
        )}
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        {current ? `Using ${current}.` : `Using the default, ${server.defaultUrl}.`}
      </p>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </form>
  )
}
