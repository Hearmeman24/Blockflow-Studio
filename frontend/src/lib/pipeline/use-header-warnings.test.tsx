import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useHeaderWarnings } from './use-header-warnings'
import type { BlockWarning } from './registry'

describe('useHeaderWarnings', () => {
  it('passes a warning link through, and re-sends when the link changes', () => {
    const set = vi.fn()
    const first: BlockWarning[] = [{ id: 'p', message: 'Price changed.', link: { label: 'Report price change', href: 'https://github.com/a/b/issues/new' } }]
    const { rerender } = renderHook(({ w }) => useHeaderWarnings(set, w), { initialProps: { w: first } })
    expect(set).toHaveBeenLastCalledWith([{ id: 'p', message: 'Price changed.', link: { label: 'Report price change', href: 'https://github.com/a/b/issues/new' } }])
    const calls = set.mock.calls.length
    rerender({ w: [{ ...first[0], link: { label: 'Report price change', href: 'https://github.com/a/b/issues/new?x=1' } }] })
    expect(set.mock.calls.length).toBe(calls + 1)
    expect(set.mock.calls.at(-1)![0][0].link.href).toBe('https://github.com/a/b/issues/new?x=1')
  })
})
