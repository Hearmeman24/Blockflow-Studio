'use client'

import { useCallback } from 'react'
import useSWR, { useSWRConfig, type KeyedMutator } from 'swr'
import { fromSWR, type Resource } from '@/lib/resource'
import {
  CHARACTERS_URL,
  createCharacter,
  deleteCharacter,
  deleteCharacterMedia,
  listCharacters,
  reorderCharacterMedia,
  updateCharacter,
  uploadCharacterMedia,
} from './api'
import { createSerialQueue, movedOrder, type SerialQueue } from './mutation-queue'
import type { Character, CharacterCreate, CharacterMedia, CharacterMediaKind, CharacterMediaMeta, CharacterPatch } from './types'

// ---- Pure helpers (shared with the Load Character block) ----

/** The media of one kind, in position order. */
export function mediaOfKind(character: Character, kind: CharacterMediaKind): CharacterMedia[] {
  return character.media.filter((m) => m.kind === kind).sort((a, b) => a.position - b.position)
}

function defaultOf(character: Character, id: string | null, kind: CharacterMediaKind): CharacterMedia | null {
  if (!id) return null
  return character.media.find((m) => m.id === id && m.kind === kind) ?? null
}

/** The default face image, or null when none is set or it no longer exists. */
export function defaultFace(character: Character): CharacterMedia | null {
  return defaultOf(character, character.default_face_id, 'image')
}

/** True when the character has no face yet (created before a face was required). */
export function needsFace(character: Character): boolean {
  return defaultFace(character) === null
}

/** The default audio clip, or null when none is set or it no longer exists. */
export function defaultAudio(character: Character): CharacterMedia | null {
  return defaultOf(character, character.default_audio_id, 'audio')
}

/** Replace the character with the same id, or append it. */
export function upsertCharacter(list: readonly Character[] | undefined, character: Character): Character[] {
  const current = list ?? []
  return current.some((c) => c.id === character.id)
    ? current.map((c) => (c.id === character.id ? character : c))
    : [...current, character]
}

// ---- Hook ----

export interface CharactersState {
  /** The list as one state: loading, error (and nothing to show) or ready. */
  resource: Resource<Character[]>
  characters: Character[] | undefined
  error: Error | undefined
  isLoading: boolean
  retry: () => void
  mutate: KeyedMutator<Character[]>
  create: (input: CharacterCreate) => Promise<Character>
  update: (id: string, patch: CharacterPatch) => Promise<Character>
  remove: (id: string) => Promise<void>
  uploadMedia: (id: string, file: File, kind: CharacterMediaKind, meta?: CharacterMediaMeta) => Promise<{ media: CharacterMedia; character: Character }>
  removeMedia: (id: string, mediaId: string) => Promise<Character>
  reorderMedia: (id: string, kind: CharacterMediaKind, ids: string[]) => Promise<Character>
  /** Move one item a place earlier (-1) or later (1) among its kind, skipping `lockedIds`. The
   * order is built when the move runs, from the result of the change before it. */
  moveMedia: (id: string, mediaId: string, delta: -1 | 1, lockedIds?: readonly string[]) => Promise<Character | null>
}

/** One queue per SWR cache, so every consumer of the same cache shares it. */
const queues = new WeakMap<object, SerialQueue>()
function queueFor(cache: object): SerialQueue {
  let queue = queues.get(cache)
  if (!queue) {
    queue = createSerialQueue()
    queues.set(cache, queue)
  }
  return queue
}

/**
 * The character list, cached by SWR under `CHARACTERS_URL`. Every mutation
 * writes the character the server returns into the cache, so all consumers
 * (the Characters page and pipeline blocks) re-render with it. A failed
 * mutation throws and leaves the cache as it was.
 *
 * Changes to one character run one at a time, in the order they were made
 * (a serial queue per character id), so the cache ends on the answer to the
 * last request, not the last answer to arrive.
 */
export function useCharacters(): CharactersState {
  const { data, error, isLoading, mutate } = useSWR<Character[], Error>(CHARACTERS_URL, listCharacters, {
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  })

  const { cache } = useSWRConfig()
  const queue = queueFor(cache)

  const put = useCallback(async (character: Character) => {
    await mutate((prev) => upsertCharacter(prev, character), { revalidate: false })
    return character
  }, [mutate])

  const create = useCallback(async (input: CharacterCreate) => put(await createCharacter(input)), [put])
  const update = useCallback(
    (id: string, patch: CharacterPatch) => queue.run(id, async () => put(await updateCharacter(id, patch))),
    [put, queue],
  )
  const remove = useCallback((id: string) => queue.run(id, async () => {
    await deleteCharacter(id)
    await mutate((prev) => (prev ?? []).filter((c) => c.id !== id), { revalidate: false })
  }), [mutate, queue])
  const uploadMedia = useCallback(
    (id: string, file: File, kind: CharacterMediaKind, meta: CharacterMediaMeta = {}) => queue.run(id, async () => {
      const result = await uploadCharacterMedia(id, file, kind, meta)
      await put(result.character)
      return result
    }),
    [put, queue],
  )
  const removeMedia = useCallback(
    (id: string, mediaId: string) => queue.run(id, async () => put(await deleteCharacterMedia(id, mediaId))),
    [put, queue],
  )
  const reorderMedia = useCallback(
    (id: string, kind: CharacterMediaKind, ids: string[]) => queue.run(id, async () => put(await reorderCharacterMedia(id, kind, ids))),
    [put, queue],
  )
  const moveMedia = useCallback(
    (id: string, mediaId: string, delta: -1 | 1, lockedIds: readonly string[] = []) => queue.run(id, async () => {
      // Read the character now, after every change queued before this one.
      const list = (cache.get(CHARACTERS_URL)?.data as Character[] | undefined) ?? []
      const character = list.find((c) => c.id === id)
      const item = character?.media.find((m) => m.id === mediaId)
      if (!character || !item) return null
      const ids = movedOrder(mediaOfKind(character, item.kind).map((m) => m.id), mediaId, delta, lockedIds)
      if (!ids) return character
      return put(await reorderCharacterMedia(id, item.kind, ids))
    }),
    [cache, put, queue],
  )

  // A retry with nothing to show is loading again, not the old error.
  const resource: Resource<Character[]> = isLoading && !data ? { kind: 'loading' } : fromSWR<Character[]>({ data, error })
  return {
    resource,
    characters: data,
    error,
    isLoading: resource.kind === 'loading',
    retry: () => {
      void mutate()
    },
    mutate,
    create,
    update,
    remove,
    uploadMedia,
    removeMedia,
    reorderMedia,
    moveMedia,
  }
}
