'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

export const AUTOSAVE_DELAY_MS = 600

export const nonBlank = (v: string) => v.trim().length > 0
export const always = () => true

/** A field that reads as plain text until hovered or focused. */
export const QUIET_FIELD = 'border-transparent bg-transparent px-2 shadow-none hover:border-input dark:bg-transparent'

/**
 * A text field that saves `AUTOSAVE_DELAY_MS` after the last change and on
 * blur. Invalid values are never saved; on blur they revert to the last saved
 * value. A failed save keeps the typed text and shows an error toast. Leaving
 * (unmount) saves what was typed.
 */
export function useAutosaveField(initial: string, save: (value: string) => Promise<unknown>, isValid: (value: string) => boolean, what: string) {
  const [value, setValue] = useState(initial)
  const latest = useRef(initial)
  const saved = useRef(initial)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  }, [save])

  const commit = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const next = latest.current
    if (!isValid(next) || next === saved.current) return
    const previous = saved.current
    saved.current = next
    void saveRef.current(next).catch((err) => {
      saved.current = previous
      toast.error(`Could not save the ${what}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, [isValid, what])

  const change = (next: string) => {
    latest.current = next
    setValue(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = isValid(next) ? setTimeout(commit, AUTOSAVE_DELAY_MS) : null
  }

  const blur = () => {
    commit()
    if (!isValid(latest.current)) {
      latest.current = saved.current
      setValue(saved.current)
    }
  }

  const commitRef = useRef(commit)
  useEffect(() => {
    commitRef.current = commit
  }, [commit])
  useEffect(() => () => commitRef.current(), [])

  return { value, change, blur, valid: isValid(value) }
}
