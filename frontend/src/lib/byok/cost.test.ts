import { describe, expect, it } from 'vitest'
import {
  formatAmount,
  formatBalance,
  formatCompactAmount,
  formatEstimate,
  formatJobCost,
  formatUpdated,
  formatUsd,
  readEstimate,
  readJobCost,
  readPriceCheck,
} from './cost'

describe('cost formatting', () => {
  it('formats dollars with cents, and sub-cent values with more precision', () => {
    expect(formatUsd(1)).toBe('$1.00')
    expect(formatUsd(12.345)).toBe('$12.35')
    expect(formatUsd(0.004)).toBe('$0.004')
  })

  it('formats amounts per unit', () => {
    expect(formatAmount(205, 'credits')).toBe('205 credits')
    expect(formatAmount(1, 'credits')).toBe('1 credit')
    expect(formatAmount(12.5, 'credits')).toBe('12.5 credits')
    expect(formatAmount(1.25, 'usd')).toBe('$1.25')
    expect(formatAmount(6000000, 'points')).toBe('6,000,000 points')
  })

  it('formats compact pill amounts', () => {
    expect(formatCompactAmount(12345, 'credits')).toBe('12.3K credits')
    expect(formatCompactAmount(12.34, 'usd')).toBe('$12.34')
  })

  it('shows the USD equivalent of credit balances', () => {
    expect(formatBalance({ amount: 1234, unit: 'credits', usd_equivalent: 6.17 })).toBe('1,234 credits ≈ $6.17')
    expect(formatBalance({ amount: 12.34, unit: 'usd', usd_equivalent: 12.34 })).toBe('$12.34')
    expect(formatBalance({ amount: 800, unit: 'credits', usd_equivalent: null })).toBe('800 credits')
    expect(formatBalance({ unit: 'credits' })).toBe('')
  })

  it('formats estimates and job costs', () => {
    const base = { basis: '', source: '', as_of: '2026-11-15', confidence: 'listed' as const }
    expect(formatEstimate({ ...base, amount: 205, unit: 'credits', usd_equivalent: 1.025 })).toBe('≈ 205 credits')
    expect(formatEstimate({ ...base, amount: 1, unit: 'usd', usd_equivalent: 1 })).toBe('≈ $1.00')
    expect(formatJobCost({ amount: 205, unit: 'credits', usd_equivalent: 1.025 })).toBe('205 credits ≈ $1.03')
    expect(formatJobCost({ amount: 6000000, unit: 'points', usd_equivalent: 0.6 })).toBe('$0.60 (6,000,000 points)')
    expect(formatJobCost({ amount: 1234, unit: 'points', usd_equivalent: null })).toBe('1,234 points')
  })

  it('rejects malformed costs and estimates', () => {
    expect(readJobCost(null)).toBeNull()
    expect(readJobCost({ amount: 'x', unit: 'credits' })).toBeNull()
    expect(readJobCost({ amount: 3, unit: '' })).toBeNull()
    expect(readJobCost({ amount: 3, unit: 'credits', usd_equivalent: 'no' })).toEqual({
      amount: 3, unit: 'credits', usd_equivalent: null,
    })
    expect(readEstimate({ amount: Number.NaN, unit: 'usd' })).toBeNull()
    expect(readEstimate({ amount: 1, unit: 'usd', confidence: 'weird' })?.confidence).toBe('listed')
  })

  it('formats last-updated times', () => {
    const now = 1_000_000_000
    expect(formatUpdated(now / 1000 - 3, now)).toBe('just now')
    expect(formatUpdated(now / 1000 - 30, now)).toBe('30s ago')
    expect(formatUpdated(now / 1000 - 180, now)).toBe('3m ago')
    expect(formatUpdated(now / 1000 - 7200, now)).toBe('2h ago')
  })
})

describe('price provenance and price checks', () => {
  it('reads price_source and price_updated_at from an estimate, ignoring unknown values', () => {
    const e = readEstimate({ amount: 1, unit: 'usd', price_source: 'observed', price_updated_at: '2026-11-14T12:00:00Z' })
    expect(e?.price_source).toBe('observed')
    expect(e?.price_updated_at).toBe('2026-11-14T12:00:00Z')
    const odd = readEstimate({ amount: 1, unit: 'usd', price_source: 'guess', price_updated_at: 7 })
    expect(odd?.price_source).toBeUndefined()
    expect(odd?.price_updated_at).toBeUndefined()
  })

  const CHECK = {
    expected: { amount: 41, unit: 'credits' }, actual: { amount: 50, unit: 'credits' }, source: 'ledger',
    differs: true, checked_at: '2026-11-15T10:00:00Z', report_url: 'https://github.com/o/r/issues/new?title=x',
  }

  it('reads a well-formed price check', () => {
    expect(readPriceCheck(CHECK)).toEqual(CHECK)
    expect(readPriceCheck({ ...CHECK, report_url: null })?.report_url).toBeNull()
  })

  it('rejects malformed checks and drops a report link that is not https', () => {
    expect(readPriceCheck(null)).toBeNull()
    expect(readPriceCheck({ ...CHECK, differs: 'yes' })).toBeNull()
    expect(readPriceCheck({ ...CHECK, actual: { amount: 'x', unit: 'credits' } })).toBeNull()
    expect(readPriceCheck({ ...CHECK, expected: null })).toBeNull()
    expect(readPriceCheck({ ...CHECK, report_url: 'javascript:alert(1)' })?.report_url).toBeNull()
  })
})
