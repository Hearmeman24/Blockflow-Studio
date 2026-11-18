'use client'

import { useEffect, useState } from 'react'

import { AlertPanel } from '@/components/alert-panel'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  listCredentials,
  type CredentialName,
  type CredentialStatus,
} from '@/lib/settings/client'

import { checkOpenRouterKey, refreshWriterProviders } from '@/lib/prompt-writer/api'

import { LocalLlmServers } from './local-llm-servers'
import { ProviderKeyCard } from './provider-key-card'
import { PROVIDER_KEY_SPECS } from './provider-keys'

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; statuses: Record<CredentialName, CredentialStatus> }

function unconfigured(name: CredentialName): CredentialStatus {
  return { name, configured: false, last4: null, updated_at: null }
}

function toRecord(list: CredentialStatus[]): Record<CredentialName, CredentialStatus> {
  const record = {
    kie_api_key: unconfigured('kie_api_key'),
    piapi_api_key: unconfigured('piapi_api_key'),
    openrouter_api_key: unconfigured('openrouter_api_key'),
  }
  for (const status of list) {
    if (status.name in record) record[status.name] = status
  }
  return record
}

export function ApiKeysTab() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    listCredentials()
      .then((list) => {
        if (!cancelled) setLoad({ kind: 'ready', statuses: toRecord(list) })
      })
      .catch((err) => {
        if (!cancelled) setLoad({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  const retry = () => {
    setLoad({ kind: 'loading' })
    setAttempt((n) => n + 1)
  }

  const update = (next: CredentialStatus) => {
    setLoad((prev) => (prev.kind === 'ready'
      ? { kind: 'ready', statuses: { ...prev.statuses, [next.name]: next } }
      : prev))
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-base font-semibold">API keys</h2>
        <p className="text-xs leading-5 text-muted-foreground">
          BlockFlow is bring-your-own-key: you use your own Kie or PiAPI account and pay the provider directly.
          Keys are stored locally on this machine and are never shown again after you save them.
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          Which models you can pick depends on which keys are configured. Some models are only available with a Kie key.
        </p>
      </section>

      {load.kind === 'loading' && (
        <div aria-busy="true" className="space-y-4">
          <span className="sr-only">Loading API keys…</span>
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-3 rounded-xl border p-5">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-20" />
              </div>
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-8 w-28" />
            </div>
          ))}
        </div>
      )}

      {load.kind === 'error' && (
        <AlertPanel variant="error" title="Could not load your API keys">
          <p>{load.message}</p>
          <Button type="button" size="sm" variant="outline" onClick={retry} className="mt-2">
            Retry
          </Button>
        </AlertPanel>
      )}

      {load.kind === 'ready' && (
        <div className="space-y-4">
          {PROVIDER_KEY_SPECS.map((spec) => (
            <ProviderKeyCard
              key={spec.credential}
              status={load.statuses[spec.credential]}
              title={spec.label}
              keyLabel={spec.label}
              provider={spec.provider}
              helper={`You bring your own ${spec.label} key and pay ${spec.label} directly. The key is stored locally on this machine.`}
              onStatusChange={update}
            />
          ))}
        </div>
      )}

      <section className="space-y-3 border-t pt-6">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-muted-foreground">Optional: Prompt Writer</h3>
          <p className="text-xs leading-5 text-muted-foreground">
            The Prompt Writer block turns a short idea into a full prompt with an LLM. It is not needed for image or
            video generation. Use an OpenRouter key, or a local Ollama or LM Studio server.
          </p>
        </div>
        {load.kind === 'ready' && (
          <ProviderKeyCard
            status={load.statuses.openrouter_api_key}
            title="OpenRouter (optional)"
            keyLabel="OpenRouter"
            description="Used by the Prompt Writer block only."
            helper="You bring your own OpenRouter key and pay OpenRouter directly. The key is stored locally on this machine."
            checkKey={checkOpenRouterKey}
            onKeyChange={refreshWriterProviders}
            className="bg-transparent shadow-none"
            onStatusChange={update}
          />
        )}
        <LocalLlmServers />
      </section>
    </div>
  )
}
