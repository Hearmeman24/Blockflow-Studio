import { describe, expect, it } from 'vitest'
import { columnCountFor, layoutMasonry, MASONRY_GAP } from './masonry'

describe('columnCountFor', () => {
  // Widths are the grid container's, not the window's: from tablet width up the
  // page is 80 % of the window; on phones it is the window minus the side-nav
  // inset and the right gutter.
  it('gives 1 column on phones, 2 on small screens, 3 on typical desktops, 4 only when very wide', () => {
    expect(columnCountFor(0)).toBe(1)
    expect(columnCountFor(285)).toBe(1) // 375 px phone
    expect(columnCountFor(559)).toBe(1)
    expect(columnCountFor(614)).toBe(2) // 768 px tablet
    expect(columnCountFor(999)).toBe(2)
    expect(columnCountFor(1024)).toBe(3) // 1280 px window
    expect(columnCountFor(1152)).toBe(3) // 1440 px window
    expect(columnCountFor(1536)).toBe(3) // 1920 px window
    expect(columnCountFor(1650)).toBe(4)
    expect(columnCountFor(3000)).toBe(4)
  })

  it('keeps tiles at least about 300 px wide from two columns up', () => {
    for (let w = 560; w <= 2600; w += 8) {
      const n = columnCountFor(w)
      if (n > 1) expect((w - 8 * (n - 1)) / n).toBeGreaterThanOrEqual(270)
    }
  })
})

describe('layoutMasonry', () => {
  it('puts each tile in the shortest column, left to right on ties', () => {
    // 2 columns of 100px (208 = 2 × 100 + 8 gap); aspect = width / height.
    const { tiles, height } = layoutMasonry([1, 0.5, 2, 1], 2, 208, 8)
    expect(tiles.map((t) => t.column)).toEqual([0, 1, 0, 0])
    expect(tiles[0]).toEqual({ x: 0, y: 0, width: 100, height: 100, column: 0 })
    expect(tiles[1]).toEqual({ x: 108, y: 0, width: 100, height: 200, column: 1 })
    // Column 0 is at 108 after the first tile, column 1 at 208: tile 2 goes left.
    expect(tiles[2]).toEqual({ x: 0, y: 108, width: 100, height: 50, column: 0 })
    expect(tiles[3]).toEqual({ x: 0, y: 166, width: 100, height: 100, column: 0 })
    expect(height).toBe(266)
  })

  it('keeps the tile order in reading order when all tiles are equal', () => {
    const { tiles } = layoutMasonry([1, 1, 1, 1, 1, 1], 3, 300, 0)
    expect(tiles.map((t) => [t.column, t.y])).toEqual([[0, 0], [1, 0], [2, 0], [0, 100], [1, 100], [2, 100]])
  })

  it('treats a missing or invalid aspect ratio as square', () => {
    const { tiles } = layoutMasonry([0, Number.NaN, -2, Infinity], 4, 400, 0)
    expect(tiles.every((t) => t.height === 100)).toBe(true)
  })

  it('handles no tiles, zero width and a bad column count without throwing', () => {
    expect(layoutMasonry([], 3, 900)).toEqual({ tiles: [], height: 0 })
    const zero = layoutMasonry([1, 1], 2, 0)
    expect(zero.tiles.map((t) => t.width)).toEqual([0, 0])
    expect(layoutMasonry([1], 0, 100, 0).tiles[0].width).toBe(100)
  })

  it('uses the shared default gap', () => {
    const { tiles } = layoutMasonry([1, 1], 2, 200 + MASONRY_GAP)
    expect(tiles[1].x).toBe(100 + MASONRY_GAP)
  })
})
