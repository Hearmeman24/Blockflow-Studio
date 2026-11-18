/**
 * Autosave: one save in flight at a time, coalesced to the latest value, and
 * a late failure never brings an older value back as "saved".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

import { AUTOSAVE_DELAY_MS, always, nonBlank, useAutosaveField } from './use-autosave-field'

function deferred() {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let answers: ReturnType<typeof deferred>[]
const save = vi.fn((value: string) => {
  void value
  const d = deferred()
  answers.push(d)
  return d.promise
})

beforeEach(() => {
  vi.useFakeTimers()
  answers = []
  save.mockClear()
  toastError.mockReset()
})
afterEach(() => vi.useRealTimers())

type Field = { current: { change: (v: string) => void } }
const type = async (field: Field, value: string) => {
  act(() => field.current.change(value))
  await act(async () => { vi.advanceTimersByTime(AUTOSAVE_DELAY_MS) })
}
const sent = () => save.mock.calls.map((c) => c[0])

describe('useAutosaveField', () => {
  it('a change while a save is in flight waits, and only the latest value is sent next', async () => {
    const { result } = renderHook(() => useAutosaveField('A', save, nonBlank, 'name'))
    await type(result, 'Ann')
    expect(sent()).toEqual(['Ann'])
    await type(result, 'Anna')
    await type(result, 'Annabel')
    expect(save).toHaveBeenCalledTimes(1)
    await act(async () => { answers[0].resolve() })
    expect(sent()).toEqual(['Ann', 'Annabel'])
    await act(async () => { answers[1].resolve() })
    act(() => result.current.blur())
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('an earlier save failing after a later one was typed still sends the later one, and does not resend', async () => {
    const { result } = renderHook(() => useAutosaveField('A', save, always, 'notes'))
    await type(result, 'Ann')
    await type(result, 'Anna')
    await act(async () => { answers[0].reject(new Error('offline')) })
    expect(toastError).toHaveBeenCalledWith('Could not save the notes: offline')
    expect(sent()).toEqual(['Ann', 'Anna'])
    await act(async () => { answers[1].resolve() })
    act(() => result.current.blur())
    expect(save).toHaveBeenCalledTimes(2)
    expect(result.current.value).toBe('Anna')
  })

  it('a failed save keeps the text and the next blur tries again', async () => {
    const { result } = renderHook(() => useAutosaveField('A', save, always, 'notes'))
    await type(result, 'Ann')
    await act(async () => { answers[0].reject(new Error('offline')) })
    expect(result.current.value).toBe('Ann')
    act(() => result.current.blur())
    expect(sent()).toEqual(['Ann', 'Ann'])
  })

  it('typing back to the saved value while a save is in flight sends that value after it', async () => {
    const { result } = renderHook(() => useAutosaveField('A', save, always, 'notes'))
    await type(result, 'Ann')
    await type(result, 'A')
    await act(async () => { answers[0].resolve() })
    expect(sent()).toEqual(['Ann', 'A'])
  })

  it('an invalid value is not saved and blur reverts to the last value sent', async () => {
    const { result } = renderHook(() => useAutosaveField('A', save, nonBlank, 'name'))
    await type(result, 'Ann')
    act(() => result.current.change('  '))
    act(() => result.current.blur())
    expect(result.current.value).toBe('Ann')
    expect(save).toHaveBeenCalledTimes(1)
  })
})
