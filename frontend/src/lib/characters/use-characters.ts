'use client'

import { useCallback } from 'react'
import useSWR, { type KeyedMutator } from 'swr'
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
}

/**
 * The character list, cached by SWR under `CHARACTERS_URL`. Every mutation
 * writes the character the server returns into the cache, so all consumers
 * (the Characters page and pipeline blocks) re-render with it. A failed
 * mutation throws and leaves the cache as it was.
 */
export function useCharacters(): CharactersState {
  const { data, error, isLoading, mutate } = useSWR<Character[], Error>(CHARACTERS_URL, listCharacters, {
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  })

  const put = useCallback(async (character: Character) => {
    await mutate((prev) => upsertCharacter(prev, character), { revalidate: false })
    return character
  }, [mutate])

  const create = useCallback(async (input: CharacterCreate) => put(await createCharacter(input)), [put])
  const update = useCallback(async (id: string, patch: CharacterPatch) => put(await updateCharacter(id, patch)), [put])
  const remove = useCallback(async (id: string) => {
    await deleteCharacter(id)
    await mutate((prev) => (prev ?? []).filter((c) => c.id !== id), { revalidate: false })
  }, [mutate])
  const uploadMedia = useCallback(async (id: string, file: File, kind: CharacterMediaKind, meta: CharacterMediaMeta = {}) => {
    const result = await uploadCharacterMedia(id, file, kind, meta)
    await put(result.character)
    return result
  }, [put])
  const removeMedia = useCallback(async (id: string, mediaId: string) => put(await deleteCharacterMedia(id, mediaId)), [put])
  const reorderMedia = useCallback(
    async (id: string, kind: CharacterMediaKind, ids: string[]) => put(await reorderCharacterMedia(id, kind, ids)),
    [put],
  )

  return {
    characters: data,
    error,
    isLoading: isLoading && !data,
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
  }
}
