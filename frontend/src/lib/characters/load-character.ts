/**
 * The Load Character block's saved config and the loader items it sends.
 * Pure: the block (`custom_blocks/load_character`) holds the state in
 * session keys and feeds the items to the shared loader core.
 *
 * - `character_id`: the chosen character, or null.
 * - `selection`: media ids per kind, arrays in send order (click order). A
 *   `voice` id saved by an older version is read as the last audio clip.
 * - `snapshot`: the character's name and the selected items as last seen, so a
 *   flow still shows what it used after the character or a file was deleted.
 */
import type { LoaderItem, LoaderKind } from '@/lib/byok/loader-items'
import { fileLabel } from '@/lib/byok/references'
import type { HealthTarget } from '@/lib/byok/reference-health'
import type { Resource } from '@/lib/resource'
import type { Character, CharacterMedia, CharacterMediaKind } from './types'
import { defaultAudio, defaultFace } from './use-characters'

export const LOAD_CHARACTER_KEYS = { characterId: 'character_id', selection: 'selection', snapshot: 'snapshot' } as const

export interface CharacterSelection {
  image: string[]
  video: string[]
  audio: string[]
}

export interface SnapshotItem {
  kind: CharacterMediaKind
  label: string
  local: string
  size_bytes?: number
  width?: number
  height?: number
  duration_s?: number
}

export interface CharacterSnapshot {
  name: string
  items: Record<string, SnapshotItem>
}

export const EMPTY_SELECTION: CharacterSelection = Object.freeze({ image: [], video: [], audio: [] }) as CharacterSelection
export const EMPTY_SNAPSHOT: CharacterSnapshot = Object.freeze({ name: '', items: {} }) as CharacterSnapshot

const KINDS: ReadonlySet<string> = new Set(['image', 'video', 'audio'])
/** Legacy: snapshot items saved before voice became audio. */
const LEGACY_KINDS: Readonly<Record<string, CharacterMediaKind>> = { voice: 'audio' }
const LIST_KINDS = ['image', 'video', 'audio'] as const
const NUMBER_FIELDS = ['size_bytes', 'width', 'height', 'duration_s'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function idList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const id of raw) if (typeof id === 'string' && id && !out.includes(id)) out.push(id)
  return out
}

// ---- Restoring saved config ----

/**
 * Where the chosen character stands: none chosen; the list still loading or
 * failed to load (the snapshot's name stands in, and nothing is treated as
 * deleted); live; or deleted (only a loaded list can say so).
 */
export type CharacterPresence =
  | { kind: 'none' }
  | { kind: 'loading'; name: string }
  | { kind: 'error'; name: string; message: string }
  | { kind: 'live'; character: Character }
  | { kind: 'deleted'; name: string }

export function characterPresence(characterId: string | null, list: Resource<readonly Character[]>, snapshotName: string): CharacterPresence {
  if (!characterId) return { kind: 'none' }
  if (list.kind === 'loading') return { kind: 'loading', name: snapshotName }
  if (list.kind === 'error') return { kind: 'error', name: snapshotName, message: list.message }
  const character = list.data.find((c) => c.id === characterId)
  return character ? { kind: 'live', character } : { kind: 'deleted', name: snapshotName }
}

export function restoreCharacterId(raw: unknown): string | null {
  return typeof raw === 'string' && raw ? raw : null
}

/**
 * The saved selection. A `voice` id (one clip, saved by an older version, in
 * a flow or an open tab) is appended after the audio, so it is still sent and
 * the audio keeps its numbering.
 */
export function restoreSelection(raw: unknown): CharacterSelection {
  if (!isRecord(raw)) return EMPTY_SELECTION
  const audio = idList(raw.audio)
  if (typeof raw.voice === 'string' && raw.voice && !audio.includes(raw.voice)) audio.push(raw.voice)
  return { image: idList(raw.image), video: idList(raw.video), audio }
}

function snapshotKind(raw: unknown): CharacterMediaKind | null {
  const kind = String(raw)
  return KINDS.has(kind) ? (kind as CharacterMediaKind) : LEGACY_KINDS[kind] ?? null
}

function restoreSnapshotItem(raw: unknown): SnapshotItem | null {
  const kind = isRecord(raw) ? snapshotKind(raw.kind) : null
  if (!isRecord(raw) || !kind) return null
  const local = typeof raw.local === 'string' ? raw.local.trim() : ''
  if (!local.startsWith('/outputs/')) return null
  const label = typeof raw.label === 'string' && raw.label ? raw.label : fileLabel(local) ?? local
  const item: SnapshotItem = { kind, label, local }
  for (const key of NUMBER_FIELDS) if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) item[key] = raw[key] as number
  return item
}

