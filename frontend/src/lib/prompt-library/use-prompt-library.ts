'use client'

import { useCallback } from 'react'
import useSWR from 'swr'
import { PROMPT_LIBRARY_URL, createPrompt, deletePrompt, listPrompts, type PromptType, type SavedPrompt } from './api'

export interface PromptLibraryState {
  prompts: SavedPrompt[] | undefined
  error: Error | undefined
  isLoading: boolean
  retry: () => void
  /** Save a prompt; throws a readable Error and leaves the list unchanged on failure. */
  save: (name: string, type: PromptType, content: string) => Promise<SavedPrompt>
  /** Delete a prompt; throws a readable Error and leaves the list unchanged on failure. */
  remove: (id: string) => Promise<void>
}

/**
 * The prompt library, cached by SWR under `PROMPT_LIBRARY_URL`: every prompt
 * box on the page reads the same list, and a save or delete in one shows in
 * the others at once.
 */
export function usePromptLibrary(): PromptLibraryState {
  const { data, error, isLoading, mutate } = useSWR<SavedPrompt[], Error>(PROMPT_LIBRARY_URL, listPrompts, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })

  const save = useCallback(async (name: string, type: PromptType, content: string) => {
    const prompt = await createPrompt(name, type, content)
    await mutate((prev) => [...(prev ?? []), prompt], { revalidate: false })
    return prompt
  }, [mutate])

  const remove = useCallback(async (id: string) => {
    await deletePrompt(id)
    await mutate((prev) => (prev ?? []).filter((p) => p.id !== id), { revalidate: false })
  }, [mutate])

  return {
    prompts: data,
    error,
    isLoading: isLoading && !data,
    retry: () => {
      void mutate()
    },
    save,
    remove,
  }
}
