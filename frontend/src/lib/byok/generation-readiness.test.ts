/**
 * Whether a generation block can run, as one tagged result read by both the
 * execute guard and the block's UI.
 */
import { describe, expect, it } from 'vitest'
import { CATALOG_BOTH, CATALOG_KIE, CATALOG_NONE } from './__fixtures__'
import { getModeSpec, modelAvailability } from './catalog'
import {
  readiness,
  readinessRefusal,
  runnableSelection,
  unavailableReason,
  type ReadinessInput,
} from './generation-readiness'
import type { ProviderCatalog } from './types'

const names = { mode: 'Text to Video', where: 'Seedance 2 on Kie' }

function input(catalog: ProviderCatalog | null, provider: string | null, model: string | null, issues: string[] = []): ReadinessInput {
  const spec = catalog && provider && model ? getModeSpec(catalog, provider, model, 'text_to_video', {}) : null
  const availability = catalog && provider && model
    ? modelAvailability(catalog, model, provider, 'text_to_video')
    : { available: false, reason: null }
  return {
    load: catalog ? { status: 'ready', catalog, stale: false } : { status: 'loading' },
    provider,
    model,
    spec,
    availability,
    issues,
  }
}

describe('readiness', () => {
  it('loading, and the catalog error, while there is no catalog', () => {
    expect(readiness(input(null, 'kie', 'seedance-2'))).toEqual({ kind: 'loading' })
    const error = new Error('HTTP 500')
    expect(readiness({ ...input(null, 'kie', 'seedance-2'), load: { status: 'error', error } })).toEqual({ kind: 'catalog_error', error })
  })

  it('no keys comes before anything about the model', () => {
    expect(readiness(input(CATALOG_NONE, 'kie', 'seedance-2', ['Too many.'])).kind).toBe('no_keys')
  })

  it('no model: nothing chosen, or a model the provider does not support for the mode', () => {
    expect(readiness(input(CATALOG_BOTH, 'kie', null))).toEqual({ kind: 'no_model', reason: null })
    expect(readiness(input(CATALOG_BOTH, 'piapi', 'wan-3.0'))).toEqual({ kind: 'no_model', reason: 'Not offered by PiAPI' })
  })

  it('unavailable: the model exists for the mode but cannot run (no key for that provider)', () => {
    expect(readiness(input(CATALOG_KIE, 'piapi', 'seedance-2'))).toEqual({ kind: 'unavailable', reason: 'Requires a PiAPI API key' })
  })

  it('blocked by issues, else ready, both with the selection', () => {
    const blocked = readiness(input(CATALOG_BOTH, 'kie', 'seedance-2', ['Too many images.']))
    expect(blocked).toMatchObject({ kind: 'blocked', issues: ['Too many images.'], selection: { provider: 'kie', model: 'seedance-2' } })
    const ready = readiness(input(CATALOG_BOTH, 'kie', 'seedance-2'))
    expect(ready).toMatchObject({ kind: 'ready', selection: { provider: 'kie', model: 'seedance-2', catalog: CATALOG_BOTH } })
    expect(runnableSelection(ready)?.spec).toBe(getModeSpec(CATALOG_BOTH, 'kie', 'seedance-2', 'text_to_video', {}))
  })

  it('a catalog whose revalidation failed is still used', () => {
    const stale = { ...input(CATALOG_BOTH, 'kie', 'seedance-2'), load: { status: 'ready', catalog: CATALOG_BOTH, stale: true } as const }
    expect(readiness(stale).kind).toBe('ready')
  })
})

describe('readinessRefusal: the execute guard, with the exact texts', () => {
  it.each([
    [input(null, 'kie', 'seedance-2'), 'The provider catalog has not loaded yet. Wait a moment and run again.'],
    [{ ...input(null, 'kie', 'seedance-2'), load: { status: 'error', error: new Error('x') } as const }, 'The provider catalog has not loaded yet. Wait a moment and run again.'],
    [input(CATALOG_NONE, 'kie', 'seedance-2'), 'Add a Kie or PiAPI API key in Settings to run this block.'],
    [input(CATALOG_BOTH, 'kie', null), 'Choose a model for Text to Video.'],
    [input(CATALOG_BOTH, 'piapi', 'wan-3.0'), 'Not offered by PiAPI'],
    [input(CATALOG_KIE, 'piapi', 'seedance-2'), 'Requires a PiAPI API key'],
  ])('%#: refuses with the guard text', (value, text) => {
    expect(readinessRefusal(readiness(value), names)).toBe(text)
  })

  it('an unavailable model without a reason says where', () => {
    expect(readinessRefusal({ kind: 'unavailable', reason: null }, names)).toBe('Seedance 2 on Kie is not available.')
  })

  it('does not refuse a ready block, nor one with issues: the server validation reports those', () => {
    expect(readinessRefusal(readiness(input(CATALOG_BOTH, 'kie', 'seedance-2')), names)).toBeNull()
    expect(readinessRefusal(readiness(input(CATALOG_BOTH, 'kie', 'seedance-2', ['Too many.'])), names)).toBeNull()
  })
})

describe('what the UI reads', () => {
  it('unavailableReason: the warning panel text, only for a chosen model that cannot run', () => {
    expect(unavailableReason(readiness(input(CATALOG_BOTH, 'piapi', 'wan-3.0')))).toBe('Not offered by PiAPI')
    expect(unavailableReason(readiness(input(CATALOG_KIE, 'piapi', 'seedance-2')))).toBe('Requires a PiAPI API key')
    expect(unavailableReason(readiness(input(CATALOG_BOTH, 'kie', null)))).toBeNull()
    expect(unavailableReason(readiness(input(CATALOG_NONE, 'kie', 'seedance-2')))).toBeNull()
    expect(unavailableReason(readiness(input(CATALOG_BOTH, 'kie', 'seedance-2')))).toBeNull()
  })

  it('runnableSelection: present for ready and blocked only (an estimate is asked for both)', () => {
    expect(runnableSelection(readiness(input(CATALOG_BOTH, 'kie', 'seedance-2', ['x'])))).not.toBeNull()
    for (const value of [input(null, 'kie', 'seedance-2'), input(CATALOG_NONE, 'kie', 'seedance-2'), input(CATALOG_BOTH, 'piapi', 'wan-3.0'), input(CATALOG_KIE, 'piapi', 'seedance-2')]) {
      expect(runnableSelection(readiness(value))).toBeNull()
    }
  })
})
