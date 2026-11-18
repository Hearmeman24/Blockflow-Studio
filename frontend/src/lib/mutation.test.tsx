import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { useMutation } from './mutation'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useMutation', () => {
  it('goes idle, pending, then back to idle with the value', async () => {
    const answer = deferred<string>()
    const { result } = renderHook(() => useMutation((name: string) => answer.promise.then((v) => `${v} ${name}`)))
    expect(result.current.state).toEqual({ kind: 'idle' })

    let outcome: Promise<unknown> | undefined
    act(() => {
      outcome = result.current.run('kie')
    })
    expect(result.current.state).toEqual({ kind: 'pending' })
    expect(result.current.pending).toBe(true)
    await act(async () => answer.resolve('saved'))
    await expect(outcome).resolves.toEqual({ status: 'done', value: 'saved kie' })
    expect(result.current.state).toEqual({ kind: 'idle' })
  })

  it('a failure becomes an error state with the message', async () => {
    const { result } = renderHook(() => useMutation(async () => {
      throw new Error('HTTP 500')
    }))
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.run()
    })
    expect(outcome).toEqual({ status: 'failed', message: 'HTTP 500', error: new Error('HTTP 500') })
    expect(result.current.state).toEqual({ kind: 'error', message: 'HTTP 500' })
  })

  it('maps the error message when asked to', async () => {
    const { result } = renderHook(() => useMutation(
      async () => {
        throw new Error('HTTP 500')
      },
      { message: () => 'Could not save this setting. Try again.' },
    ))
    await act(async () => {
      await result.current.run()
    })
    expect(result.current.state).toEqual({ kind: 'error', message: 'Could not save this setting. Try again.' })
  })

  it('ignores a second run while the first is pending (double submit)', async () => {
    const answer = deferred<void>()
    const fn = vi.fn(() => answer.promise)
    const { result } = renderHook(() => useMutation(fn))
    let second: unknown
    await act(async () => {
      void result.current.run()
      second = await result.current.run()
    })
    expect(second).toEqual({ status: 'ignored' })
    expect(fn).toHaveBeenCalledTimes(1)
    await act(async () => answer.resolve())
    expect(result.current.state).toEqual({ kind: 'idle' })
  })

  it('a new run clears the previous error', async () => {
    let fail = true
    const answer = deferred<void>()
    const { result } = renderHook(() => useMutation(async () => {
      if (fail) throw new Error('nope')
      return answer.promise
    }))
    await act(async () => {
      await result.current.run()
    })
    fail = false
    act(() => {
      void result.current.run()
    })
    expect(result.current.state).toEqual({ kind: 'pending' })
    await act(async () => answer.resolve())
  })

  it('reset clears an error and is ignored while pending', async () => {
    const answer = deferred<void>()
    let fail = true
    const { result } = renderHook(() => useMutation(async () => {
      if (fail) throw new Error('nope')
      return answer.promise
    }))
    await act(async () => {
      await result.current.run()
    })
    act(() => result.current.reset())
    expect(result.current.state).toEqual({ kind: 'idle' })

    fail = false
    act(() => {
      void result.current.run()
    })
    act(() => result.current.reset())
    expect(result.current.state).toEqual({ kind: 'pending' })
    await act(async () => answer.resolve())
  })

  it('does not update state after unmount', async () => {
    const answer = deferred<void>()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result, unmount } = renderHook(() => useMutation(() => answer.promise))
    let outcome: Promise<unknown> | undefined
    act(() => {
      outcome = result.current.run()
    })
    unmount()
    await act(async () => answer.reject(new Error('late')))
    await expect(outcome).resolves.toMatchObject({ status: 'failed', message: 'late' })
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})