export function restoreSnapshot(raw: unknown): CharacterSnapshot {
  if (!isRecord(raw)) return EMPTY_SNAPSHOT
  const items: Record<string, SnapshotItem> = {}
  if (isRecord(raw.items)) {
    for (const [id, value] of Object.entries(raw.items)) {
      const item = restoreSnapshotItem(value)
      if (id && item) items[id] = item
    }
  }
  return { name: typeof raw.name === 'string' ? raw.name : '', items }
}

/**
 * True when saved config still has the voice shape of an older version (a
 * `selection.voice` key, or a snapshot item of kind `voice`), so the block
 * rewrites its session state once and a flow exported from it has no voice.
 */
export function hasLegacyVoice(selection: unknown, snapshot: unknown): boolean {
  if (isRecord(selection) && 'voice' in selection) return true
  return isRecord(snapshot) && isRecord(snapshot.items)
    && Object.values(snapshot.items).some((item) => isRecord(item) && item.kind === 'voice')
}

// ---- Selection ----

/** The selection a newly chosen character starts with: its default face and default audio clip. */
export function defaultSelection(character: Character): CharacterSelection {
  const face = defaultFace(character)
  const audio = defaultAudio(character)
  return { image: face ? [face.id] : [], video: [], audio: audio ? [audio.id] : [] }
}

/** Click on a file: append it to the send order, or remove it. */
export function toggleMedia(selection: CharacterSelection, kind: CharacterMediaKind, id: string): CharacterSelection {
  const list = selection[kind]
  return { ...selection, [kind]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] }
}

/** Deselect some ids of one kind ("Remove extras", "Remove" on a missing file). */
export function deselectMedia(selection: CharacterSelection, kind: CharacterMediaKind, ids: readonly string[]): CharacterSelection {
  return { ...selection, [kind]: selection[kind].filter((x) => !ids.includes(x)) }
}

/** Selected ids of one kind, in send order. */
export function selectedIds(selection: CharacterSelection, kind: CharacterMediaKind): string[] {
  return selection[kind]
}

export function selectedCount(selection: CharacterSelection): number {
  return LIST_KINDS.reduce((n, kind) => n + selection[kind].length, 0)
}

// ---- Snapshot and items ----

function snapshotOf(media: CharacterMedia): SnapshotItem {
  const item: SnapshotItem = { kind: media.kind, label: media.label, local: media.local }
  for (const key of NUMBER_FIELDS) {
    const value = media[key]
    if (typeof value === 'number' && Number.isFinite(value)) item[key] = value
  }
  return item
}

/**
 * The snapshot for the live character and selection: the character's name and
 * every selected item as now seen. A selected file the character no longer has
 * keeps its previous entry, so it can still be shown (as missing).
 */
export function buildSnapshot(character: Character, selection: CharacterSelection, previous: CharacterSnapshot): CharacterSnapshot {
  const items: Record<string, SnapshotItem> = {}
  for (const kind of LIST_KINDS) {
    for (const id of selectedIds(selection, kind)) {
      const live = character.media.find((m) => m.id === id && m.kind === kind)
      const kept = previous.items[id]
      if (live) items[id] = snapshotOf(live)
      else if (kept && kept.kind === kind) items[id] = kept
    }
  }
  return { name: character.name, items }
}

/**
 * The loader items of one kind for the selection, in send order. Each comes
 * from the live character when it has the file, otherwise from the snapshot
 * (a deleted file or character; the health check then marks it broken). An id
 * found in neither has nothing to show or send and is left out. Every item
 * carries the character's name.
 */
export function selectedItems(
  kind: LoaderKind,
  selection: CharacterSelection,
  character: Character | null,
  snapshot: CharacterSnapshot,
): LoaderItem[] {
  const name = character?.name ?? snapshot.name
  const out: LoaderItem[] = []
  for (const id of selectedIds(selection, kind)) {
    const live = character?.media.find((m) => m.id === id && m.kind === kind)
    const saved = snapshot.items[id]
    const source = live ? snapshotOf(live) : saved && saved.kind === kind ? saved : null
    if (!source) continue
    const item: LoaderItem = { id, label: source.label, local: source.local, status: 'ready' }
    for (const key of NUMBER_FIELDS) if (source[key] != null) item[key] = source[key]
    if (name) item.character = name
    out.push(item)
  }
  return out
}

/** A saved Load Character block's selected files, for the flow import's reference check. */
export function snapshotTargets(config: Record<string, unknown>): HealthTarget[] {
  const selection = restoreSelection(config[LOAD_CHARACTER_KEYS.selection])
  const snapshot = restoreSnapshot(config[LOAD_CHARACTER_KEYS.snapshot])
  const out: HealthTarget[] = []
  for (const kind of LIST_KINDS) {
    for (const id of selectedIds(selection, kind)) {
      const item = snapshot.items[id]
      if (item && item.kind === kind) out.push({ kind, local: item.local })
    }
  }
  return out
}
