'use client'

import { useId } from 'react'
import { Input } from '@/components/ui/input'
import {
  ListSelect,
  ListSelectContent,
  ListSelectItem,
  ListSelectTrigger,
  ListSelectValue,
} from '@/components/ui/list-select'
import { unavailableReason } from '@/lib/prompt-writer/media'
import type { WriterMediaKind, WriterModel, WriterProviderStatus } from '@/lib/prompt-writer/types'

interface WriterModelFieldProps {
  provider: WriterProviderStatus | undefined
  value: string
  onChange: (model: string) => void
  /** Media kinds ticked to send: models that do not take one stay listed but cannot be chosen. */
  requiredKinds?: readonly WriterMediaKind[]
}

/**
 * The provider's model list, or a model ID input when the list is empty
 * (OpenRouter's list could not be loaded). A saved model that is not in the
 * list stays selectable so an older flow keeps its choice. The selected model
 * is never changed here when a kind is ticked; the block shows the error.
 */
export function WriterModelField({ provider, value, onChange, requiredKinds = [] }: WriterModelFieldProps) {
  const inputId = useId()
  const models: WriterModel[] = provider?.models ?? []

  if (provider?.available && models.length === 0) {
    return (
      <div className="space-y-1">
        <Input
          id={inputId}
          aria-label="Model ID"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={provider.id === 'openrouter' ? 'e.g. openai/gpt-4o-mini' : 'Model name'}
          spellCheck={false}
          autoComplete="off"
          className="h-7 text-xs"
        />
        {provider.models_error && <p className="text-muted-foreground text-3xs">{provider.models_error}</p>}
      </div>
    )
  }

  const listed = models.some((m) => m.id === value)
  const options: WriterModel[] = value && !listed ? [{ id: value, name: `${value} (not listed)`, accepts: [] }, ...models] : models
  const selected = options.find((m) => m.id === value)
  const reasons = new Map(options.map((m) => [m.id, provider ? unavailableReason(provider, m.id, requiredKinds) : null]))
  return (
    <ListSelect
      value={value || null}
      onValueChange={onChange}
      isValueUnavailable={(v) => Boolean(reasons.get(v))}
      placeholder="Choose a model"
      disabled={!provider?.available}
    >
      <ListSelectTrigger aria-label="Model">
        <ListSelectValue>{() => selected?.name ?? 'Choose a model'}</ListSelectValue>
      </ListSelectTrigger>
      <ListSelectContent>
        {options.map((m) => {
          const reason = reasons.get(m.id) ?? null
          return (
            <ListSelectItem key={m.id} value={m.id} label={m.name} unavailableReason={reason}>
              <span className={reason ? 'block truncate opacity-60' : 'block truncate'}>{m.name}</span>
              {m.name !== m.id && <span className="text-muted-foreground block truncate text-3xs">{m.id}</span>}
              {reason && <span className="text-muted-foreground block text-3xs">{reason}</span>}
            </ListSelectItem>
          )
        })}
      </ListSelectContent>
    </ListSelect>
  )
}
