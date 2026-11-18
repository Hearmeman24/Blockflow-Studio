import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { INITIAL_VIEWER_HISTORY, useViewerHistory, viewerHistoryReducer } from './use-viewer-history'

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
