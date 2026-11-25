/**
 * The aspect ratio a viewer frame takes from the media it shows (Image and
 * Video Viewer, in the block and in full screen).
 */

/** The ratio a frame assumes until the media reports its size. */
export const DEFAULT_MEDIA_RATIO = 16 / 9
/** Ratios beyond these are letterboxed rather than making a sliver of a frame. */
const MIN_RATIO = 1 / 4
const MAX_RATIO = 4

/** Width over height, kept within [1/4, 4]; null for a size that is not one. */
export function mediaRatio(width: number, height: number): number | null {
  if (!(width > 0) || !(height > 0)) return null
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, width / height))
}
