'use client'

import { useMemo } from 'react'
import {
  ListSelect,
  ListSelectContent,
  ListSelectItem,
  ListSelectTrigger,
  ListSelectValue,
} from '@/components/ui/list-select'
import { findModel, modelAvailability } from '@/lib/byok/catalog'
import { modelsForBlock } from '@/lib/byok/generation-blocks'
import type { GenerationMode, ProviderCatalog, ProviderId } from '@/lib/byok/types'
import { ModelName, NSFW_DESCRIPTION } from './nsfw-badge'

interface ModelSelectProps {
  catalog: ProviderCatalog
  mode: GenerationMode
  provider: ProviderId
  /** Catalog model ids to offer, in this order. Omitted: every model for the mode. */
  models?: readonly string[]
  value: string | null
  onChange: (modelId: string) => void
  disabled?: boolean
}

/**
 * Every catalog model that supports `mode` on any provider, or only the ids
 * in `models` when a block offers a fixed set. Models the
 * selected provider cannot serve stay listed, greyed out, with the reason as
 * visible text and as the option's accessible description; they can be
 * reached with the keyboard but not chosen.
 */
export function ModelSelect({ catalog, mode, provider, models, value, onChange, disabled }: ModelSelectProps) {
  const options = useMemo(
    () => modelsForBlock(catalog, { mode, models }).map((model) => ({
      model,
      availability: modelAvailability(catalog, model.id, provider, mode),
    })),
    [catalog, mode, provider, models],
  )
  const unavailable = useMemo(
    () => new Set(options.filter((o) => !o.availability.available).map((o) => o.model.id)),
    [options],
  )
  const selected = value ? findModel(catalog, value) : undefined

  return (
    <ListSelect
      value={value}
      onValueChange={onChange}
      isValueUnavailable={(v) => unavailable.has(v)}
      placeholder="Choose a model"
      disabled={disabled}
    >
      <ListSelectTrigger aria-label="Model">
        <ListSelectValue>
          {() => (selected ? <ModelName name={selected.name} nsfw={selected.nsfw} /> : 'Choose a model')}
        </ListSelectValue>
      </ListSelectTrigger>
      <ListSelectContent>
        {options.map(({ model, availability }) => {
          const description = [availability.reason, model.nsfw ? NSFW_DESCRIPTION : null].filter(Boolean).join(' ')
          return (
            <ListSelectItem
              key={model.id}
              value={model.id}
              label={model.name}
              unavailableReason={availability.reason}
              aria-description={description || undefined}
            >
              <span data-testid="model-option-name" className={availability.available ? undefined : 'opacity-60'}>
                <ModelName name={model.name} nsfw={model.nsfw} />
              </span>
              {availability.reason && (
                <span className="text-muted-foreground block text-3xs">{availability.reason}</span>
              )}
            </ListSelectItem>
          )
        })}
      </ListSelectContent>
    </ListSelect>
  )
}
