'use client'

/**
 * Waveform peaks for sound tiles, computed in the browser. `computePeaks` is
 * the pure reduction; `useWaveform` fetches a file, decodes it with Web Audio
 * and caches the peaks per URL. Until real peaks exist (loading, failure, no
 * Web Audio, or a file too large to decode) it returns a neutral placeholder.
 */
import { useEffect, useState } from 'react'

/** Files larger than this are not downloaded and decoded just to draw bars. */
export const MAX_DECODE_BYTES = 25 * 1024 * 1024
export const DEFAULT_BARS = 20

/**
 * One value per bar: the RMS (root mean square) of the finite samples in its
 * slice, normalised so the loudest bar is 1. RMS rather than the peak sample:
 * with few bars nearly every slice of real audio holds a near-maximal sample,
 * so peaks draw every bar full height. A single click is diluted over its bar
 * instead of flattening the others.
 */
export function computePeaks(samples: Float32Array, bars: number): number[] {
  const count = Math.floor(bars)
  if (!(count > 0)) return []
  const len = samples.length
  const raw = new Array<number>(count).fill(0)
  if (len === 0) return raw
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * len) / count)
    const end = Math.max(start + 1, Math.floor(((i + 1) * len) / count))
    let sum = 0
    let n = 0
    for (let j = start; j < end && j < len; j++) {
      const v = samples[j]
      if (!Number.isFinite(v)) continue
      sum += v * v
      n += 1
    }
    raw[i] = n > 0 ? Math.sqrt(sum / n) : 0
  }
  const max = Math.max(...raw)
  return max > 0 ? raw.map((p) => p / max) : raw
}

const placeholders = new Map<number, number[]>()

/** A stable, gentle shape shown while the real peaks are not available. */
export function placeholderPeaks(bars: number): number[] {
  const count = Math.max(0, Math.floor(bars))
  const cached = placeholders.get(count)
  if (cached) return cached
  const peaks = Array.from({ length: count }, (_, i) => {
    const v = 0.42 + 0.22 * Math.sin(i * 0.9) + 0.12 * Math.sin(i * 2.3 + 1)
    return Math.min(0.9, Math.max(0.15, v))
  })
  placeholders.set(count, peaks)
  return peaks
}

const cache = new Map<string, number[]>()

/** For tests. */
export function clearWaveformCache() {
  cache.clear()
}

type AudioContextCtor = new () => AudioContext

function audioContextCtor(): AudioContextCtor | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }
  return w.AudioContext ?? w.webkitAudioContext
}

export interface WaveformOptions {
  sizeBytes?: number | null
  bars?: number
}

export function useWaveform(src: string | undefined, { sizeBytes, bars = DEFAULT_BARS }: WaveformOptions = {}) {
  const key = src ? `${bars}|${src}` : null
  const [loaded, setLoaded] = useState<{ key: string; peaks: number[] } | null>(null)

  useEffect(() => {
    if (!key || !src || cache.has(key)) return
    const Ctor = audioContextCtor()
    if (!Ctor) return
    if (sizeBytes != null && sizeBytes > MAX_DECODE_BYTES) return
    const controller = new AbortController()
    let ctx: AudioContext | null = null
    void (async () => {
      try {
        const res = await fetch(src, { signal: controller.signal })
        if (!res.ok) return
        const buffer = await res.arrayBuffer()
        if (controller.signal.aborted || buffer.byteLength > MAX_DECODE_BYTES) return
        ctx = new Ctor()
        const audio = await ctx.decodeAudioData(buffer)
        const peaks = computePeaks(audio.getChannelData(0), bars)
        cache.set(key, peaks)
        if (!controller.signal.aborted) setLoaded({ key, peaks })
      } catch {
        // Placeholder stays: aborted, missing file, or an undecodable format.
      } finally {
        if (ctx) void Promise.resolve(ctx.close()).catch(() => undefined)
      }
    })()
    return () => controller.abort()
  }, [key, src, sizeBytes, bars])

  const real = key ? cache.get(key) ?? (loaded?.key === key ? loaded.peaks : undefined) : undefined
  return { peaks: real ?? placeholderPeaks(bars), ready: Boolean(real) }
}
