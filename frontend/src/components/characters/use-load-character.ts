'use client'

/**
 * State of the Load Character block: the chosen character, the selected files
 * per kind (in send order) and the snapshot of what was last seen, all saved
 * in the block's session keys. Each kind's selected files go through the
 * shared loader core, so limits, flags, health and run blockers are the
 * loaders' own; the one difference (`skipUnsupported`) is that a kind the
 * downstream model does not take is not sent and does not block the run.
 */
import { useCallback, useEffect, useMemo } from 'react'
import { useLoaderItemsState, type LoaderItemsState } from '@/components/byok/use-media-loader'
import { kindSingular, type LoaderKind } from '@/lib/byok/loader-items'
import {
  EMPTY_SELECTION,
  EMPTY_SNAPSHOT,
  LOAD_CHARACTER_KEYS,
  hasLegacyVoice,
  buildSnapshot,
  defaultSelection,
  deselectMedia,
  restoreCharacterId,
  restoreSelection,
  restoreSnapshot,
  selectedItems,
  toggleMedia,
  type CharacterSelection,
} from '@/lib/characters/load-character'
import type { Character, CharacterMediaKind } from '@/lib/characters/types'
import { useCharacters } from '@/lib/characters/use-characters'
import type { BlockComponentProps } from '@/lib/pipeline/registry'
import { useRunBlockers } from '@/lib/pipeline/run-blockers'
import { useSessionState } from '@/lib/use-session-state'

export const NO_CHARACTER_MESSAGE = 'Choose a character before running this block.'
export const NOTHING_SELECTED_MESSAGE = 'Select at least one reference before running this block.'

export function deletedCharacterBlocker(name: string): string {
  return name ? `uses the deleted character "${name}"` : 'uses a deleted character'
}

/** `"Mia" was deleted.`, shown in the block. */
export function deletedMessage(name: string): string {
  return name ? `"${name}" was deleted.` : 'This character was deleted.'
}

export interface CharacterKindState extends LoaderItemsState {
  /** Deselect the items flagged over the limit. */
  removeExtras: () => void
  /** Deselect one item (a broken or missing file). */
  deselect: (id: string) => void
  toggle: (id: string) => void
}

export function useLoadCharacter(props: BlockComponentProps) {
  const { blockId, setOutput, registerExecute, setStatusMessage } = props
  const key = (name: string) => `block_${blockId}_${name}`
  const [rawId, setRawId] = useSessionState<unknown>(key(LOAD_CHARACTER_KEYS.characterId), null)
  const [rawSelection, setRawSelection] = useSessionState<unknown>(key(LOAD_CHARACTER_KEYS.selection), EMPTY_SELECTION)
  const [rawSnapshot, setRawSnapshot] = useSessionState<unknown>(key(LOAD_CHARACTER_KEYS.snapshot), EMPTY_SNAPSHOT)
  const characterId = restoreCharacterId(rawId)
  const selection = useMemo(() => restoreSelection(rawSelection), [rawSelection])
  const snapshot = useMemo(() => restoreSnapshot(rawSnapshot), [rawSnapshot])

  // An open tab saved before voice became audio: rewrite its session state once (the restore already reads it as audio).
  useEffect(() => {
    if (!hasLegacyVoice(rawSelection, rawSnapshot)) return
    setRawSelection(selection)
    setRawSnapshot(snapshot)
  }, [rawSelection, rawSnapshot, selection, snapshot, setRawSelection, setRawSnapshot])

  const list = useCharacters()
  const { characters } = list
  const character = useMemo(
    () => (characterId && characters ? characters.find((c) => c.id === characterId) ?? null : null),
    [characterId, characters],
  )
  // Only a loaded list can say the character is gone; while loading or after a failed load the snapshot stands in.
  const deleted = Boolean(characterId && characters && !character)
  const name = character?.name ?? snapshot.name

  // Keep the snapshot in step with the live character and selection.
  useEffect(() => {
    if (!character) return
    const next = buildSnapshot(character, selection, snapshot)
    if (JSON.stringify(next) !== JSON.stringify(snapshot)) setRawSnapshot(next)
  }, [character, selection, snapshot, setRawSnapshot])

  /** Choose a character: a new one starts from its default face and default audio clip. Re-choosing the same one keeps the selection. */
  const choose = useCallback((id: string) => {
    if (id === characterId) return
    const next = characters?.find((c) => c.id === id)
    if (!next) return
    const initial = defaultSelection(next)
    setRawId(id)
    setRawSelection(initial)
    setRawSnapshot(buildSnapshot(next, initial, EMPTY_SNAPSHOT))
  }, [characterId, characters, setRawId, setRawSelection, setRawSnapshot])

  const edit = useCallback((fn: (prev: CharacterSelection) => CharacterSelection) => {
    setRawSelection((prev: unknown) => fn(restoreSelection(prev)))
  }, [setRawSelection])

  const image = useKind(blockId, setOutput, 'image', selection, character, snapshot, edit)
  const video = useKind(blockId, setOutput, 'video', selection, character, snapshot, edit)
  const audio = useKind(blockId, setOutput, 'audio', selection, character, snapshot, edit)
  const kinds = [image, video, audio]

  const blockers = [...(deleted ? [deletedCharacterBlocker(snapshot.name)] : []), ...kinds.flatMap((k) => k.blockers)]
  useRunBlockers(blockId, blockers)

  useEffect(() => {
    // Nothing here waits on the network: the files are already local, so there is no signal to honour.
    registerExecute(async () => {
      if (!characterId) throw new Error(NO_CHARACTER_MESSAGE)
      if (deleted) throw new Error(`${deletedMessage(snapshot.name)} Choose another character.`)
      if (kinds.every((k) => k.skipped || k.items.length === 0)) throw new Error(NOTHING_SELECTED_MESSAGE)
      const counts: string[] = []
      for (const kind of kinds) {
        const count = await kind.prepareRun()
        if (count > 0) counts.push(`${count} ${count === 1 ? kindSingular(kind.kind) : kind.plural}`)
      }
      setStatusMessage(`${counts.join(', ')} ready`)
    })
  })

  return {
    ...list,
    characterId,
    character,
    deleted,
    name,
    snapshot,
    selection,
    choose,
    image,
    video,
    audio,
  }
}

function useKind(
  blockId: string,
  setOutput: BlockComponentProps['setOutput'],
  kind: LoaderKind & CharacterMediaKind,
  selection: CharacterSelection,
  character: Character | null,
  snapshot: ReturnType<typeof restoreSnapshot>,
  edit: (fn: (prev: CharacterSelection) => CharacterSelection) => void,
): CharacterKindState {
  const items = useMemo(() => selectedItems(kind, selection, character, snapshot), [kind, selection, character, snapshot])
  const core = useLoaderItemsState(blockId, setOutput, { kind, port: kind, items, skipUnsupported: true })
  const over = core.rows.filter((r) => r.flag.status === 'over_limit').map((r) => r.item.id)
  const overKey = over.join('\u0000')
  const removeExtras = useCallback(() => {
    const ids = overKey ? overKey.split('\u0000') : []
    edit((prev) => deselectMedia(prev, kind, ids))
  }, [edit, kind, overKey])
  const deselect = useCallback((id: string) => edit((prev) => deselectMedia(prev, kind, [id])), [edit, kind])
  const toggle = useCallback((id: string) => edit((prev) => toggleMedia(prev, kind, id)), [edit, kind])
  return { ...core, removeExtras, deselect, toggle }
}

export type LoadCharacterState = ReturnType<typeof useLoadCharacter>
