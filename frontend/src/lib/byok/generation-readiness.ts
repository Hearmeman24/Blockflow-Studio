/**
 * Whether a generation block can run, as one tagged result. The execute guard
 * (`readinessRefusal`) and the block's UI (setup guidance, the "not available"
 * panel, the estimate) read the same value, in this order:
 *
 *   loading        the catalog has not loaded
 *   catalog_error  it failed to load (a failed revalidation keeps the old catalog: ready)
 *   no_keys        no provider has a key
 *   no_model       no model chosen, or the provider does not support it for the mode
 *   unavailable    the model exists for the mode but cannot run (no key for that provider)
 *   blocked        runnable, but the block shows issues to fix
 *   ready          runnable
 *
 * `blocked` does not stop execute: the server's validation reports the same
 * issues for the inputs the run actually receives.
 */
import { configuredProviders, type Availability } from './catalog'
import type { ModeSpec, ProviderCatalog, ProviderId } from './types'
import type { CatalogLoad } from './use-provider-catalog'

export interface ReadySelection {
  catalog: ProviderCatalog
  provider: ProviderId
  model: string
  spec: ModeSpec
}

export type Readiness =
  | { kind: 'loading' }
  | { kind: 'catalog_error'; error: Error }
  | { kind: 'no_keys' }
  | { kind: 'no_model'; reason: string | null }
  | { kind: 'unavailable'; reason: string | null }
  | { kind: 'blocked'; selection: ReadySelection; issues: string[] }
  | { kind: 'ready'; selection: ReadySelection }

export interface ReadinessInput {
  load: CatalogLoad
  /** The resolved selection (`resolveGenerationSelection`), not the stored one. */
  provider: ProviderId | null
  model: string | null
  spec: ModeSpec | null
  availability: Availability
  /** The error issues the block shows. */
  issues: readonly string[]
}

export function readiness({ load, provider, model, spec, availability, issues }: ReadinessInput): Readiness {
  if (load.status === 'loading') return { kind: 'loading' }
  if (load.status === 'error') return { kind: 'catalog_error', error: load.error }
  const { catalog } = load
  if (configuredProviders(catalog).length === 0) return { kind: 'no_keys' }
  if (!provider || !model || !spec) return { kind: 'no_model', reason: availability.reason }
  if (!availability.available) return { kind: 'unavailable', reason: availability.reason }
  const selection = { catalog, provider, model, spec }
  return issues.length > 0 ? { kind: 'blocked', selection, issues: [...issues] } : { kind: 'ready', selection }
}

/** Why execute refuses to start, or null when it may submit. */
export function readinessRefusal(r: Readiness, names: { mode: string; where: string }): string | null {
  switch (r.kind) {
    case 'loading':
    case 'catalog_error':
      return 'The provider catalog has not loaded yet. Wait a moment and run again.'
    case 'no_keys':
      return 'Add a Kie or PiAPI API key in Settings to run this block.'
    case 'no_model':
      return r.reason ?? `Choose a model for ${names.mode}.`
    case 'unavailable':
      return r.reason ?? `${names.where} is not available.`
    case 'blocked':
    case 'ready':
      return null
  }
}

/** The selection a run or an estimate would use, or null when the block cannot run. */
export function runnableSelection(r: Readiness): ReadySelection | null {
  return r.kind === 'ready' || r.kind === 'blocked' ? r.selection : null
}

/** The "not available" panel's reason: a chosen model that cannot run. */
export function unavailableReason(r: Readiness): string | null {
  return r.kind === 'no_model' || r.kind === 'unavailable' ? r.reason : null
}
