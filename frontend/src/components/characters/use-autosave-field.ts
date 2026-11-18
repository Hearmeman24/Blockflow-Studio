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
 * blur. Invalid values are never saved; on blur they revert to the last value
 * sent. A failed save keeps the typed text and shows an error toast. Leaving
 * (unmount) saves what was typed.
 *
 * One save is in flight at a time. A value committed meanwhile waits, and
 * only the latest one waiting is sent when the save settles, so the server
 * (and the cache) end on what was typed last. A late failure of an earlier
 * save never makes an older value count as saved.
 */
export function useAutosaveField(initial: string, save: (value: string) => Promise<unknown>, isValid: (value: string) => boolean, what: string) {
  const [value, setValue] = useState(initial)
  const latest = useRef(initial)
  /** The last value the server accepted. */
  const confirmed = useRef(initial)
  /** The value being saved, and the newest one waiting for it. */
  const inflight = useRef<string | null>(null)
  const waiting = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  }, [save])

  /** Save `first`, then whatever was committed meanwhile, until nothing new waits. */
  const send = useCallback((first: string) => {
    const drain = async () => {
      let next: string | null = first
      while (next !== null) {
        const value: string = next
        inflight.current = value
        try {
          await saveRef.current(value)
          confirmed.current = value
        } catch (err) {
          toast.error(`Could not save the ${what}: ${err instanceof Error ? err.message : String(err)}`)
        }
        inflight.current = null
        const queued: string | null = waiting.current
        waiting.current = null
        next = queued !== null && queued !== confirmed.current ? queued : null
      }
    }
    void drain()
  }, [what])

  /** The value that will be on the server once the saves under way settle. */
  const lastSent = () => waiting.current ?? inflight.current ?? confirmed.current

  const commit = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const next = latest.current
    if (!isValid(next)) return
    if (inflight.current !== null) {
      // Wait for the save under way; the newest value replaces any older one waiting.
      waiting.current = next === inflight.current ? null : next
      return
    }
    if (next === confirmed.current) return
    send(next)
  }, [isValid, send])

  const change = (next: string) => {
    latest.current = next
    setValue(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = isValid(next) ? setTimeout(commit, AUTOSAVE_DELAY_MS) : null
  }

  const blur = () => {
    commit()
    if (!isValid(latest.current)) {
      const back = lastSent()
      latest.current = back
      setValue(back)
    }
  }

  const commitRef = useRef(commit)
  useEffect(() => {
    commitRef.current = commit
  }, [commit])
  useEffect(() => () => commitRef.current(), [])

  return { value, change, blur, valid: isValid(value) }
}
