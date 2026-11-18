'use client'

import { useEffect, useRef } from 'react'
import type { BlockComponentProps, BlockWarning } from './registry'

/**
 * Publish a block's non-blocking warnings to its header warning badge.
 * Re-sends only when the ids or texts change; actions always call the latest
 * callback, so passing fresh closures each render is fine. Clears on unmount.
 */
export function useHeaderWarnings(setHeaderWarnings: BlockComponentProps['setHeaderWarnings'], warnings: readonly BlockWarning[]): void {
  const latest = useRef(warnings)
  useEffect(() => {
    latest.current = warnings
  })
  const signature = warnings.map((w) => `${w.id}\u0000${w.message}\u0000${w.action?.label ?? ''}\u0000${w.link?.href ?? ''}`).join('\u0001')
  useEffect(() => {
    if (!setHeaderWarnings) return
    const ids = signature ? latest.current.map((w) => w.id) : []
    setHeaderWarnings(ids.map((id) => {
      const w = latest.current.find((x) => x.id === id)!
      return {
        id,
        message: w.message,
        ...(w.link ? { link: { label: w.link.label, href: w.link.href } } : {}),
        ...(w.action ? { action: { label: w.action.label, onClick: () => latest.current.find((x) => x.id === id)?.action?.onClick() } } : {}),
      }
    }))
  }, [setHeaderWarnings, signature])
  useEffect(() => () => setHeaderWarnings?.([]), [setHeaderWarnings])
}
