import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'

import {
  formatElapsedSeconds,
  fmtDurationSeconds,
  formatRelativeTime,
} from './format-time'

// ---------------------------------------------------------------------------
// formatElapsedSeconds — seconds: number | null | undefined
// ---------------------------------------------------------------------------
describe('formatElapsedSeconds', () => {
  test('null → empty string', () => {
    expect(formatElapsedSeconds(null)).toBe('')
  })

  test('undefined → empty string', () => {
    expect(formatElapsedSeconds(undefined)).toBe('')
  })

  test('zero → empty string', () => {
    expect(formatElapsedSeconds(0)).toBe('')
  })

  test('negative → empty string', () => {
    expect(formatElapsedSeconds(-5)).toBe('')
  })

  test('30s (no rounding needed)', () => {
    expect(formatElapsedSeconds(30)).toBe('30s')
  })

  test('rounds fractional seconds below 60', () => {
    expect(formatElapsedSeconds(29.6)).toBe('30s')
  })

  test('exactly 60s → 1m', () => {
    // secs = Math.round(60 % 60) = 0, so secs > 0 is false → drops s part
    expect(formatElapsedSeconds(60)).toBe('1m')
  })

  test('90s → 1m 30s', () => {
    expect(formatElapsedSeconds(90)).toBe('1m 30s')
  })

  test('3599s → 59m 59s', () => {
    expect(formatElapsedSeconds(3599)).toBe('59m 59s')
  })

  test('3600s → 60m (no hours branch)', () => {
    // mins = 60, secs = 0 → "60m"
    expect(formatElapsedSeconds(3600)).toBe('60m')
  })

  test('rounds secs within minute', () => {
    // 91.4s → mins=1, secs=Math.round(31.4)=31 → "1m 31s"
    expect(formatElapsedSeconds(91.4)).toBe('1m 31s')
  })
})

// ---------------------------------------------------------------------------
// fmtDurationSeconds — rounds with Math.round; its hours branch differs from
// formatElapsedSeconds.
// ---------------------------------------------------------------------------
describe('fmtDurationSeconds', () => {
  test('zero → 0s', () => {
    expect(fmtDurationSeconds(0)).toBe('0s')
  })

  test('30s', () => {
    expect(fmtDurationSeconds(30)).toBe('30s')
  })

  test('rounds fractional seconds below 60', () => {
    expect(fmtDurationSeconds(29.6)).toBe('30s')
  })

  test('exactly 60s → 1m 0s', () => {
    // m=1, s=Math.round(0)=0 → "1m 0s"
    expect(fmtDurationSeconds(60)).toBe('1m 0s')
  })

  test('90s → 1m 30s', () => {
    expect(fmtDurationSeconds(90)).toBe('1m 30s')
  })

  test('3599s → 59m 59s', () => {
    expect(fmtDurationSeconds(3599)).toBe('59m 59s')
  })

  test('exactly 3600s → 1h 0m (hours branch)', () => {
    // m=60, h=Math.floor(60/60)=1, m%60=0 → "1h 0m"
    expect(fmtDurationSeconds(3600)).toBe('1h 0m')
  })

  test('5400s → 1h 30m', () => {
    expect(fmtDurationSeconds(5400)).toBe('1h 30m')
  })

  test('rounds secs when in minute range', () => {
    // 91.4 → m=1, s=Math.round(31.4)=31 → "1m 31s"
    expect(fmtDurationSeconds(91.4)).toBe('1m 31s')
  })
})

// ---------------------------------------------------------------------------
// formatRelativeTime — ISO timestamp → relative text
// ---------------------------------------------------------------------------
describe('formatRelativeTime', () => {
  const NOW = new Date('2026-06-03T12:00:00Z').getTime()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('less than 1 minute ago → "just now"', () => {
    const iso = new Date(NOW - 30_000).toISOString() // 30s ago
    expect(formatRelativeTime(iso)).toBe('just now')
  })

  test('exactly 0ms difference → "just now"', () => {
    const iso = new Date(NOW).toISOString()
    expect(formatRelativeTime(iso)).toBe('just now')
  })

  test('1 minute ago', () => {
    const iso = new Date(NOW - 60_000).toISOString()
    expect(formatRelativeTime(iso)).toBe('1m ago')
  })

  test('59 minutes ago', () => {
    const iso = new Date(NOW - 59 * 60_000).toISOString()
    expect(formatRelativeTime(iso)).toBe('59m ago')
  })

  test('1 hour ago', () => {
    const iso = new Date(NOW - 60 * 60_000).toISOString()
    expect(formatRelativeTime(iso)).toBe('1h ago')
  })

  test('23 hours ago', () => {
    const iso = new Date(NOW - 23 * 60 * 60_000).toISOString()
    expect(formatRelativeTime(iso)).toBe('23h ago')
  })

  test('1 day ago', () => {
    const iso = new Date(NOW - 24 * 60 * 60_000).toISOString()
    expect(formatRelativeTime(iso)).toBe('1d ago')
  })

  test('6 days ago', () => {
    const iso = new Date(NOW - 6 * 24 * 60 * 60_000).toISOString()
    expect(formatRelativeTime(iso)).toBe('6d ago')
  })

  test('7 days ago → locale date string', () => {
    const sevenDaysAgo = new Date(NOW - 7 * 24 * 60 * 60_000)
    const iso = sevenDaysAgo.toISOString()
    const expected = sevenDaysAgo.toLocaleDateString([], { month: 'short', day: 'numeric' })
    expect(formatRelativeTime(iso)).toBe(expected)
  })
})
