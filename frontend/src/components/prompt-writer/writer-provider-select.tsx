'use client'

import {
  ListSelect,
  ListSelectContent,
  ListSelectItem,
  ListSelectTrigger,
  ListSelectValue,
} from '@/components/ui/list-select'
import type { WriterProviderId, WriterProviderStatus } from '@/lib/prompt-writer/types'

interface WriterProviderSelectProps {
  providers: WriterProviderStatus[]
  value: WriterProviderId | null
  onChange: (provider: WriterProviderId) => void
}

/**
 * OpenRouter / Ollama / LM Studio. A provider the backend did not report as
 * available stays listed, greyed out, with the reason as visible text and as
 * the option's accessible description; it can be reached but not chosen.
 */
export function WriterProviderSelect({ providers, value, onChange }: WriterProviderSelectProps) {
  const unavailable = new Set(providers.filter((p) => !p.available).map((p) => p.id))
  const selected = providers.find((p) => p.id === value)
  return (
    <ListSelect
      value={value}
      onValueChange={(next) => onChange(next as WriterProviderId)}
      isValueUnavailable={(v) => unavailable.has(v as WriterProviderId)}
      placeholder="Choose a provider"
    >
      <ListSelectTrigger aria-label="Provider">
        <ListSelectValue>{() => selected?.label ?? 'Choose a provider'}</ListSelectValue>
      </ListSelectTrigger>
      <ListSelectContent>
        {providers.map((p) => (
          <ListSelectItem key={p.id} value={p.id} label={p.label} unavailableReason={p.reason}>
            <span className={p.available ? undefined : 'opacity-60'}>{p.label}</span>
            <span className="text-muted-foreground ml-1.5 text-3xs">{p.kind === 'local' ? 'Local' : 'Hosted'}</span>
            {p.reason && <span className="text-muted-foreground block text-3xs">{p.reason}</span>}
          </ListSelectItem>
        ))}
      </ListSelectContent>
    </ListSelect>
  )
}
