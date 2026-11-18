'use client'

import { useLayoutEffect } from 'react'
import type { BlockComponentProps } from './registry'

/**
 * Tell the block card how many items the fullest media section of a loader
 * shows, so the card can narrow to the md width while there are only a few
 * (see `MEDIA_NARROW_MAX_ITEMS` in block-card.tsx). Pass one count per section.
 * A layout effect, so the card has its width before the first paint; clears on
 * unmount.
 */
export function useMediaItemCount(
  setMediaItemCount: BlockComponentProps['setMediaItemCount'],
  sectionCounts: readonly number[],
): void {
  const most = Math.max(0, ...sectionCounts)
  useLayoutEffect(() => {
    setMediaItemCount?.(most)
  }, [setMediaItemCount, most])
  useLayoutEffect(() => () => setMediaItemCount?.(null), [setMediaItemCount])
}
