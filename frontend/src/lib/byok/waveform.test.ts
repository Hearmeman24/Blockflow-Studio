/**
 * Waveform peaks: the pure reduction from samples to bars, and the hook that
 * fetches and decodes a file in the browser (Web Audio is stubbed: jsdom has
 * none, which is itself the "unavailable" case).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { MAX_DECODE_BYTES, clearWaveformCache, computePeaks, placeholderPeaks, useWaveform } from './waveform'

afterEach(() => {
  vi.unstubAllGlobals()
  clearWaveformCache()
})

describe('computePeaks', () => {
  it('returns the RMS of each bar, normalised so the loudest bar is 1', () => {
    const samples = new Float32Array([0.4, 0, 0.6, -0.8, 0, 0, -0.15, 0.2])
    const peaks = computePeaks(samples, 4)
    expect(peaks).toHaveLength(4)
    // Bucket RMS: 0.2828, 0.7071, 0, 0.1768 → divided by 0.7071. (Peaks would give 0.5 for the first bar.)
    expect(peaks.map((p) => Number(p.toFixed(3)))).toEqual([0.4, 1, 0, 0.25])
    expect(Math.max(...peaks)).toBe(1)
    for (const p of peaks) expect(p).toBeGreaterThanOrEqual(0)
  })

  it('a clip that is loud then quiet gives clearly taller bars in the first half', () => {
    const n = 4000
    const samples = new Float32Array(n)
    for (let i = 0; i < n; i++) samples[i] = Math.sin(i / 3) * (i < n / 2 ? 0.9 : 0.15)
    const peaks = computePeaks(samples, 20)
    const firstHalf = peaks.slice(0, 10)
    const secondHalf = peaks.slice(10)
    expect(Math.min(...firstHalf)).toBeGreaterThan(0.9)
    expect(Math.max(...secondHalf)).toBeLessThan(0.25)
  })

  it('a steady tone gives equal bars', () => {
    const n = 20 * 200
    const samples = new Float32Array(n)
    // 50 samples per period: every 200-sample bar holds four whole periods.
    for (let i = 0; i < n; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * i) / 50)
    const peaks = computePeaks(samples, 20)
    for (const p of peaks) expect(p).toBeCloseTo(1, 3)
  })

  it('one loud click in a quiet clip does not flatten the rest (RMS dilutes the click over its bar)', () => {
    const samples = new Float32Array(2000).fill(0.1)
    samples[1234] = 1
    const peaks = computePeaks(samples, 20)
    expect(peaks[12]).toBe(1)
    const rest = peaks.filter((_, i) => i !== 12)
    for (const p of rest) expect(p).toBeGreaterThan(0.6)
  })

  it('empty input gives flat zero bars', () => {
    expect(computePeaks(new Float32Array(0), 5)).toEqual([0, 0, 0, 0, 0])
  })

  it('silent input gives zero bars (no division by zero)', () => {
    expect(computePeaks(new Float32Array(100), 3)).toEqual([0, 0, 0])
  })

  it('input shorter than the bar count still gives every bar a value', () => {
    const peaks = computePeaks(new Float32Array([0.5, -1]), 6)
    expect(peaks).toHaveLength(6)
    expect(peaks.every((p) => Number.isFinite(p) && p >= 0 && p <= 1)).toBe(true)
    expect(peaks).toContain(1)
    expect(peaks).toContain(0.5)
  })

  it('ignores NaN and infinite samples', () => {
    // Finite samples only: bar 1 is RMS(0.5), bar 2 RMS(0.25).
    const peaks = computePeaks(new Float32Array([NaN, 0.5, Infinity, -Infinity, 0.25, NaN]), 2)
    expect(peaks).toEqual([1, 0.5])
    expect(computePeaks(new Float32Array([NaN, Infinity, NaN, NaN]), 2)).toEqual([0, 0])
  })

  it('zero or negative bar counts give no bars', () => {
    expect(computePeaks(new Float32Array([1, 2]), 0)).toEqual([])
    expect(computePeaks(new Float32Array([1, 2]), -3)).toEqual([])
  })
})

describe('placeholderPeaks', () => {
  it('is a stable, gentle pattern inside 0–1', () => {
    const a = placeholderPeaks(24)
    expect(a).toHaveLength(24)
    expect(a).toEqual(placeholderPeaks(24))
    expect(a.every((p) => p > 0 && p < 1)).toBe(true)
    expect(new Set(a).size).toBeGreaterThan(1)
  })
})

function stubAudio(channel: Float32Array, onClose = vi.fn()) {
  const decode = vi.fn(async () => ({ getChannelData: () => channel, numberOfChannels: 1 }))
  class FakeAudioContext {
    decodeAudioData = decode
    close = vi.fn(async () => { onClose() })
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)
  return { decode, onClose }
}

function stubFetch(bytes = 16) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    void init
    return new Response(new Uint8Array(bytes))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('useWaveform', () => {
  it('without Web Audio it returns the placeholder and fetches nothing', () => {
    vi.stubGlobal('AudioContext', undefined)
    const fetchMock = stubFetch()
    const { result } = renderHook(() => useWaveform('/outputs/a.wav', { bars: 8 }))
    expect(result.current.ready).toBe(false)
    expect(result.current.peaks).toEqual(placeholderPeaks(8))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('decodes the file, returns real peaks, closes the context, and caches per URL', async () => {
    const onClose = vi.fn()
    const { decode } = stubAudio(new Float32Array([1, 1, 0.5, 0.5]), onClose)
    const fetchMock = stubFetch()
    const { result, unmount } = renderHook(() => useWaveform('/outputs/a.wav', { bars: 2 }))
    expect(result.current.ready).toBe(false)
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.peaks).toEqual([1, 0.5])
    expect(fetchMock).toHaveBeenCalledWith('/outputs/a.wav', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(decode).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    unmount()

    // A second tile for the same file reads the cache: no second fetch.
    const again = renderHook(() => useWaveform('/outputs/a.wav', { bars: 2 }))
    expect(again.result.current.ready).toBe(true)
    expect(again.result.current.peaks).toEqual([1, 0.5])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not decode files over the size cap', () => {
    stubAudio(new Float32Array([1]))
    const fetchMock = stubFetch()
    const { result } = renderHook(() => useWaveform('/outputs/huge.wav', { bars: 4, sizeBytes: MAX_DECODE_BYTES + 1 }))
    expect(result.current.ready).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a failed fetch or decode keeps the placeholder', async () => {
    stubAudio(new Float32Array([1]))
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useWaveform('/outputs/missing.wav', { bars: 4 }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 10))
    expect(result.current.ready).toBe(false)
    expect(result.current.peaks).toEqual(placeholderPeaks(4))
  })

  it('aborts the fetch on unmount', () => {
    stubAudio(new Float32Array([1]))
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise(() => undefined)
    }))
    const { unmount } = renderHook(() => useWaveform('/outputs/slow.wav', { bars: 4 }))
    expect(signal?.aborted).toBe(false)
    unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('no src gives the placeholder', () => {
    const { result } = renderHook(() => useWaveform(undefined, { bars: 3 }))
    expect(result.current.peaks).toEqual(placeholderPeaks(3))
  })
})
