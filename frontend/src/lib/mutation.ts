'use client'

/**
 * One shape for a write the UI starts (save, remove, check now), so a
 * component does not hand-roll its own `saving` / `error` pair.
 *
 * Rule: a `run` while one is pending is ignored (it resolves `{status:
 * 'ignored'}` and does not call the function), so a double click or a second
 * Enter cannot send the write twice. A new run clears the previous error;
 * `reset` returns to idle and is ignored while pending. Nothing is set after
 * unmount. Give each unrelated action its own `useMutation`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { errorMessage } from './resource'

export type MutationState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'error'; message: string }

export type MutationResult<R> =
  | { status: 'done'; value: R }
  | { status: 'failed'; message: string; error: unknown }
  | { status: 'ignored' }

interface Options {
  /** Text for the error state; defaults to the error's message. */
  message?: (err: unknown) => string
}

export function useMutation<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  { message = errorMessage }: Options = {},
) {
  const [state, setState] = useState<MutationState>({ kind: 'idle' })
  const pending = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = async (...args: A): Promise<MutationResult<R>> => {
    if (pending.current) return { status: 'ignored' }
    pending.current = true
    setState({ kind: 'pending' })
    try {
      const value = await fn(...args)
      pending.current = false
      if (mounted.current) setState({ kind: 'idle' })
      return { status: 'done', value }
    } catch (error) {
      pending.current = false
      const text = message(error)
      if (mounted.current) setState({ kind: 'error', message: text })
      return { status: 'failed', message: text, error }
    }
  }

  const reset = useCallback(() => {
    if (pending.current) return
    setState({ kind: 'idle' })
  }, [])

  return { state, pending: state.kind === 'pending', run, reset }
}
