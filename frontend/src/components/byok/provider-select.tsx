'use client'

import { useMemo } from 'react'
import {
  ListSelect,
  ListSelectContent,
  ListSelectItem,
  ListSelectTrigger,
  ListSelectValue,
} from '@/components/ui/list-select'
import { providerAvailability, providerIds, providerName } from '@/lib/byok/catalog'
import type { ProviderCatalog, ProviderId } from '@/lib/byok/types'

interface ProviderSelectProps {
  catalog: ProviderCatalog
  value: ProviderId | null
  onChange: (provider: ProviderId) => void
  disabled?: boolean
}

/** Kie / PiAPI. Providers without a key stay listed, unavailable, with the reason. */
export function ProviderSelect({ catalog, value, onChange, disabled }: ProviderSelectProps) {
  const options = useMemo(
    () => providerIds(catalog).map((id) => ({ id, name: providerName(catalog, id), ...providerAvailability(catalog, id) })),
    [catalog],
  )
  const unavailable = new Set(options.filter((o) => !o.available).map((o) => o.id))
  return (
    <ListSelect
      value={value}
      onValueChange={onChange}
      isValueUnavailable={(v) => unavailable.has(v)}
      placeholder="Choose a provider"
      disabled={disabled}
    >
      <ListSelectTrigger aria-label="Provider">
        <ListSelectValue>{() => (value ? providerName(catalog, value) : 'Choose a provider')}</ListSelectValue>
      </ListSelectTrigger>
      <ListSelectContent>
        {options.map((o) => (
          <ListSelectItem key={o.id} value={o.id} label={o.name} unavailableReason={o.reason}>
            <span className={o.available ? undefined : 'opacity-60'}>{o.name}</span>
            {o.reason && <span className="text-muted-foreground block text-3xs">{o.reason}</span>}
          </ListSelectItem>
        ))}
      </ListSelectContent>
    </ListSelect>
  )
}
