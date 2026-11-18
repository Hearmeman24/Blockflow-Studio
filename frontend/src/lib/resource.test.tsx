import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

import { createRequestGate, errorMessage, fromSWR, useResource } from './resource'

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('errorMessage', () => {
  it('reads an Error message and stringifies anything else', () => {
    expect(errorMessage(new Error('HTTP 500'))).toBe('HTTP 500')
    expect(errorMessage('offline')).toBe('offline')
  })
})

describe('createRequestGate', () => {
  it('only the newest request is current', () => {
    const gate = createRequestGate()
    const first = gate.begin()
    const second = gate.begin()
    expect(gate.isCurrent(first)).toBe(false)
    expect(gate.isCurrent(second)).toBe(true)
  })

  it('invalidate makes every earlier request stale', () => {
    const gate = createRequestGate()
    const token = gate.begin()
    gate.invalidate()
    expect(gate.isCurrent(token)).toBe(false)
  })
})

describe('fromSWR', () => {
  it('maps loading, error and data', () => {
    expect(fromSWR({ data: undefined, error: undefined, isLoading: true })).toEqual({ kind: 'loading' })
    expect(fromSWR({ data: undefined, error: new Error('offline'), isLoading: false }))
      .toEqual({ kind: 'error', message: 'offline' })
    expect(fromSWR({ data: 3, error: undefined, isLoading: false })).toEqual({ kind: 'ready', data: 3 })
  })

  it('keeps showing data it already has when a revalidation fails', () => {
    expect(fromSWR({ data: 'v1', error: new Error('offline'), isLoading: false }))
      .toEqual({ kind: 'ready', data: 'v1' })
  })

  it('is loading before the first request starts', () => {
    expect(fromSWR({ data: undefined, error: undefined, isLoading: false })).toEqual({ kind: 'loading' })
  })
})

describe('useResource', () => {
  it('starts loading, then holds the data', async () => {
    const { result } = renderHook(() => useResource(async () => 'ok', []))
    expect(result.current.resource).toEqual({ kind: 'loading' })
    await waitFor(() => expect(result.current.resource).toEqual({ kind: 'ready', data: 'ok' }))
  })

  it('an error carries the message; retry shows loading again, then the data', async () => {
    const answers = [deferred<string>(), deferred<string>()]
    let call = 0
    const fetcher = vi.fn(() => answers[call++].promise)
    const { result } = renderHook(() => useResource(fetcher, []))
    await act(async () => answers[0].reject(new Error('HTTP 503')))
    expect(result.current.resource).toEqual({ kind: 'error', message: 'HTTP 503' })

    act(() => result.current.retry())
    expect(result.current.resource).toEqual({ kind: 'loading' })
    await act(async () => answers[1].resolve('back'))
    expect(result.current.resource).toEqual({ kind: 'ready', data: 'back' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('a late answer from an earlier request never overwrites a newer one', async () => {
    const slow = deferred<string>()
    const fast = deferred<string>()
    const { result, rerender } = renderHook(
      ({ id }) => useResource(() => (id === 1 ? slow.promise : fast.promise), [id]),
      { initialProps: { id: 1 } },
    )
    rerender({ id: 2 })
    await act(async () => fast.resolve('new'))
    await act(async () => slow.resolve('old'))
    expect(result.current.resource).toEqual({ kind: 'ready', data: 'new' })
  })

  it('a late error from an earlier request is ignored too', async () => {
    const slow = deferred<string>()
    const fast = deferred<string>()
    const { result, rerender } = renderHook(
      ({ id }) => useResource(() => (id === 1 ? slow.promise : fast.promise), [id]),
      { initialProps: { id: 1 } },
    )
    rerender({ id: 2 })
    await act(async () => fast.resolve('new'))
    await act(async () => slow.reject(new Error('old failure')))
    expect(result.current.resource).toEqual({ kind: 'ready', data: 'new' })
  })

  it('aborts the earlier request when a newer one starts, and on unmount', () => {
    const signals: AbortSignal[] = []
    const { rerender, unmount } = renderHook(
      ({ id }) => useResource((signal) => {
        signals.push(signal)
        return new Promise<number>(() => {})
      }, [id]),
      { initialProps: { id: 1 } },
    )
    rerender({ id: 2 })
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
    unmount()
    expect(signals[1].aborted).toBe(true)
  })

  it('does not update state after unmount', async () => {
    const answer = deferred<string>()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result, unmount } = renderHook(() => useResource(() => answer.promise, []))
    unmount()
    await act(async () => answer.resolve('late'))
    expect(result.current.resource).toEqual({ kind: 'loading' })
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('does not fetch while disabled, and fetches once enabled', async () => {
    const fetcher = vi.fn(async () => 'folder')
    const { result, rerender } = renderHook(
      ({ enabled }) => useResource(fetcher, [enabled], { enabled }),
      { initialProps: { enabled: false } },
    )
    expect(fetcher).not.toHaveBeenCalled()
    expect(result.current.resource).toEqual({ kind: 'loading' })
    rerender({ enabled: true })
    await waitFor(() => expect(result.current.resource).toEqual({ kind: 'ready', data: 'folder' }))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refresh keeps the shown data and replaces it when the answer arrives', async () => {
    const answers = [deferred<string>(), deferred<string>()]
    let call = 0
    const { result } = renderHook(() => useResource(() => answers[call++].promise, []))
    await act(async () => answers[0].resolve('v1'))

    let refreshed: Promise<string> | undefined
    act(() => {
      refreshed = result.current.refresh()
    })
    expect(result.current.resource).toEqual({ kind: 'ready', data: 'v1' })
    await act(async () => answers[1].resolve('v2'))
    await expect(refreshed).resolves.toBe('v2')
    expect(result.current.resource).toEqual({ kind: 'ready', data: 'v2' })
  })

  it('a failed refresh rejects and leaves the shown data alone', async () => {
    const answers = [deferred<string>(), deferred<string>()]
    let call = 0
    const { result } = renderHook(() => useResource(() => answers[call++].promise, []))
    await act(async () => answers[0].resolve('v1'))

    let refreshed: Promise<string> | undefined
    act(() => {
      refreshed = result.current.refresh()
    })
    const settled = refreshed!.catch((err: unknown) => err)
    await act(async () => answers[1].reject(new Error('offline')))
    expect(await settled).toEqual(new Error('offline'))
    expect(result.current.resource).toEqual({ kind: 'ready', data: 'v1' })
  })

  it('setData edits ready data and does nothing before the data is there', async () => {
    const answer = deferred<number>()
    const { result } = renderHook(() => useResource(() => answer.promise, []))
    act(() => result.current.setData((n) => n + 1))
    expect(result.current.resource).toEqual({ kind: 'loading' })
    await act(async () => answer.resolve(1))
    act(() => result.current.setData((n) => n + 1))
    expect(result.current.resource).toEqual({ kind: 'ready', data: 2 })
  })

  it('setData wins over an answer still in flight from before the edit', async () => {
    const answers = [deferred<number>(), deferred<number>()]
    let call = 0
    const { result } = renderHook(() => useResource(() => answers[call++].promise, []))
    await act(async () => answers[0].resolve(1))
    act(() => {
      void result.current.refresh().catch(() => {})
    })
    act(() => result.current.setData(() => 10))
    await act(async () => answers[1].resolve(2))
    expect(result.current.resource).toEqual({ kind: 'ready', data: 10 })
  })
})
