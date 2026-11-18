/**
 * Masonry layout for the Artifacts gallery: tiles keep their own aspect ratio
 * and go, one by one, into whichever column is currently shortest (left first
 * on ties), so columns stay balanced and the order still reads left to right.
 */

/** Gap between tiles, in px (Tailwind `gap-2`). */
export const MASONRY_GAP = 8

/**
 * Columns for the grid container's width (not the window's), so tiles stay
 * large: 1 on phones, 2 on small screens, 3 on typical desktops (about
 * 335–510 px tiles), 4 only on very wide screens.
 */
export function columnCountFor(width: number): number {
  if (width < 560) return 1
  if (width < 1000) return 2
  if (width < 1650) return 3
  return 4
}

export interface MasonryTile {
  x: number
  y: number
  width: number
  height: number
  column: number
}

/**
 * Positions for tiles of the given aspect ratios (width / height) in `columns`
 * columns across `width` px. A missing or invalid ratio counts as square.
 */
export function layoutMasonry(
  aspects: readonly number[],
  columns: number,
  width: number,
  gap: number = MASONRY_GAP,
): { tiles: MasonryTile[]; height: number } {
  const count = Math.max(1, Math.floor(columns) || 1)
  const columnWidth = Math.max(0, (width - gap * (count - 1)) / count)
  const heights = new Array<number>(count).fill(0)
  const tiles = aspects.map((raw) => {
    const aspect = Number.isFinite(raw) && raw > 0 ? raw : 1
    let column = 0
    for (let c = 1; c < count; c++) if (heights[c] < heights[column]) column = c
    const height = columnWidth / aspect
    const tile = { x: column * (columnWidth + gap), y: heights[column], width: columnWidth, height, column }
    heights[column] += height + gap
    return tile
  })
  return { tiles, height: tiles.length === 0 ? 0 : Math.max(...heights) - gap }
}
