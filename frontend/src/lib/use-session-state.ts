'use client'

import { useState, useEffect, useMemo, useSyncExternalStore } from 'react'

const listeners = new Map<string, Set<() => void>>()

/** Tell `useSessionValues` readers that `key` was written. */
export function notifySessionKey(key: string): void {
  listeners.get(key)?.forEach((fn) => fn())
}

function subscribeKeys(keys: readonly string[], fn: () => void): () => void {
  for (const key of keys) {
    const set = listeners.get(key) ?? new Set()
    set.add(fn)
    listeners.set(key, set)
  }
  return () => {
    for (const key of keys) {
      const set = listeners.get(key)
      set?.delete(fn)
      if (set && set.size === 0) listeners.delete(key)
    }
  }
}

function readRaw(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * Like useState, but persists to sessionStorage so state survives
 * client-side navigation (component unmount/remount) without
 * persisting across tab closes.
 */
export function useSessionState<T>(key: string, defaultValue: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return defaultValue
    try {
      const stored = sessionStorage.getItem(key)
      return stored ? JSON.parse(stored) : defaultValue
    } catch {
      return defaultValue
    }
  })

  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value))
    } catch {
      // quota exceeded or unavailable — ignore
    }
    notifySessionKey(key)
  }, [key, value])

  return [value, setValue]
}

const SEPARATOR = '\u0000'

/**
 * Read-only view of other components' `useSessionState` keys, parsed from
 * JSON (`null` when unset or unreadable). Re-renders when any of the keys is
 * written through `useSessionState`, e.g. a downstream block's model choice.
 */
export function useSessionValues(keys: readonly string[]): unknown[] {
  const joined = keys.join(SEPARATOR)
  const stableKeys = useMemo(() => (joined ? joined.split(SEPARATOR) : []), [joined])
  const snapshot = useSyncExternalStore(
    (fn) => subscribeKeys(stableKeys, fn),
    () => stableKeys.map((k) => readRaw(k) ?? '').join(SEPARATOR),
    () => '',
  )
  return useMemo(() => {
    const raws = snapshot ? snapshot.split(SEPARATOR) : []
    return stableKeys.map((_, i) => {
      const raw = raws[i]
      if (!raw) return null
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    })
  }, [snapshot, stableKeys])
}
