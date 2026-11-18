'use client'

import { useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

function query(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null
}

function subscribe(onChange: () => void): () => void {
  const mql = query()
  if (!mql?.addEventListener) return () => {}
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

/** True when the user asked the system for less motion. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, () => query()?.matches ?? false, () => false)
}
