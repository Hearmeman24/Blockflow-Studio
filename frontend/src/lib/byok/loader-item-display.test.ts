import { describe, expect, it } from 'vitest'
import { REFERENCE_HEALTH_STATUSES, type ReferenceHealthStatus } from '@/lib/status'
import { itemDisplayState, type ItemDisplayKind } from './loader-item-display'
import type { ItemFlag, ItemFlagStatus, LoaderItemStatus } from './loader-items'
import { isBrokenStatus, type ReferenceHealth } from './reference-health'

const ok: ItemFlag = { status: 'ok', reason: null }
const flag = (status: ItemFlagStatus, reason: string | null = `${status} reason`): ItemFlag => ({ status, reason })
const health = (status: ReferenceHealthStatus, detail = `${status} detail`): ReferenceHealth => ({ status, detail })

describe('itemDisplayState', () => {
  it('saving wins over everything else', () => {
    expect(itemDisplayState({ status: 'saving' }, health('missing_local'), flag('incompatible'))).toEqual({ kind: 'saving' })
  })

  it('a failed save reads as not saved, with its error as the detail', () => {
    expect(itemDisplayState({ status: 'error', error: 'disk full' }, undefined, flag('over_limit')))
      .toEqual({ kind: 'not_saved', detail: 'disk full' })
    expect(itemDisplayState({ status: 'error' }, undefined, ok)).toEqual({ kind: 'not_saved', detail: null })
  })

  it('a broken reference wins over a limit flag', () => {
    expect(itemDisplayState({ status: 'ready' }, health('expired'), flag('incompatible')))
      .toEqual({ kind: 'broken', health: health('expired') })
  })

  it('a limit flag wins over "not verified"', () => {
    expect(itemDisplayState({ status: 'ready' }, health('unchecked'), flag('over_limit', 'too many')))
      .toEqual({ kind: 'flagged', flag: flag('over_limit', 'too many') })
  })

  it('an unchecked reference with no flag reads as not verified', () => {
    expect(itemDisplayState({ status: 'ready' }, health('unchecked', 'asset'), ok)).toEqual({ kind: 'unverified', detail: 'asset' })
  })

  it('is ok with a found reference, or no result yet, and no flag', () => {
    expect(itemDisplayState({ status: 'ready' }, health('ok'), ok)).toEqual({ kind: 'ok' })
    expect(itemDisplayState({ status: 'ready' }, undefined, ok)).toEqual({ kind: 'ok' })
    expect(itemDisplayState({ status: 'ready' }, undefined)).toEqual({ kind: 'ok' })
  })

  it('ignores the health result of an item that is not saved yet', () => {
    expect(itemDisplayState({ status: 'saving' }, health('malformed'), ok).kind).toBe('saving')
    expect(itemDisplayState({ status: 'error' }, health('malformed'), ok).kind).toBe('not_saved')
  })

  it('is exhaustive: every combination maps to the highest-priority state that applies', () => {
    const statuses: LoaderItemStatus[] = ['saving', 'ready', 'error']
    const healths: Array<ReferenceHealth | undefined> = [undefined, ...REFERENCE_HEALTH_STATUSES.map((s) => health(s))]
    const flags: ItemFlagStatus[] = ['ok', 'over_limit', 'incompatible', 'unsupported']
    for (const status of statuses) {
      for (const h of healths) {
        for (const f of flags) {
          const applies: ItemDisplayKind[] = []
          if (status === 'saving') applies.push('saving')
          if (status === 'error') applies.push('not_saved')
          if (status === 'ready' && isBrokenStatus(h?.status)) applies.push('broken')
          if (f !== 'ok') applies.push('flagged')
          if (status === 'ready' && h?.status === 'unchecked') applies.push('unverified')
          applies.push('ok')
          expect(itemDisplayState({ status }, h, flag(f)).kind, `${status} / ${h?.status} / ${f}`).toBe(applies[0])
        }
      }
    }
  })
})
