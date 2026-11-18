import { describe, it, expect } from 'vitest'
import { isSettingsTab } from '../settings-page-body'
import { SETTINGS_TABS } from '../layout'

describe('isSettingsTab', () => {
  it('accepts every registered tab id (guard cannot drift from SETTINGS_TABS)', () => {
    for (const t of SETTINGS_TABS) expect(isSettingsTab(t.id)).toBe(true)
  })
  it('rejects unknown / null', () => {
    expect(isSettingsTab('nope')).toBe(false)
    expect(isSettingsTab(null)).toBe(false)
  })
})
