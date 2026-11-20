import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  INITIAL_VIEWER_HISTORY,
  MAX_VIEWER_HISTORY,
  VIEWER_STRIP_PAGE,
  useViewerHistory,
  viewerHistoryReducer,
} from './use-viewer-history'

function setup(initial: string[] = []) {
  return renderHook(({ urls }) => useViewerHistory(urls), { initialProps: { urls: initial } })
}

describe('useViewerHistory', () => {
  it('an empty viewer shows nothing', () => {
    const { result } = setup()
    expect(result.current.displayUrls).toEqual([])
    expect(result.current.selectedIndex).toBe(0)
    expect(result.current.history).toEqual([])
  })

  it('shows the first output and appends each new one, selecting the newest', () => {
    const { result, rerender } = setup(['a'])
    expect(result.current.displayUrls).toEqual(['a'])
    rerender({ urls: ['b', 'c'] })
    expect(result.current.displayUrls).toEqual(['a', 'b', 'c'])
    expect(result.current.selectedIndex).toBe(2)
  })

  it('adds only the files it has not shown yet', () => {
    const { result, rerender } = setup(['a'])
    rerender({ urls: ['a', 'b'] })
    expect(result.current.history).toEqual(['a', 'b'])
  })

  it('the same output on a later render (a new array) is not added again', () => {
    const { result, rerender } = setup(['a'])
    rerender({ urls: ['a'] })
    rerender({ urls: ['a'] })
    expect(result.current.history).toEqual(['a'])
  })

  it('keeps the history when the input goes empty, and does not re-add the same output after', () => {
    const { result, rerender } = setup(['a'])
    rerender({ urls: ['b'] })
    rerender({ urls: [] })
    expect(result.current.displayUrls).toEqual(['a', 'b'])
    rerender({ urls: ['b'] })
    expect(result.current.history).toEqual(['a', 'b'])
  })

  it('Clear empties the history and hides the current output, also across renders', () => {
    const { result, rerender } = setup(['a'])
    rerender({ urls: ['b'] })
    act(() => result.current.clear())
    expect(result.current.displayUrls).toEqual([])
    expect(result.current.selectedIndex).toBe(0)
    rerender({ urls: ['b'] })
    rerender({ urls: ['b'] })
    expect(result.current.displayUrls).toEqual([])
  })

  it('after Clear, a new output shows on its own', () => {
    const { result, rerender } = setup(['a'])
    rerender({ urls: ['b'] })
    act(() => result.current.clear())
    rerender({ urls: ['c'] })
    expect(result.current.displayUrls).toEqual(['c'])
    expect(result.current.selectedIndex).toBe(0)
  })

  it('Clear during a loop: the next iteration starts a new history', () => {
    const { result, rerender } = setup(['loop-1'])
    rerender({ urls: ['loop-2'] })
    act(() => result.current.clear())
    rerender({ urls: ['loop-3'] })
    rerender({ urls: ['loop-4'] })
    expect(result.current.displayUrls).toEqual(['loop-3', 'loop-4'])
  })

  it('select picks an output; the index stays within the list', () => {
    const { result, rerender } = setup(['a'])
    rerender({ urls: ['b'] })
    act(() => result.current.select(0))
    expect(result.current.selectedIndex).toBe(0)
    act(() => result.current.select(9))
    expect(result.current.selectedIndex).toBe(1)
  })
})

describe('viewerHistoryReducer', () => {
  it('ignores an empty or unchanged output', () => {
    const s = viewerHistoryReducer(INITIAL_VIEWER_HISTORY, { type: 'output', urls: ['a'] })
    expect(viewerHistoryReducer(s, { type: 'output', urls: [] })).toBe(s)
    expect(viewerHistoryReducer(s, { type: 'output', urls: ['a'] })).toBe(s)
  })
})

describe('viewerHistoryReducer: stored cap and the strip window', () => {
  const urls = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `u${from + i}`)
  const withHistory = (n: number) => viewerHistoryReducer(INITIAL_VIEWER_HISTORY, { type: 'output', urls: urls(n) })

  it('starts with the strip showing the latest STRIP_PAGE entries', () => {
    expect(INITIAL_VIEWER_HISTORY.revealed).toBe(VIEWER_STRIP_PAGE)
    expect(VIEWER_STRIP_PAGE).toBe(30)
  })

  it('output: keeps at most MAX_VIEWER_HISTORY entries, dropping the oldest, and selects the newest', () => {
    let s = withHistory(MAX_VIEWER_HISTORY - 1)
    s = viewerHistoryReducer(s, { type: 'output', urls: ['n1', 'n2', 'n3'] })
    expect(s.history).toHaveLength(MAX_VIEWER_HISTORY)
    expect(s.history[0]).toBe('u2')
    expect(s.history.slice(-3)).toEqual(['n1', 'n2', 'n3'])
    expect(s.selected).toBe(MAX_VIEWER_HISTORY - 1)
  })

  it('output: one batch larger than the cap keeps its newest entries', () => {
    const s = withHistory(MAX_VIEWER_HISTORY + 50)
    expect(s.history).toHaveLength(MAX_VIEWER_HISTORY)
    expect(s.history[0]).toBe('u50')
    expect(s.selected).toBe(MAX_VIEWER_HISTORY - 1)
  })

  it('output: keeps how much of the strip was revealed', () => {
    let s = viewerHistoryReducer(withHistory(100), { type: 'show_older' })
    s = viewerHistoryReducer(s, { type: 'output', urls: ['new'] })
    expect(s.revealed).toBe(2 * VIEWER_STRIP_PAGE)
  })

  it('show_older: reveals one more page, up to the whole history', () => {
    let s = withHistory(75)
    s = viewerHistoryReducer(s, { type: 'show_older' })
    expect(s.revealed).toBe(60)
    s = viewerHistoryReducer(s, { type: 'show_older' })
    expect(s.revealed).toBe(75)
    expect(viewerHistoryReducer(s, { type: 'show_older' })).toBe(s)
  })

  it('show_older: nothing hidden, nothing changes', () => {
    const s = withHistory(10)
    expect(viewerHistoryReducer(s, { type: 'show_older' })).toBe(s)
    expect(viewerHistoryReducer(INITIAL_VIEWER_HISTORY, { type: 'show_older' })).toBe(INITIAL_VIEWER_HISTORY)
  })

  it('clear: the strip goes back to one page', () => {
    const s = viewerHistoryReducer(viewerHistoryReducer(withHistory(90), { type: 'show_older' }), { type: 'clear' })
    expect(s.revealed).toBe(VIEWER_STRIP_PAGE)
    expect(s.history).toEqual([])
  })

  it('select: leaves the strip window alone', () => {
    const s = viewerHistoryReducer(withHistory(90), { type: 'select', index: 3 })
    expect(s.revealed).toBe(VIEWER_STRIP_PAGE)
    expect(s.selected).toBe(3)
  })
})

describe('useViewerHistory strip window', () => {
  it('reports where the strip starts and how many older entries are hidden', () => {
    const many = Array.from({ length: 45 }, (_, i) => `v${i}`)
    const { result } = setup(many)
    expect(result.current.stripStart).toBe(15)
    expect(result.current.hiddenOlder).toBe(15)
    expect(result.current.displayUrls).toHaveLength(45)
    act(() => result.current.showOlder())
    expect(result.current.stripStart).toBe(0)
    expect(result.current.hiddenOlder).toBe(0)
  })

  it('nothing is hidden before the first output', () => {
    const { result } = setup()
    expect(result.current.stripStart).toBe(0)
    expect(result.current.hiddenOlder).toBe(0)
  })
})
