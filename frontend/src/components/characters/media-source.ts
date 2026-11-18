'use client'

/**
 * Where the media tiles of a character get their files from, so the creation
 * wizard (files staged in memory until "Create character") and a saved
 * character (every change hits the API at once) share one tile UI.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MediaProbe } from '@/lib/byok/probe-media'
import { mediaOfKind, type CharactersState } from '@/lib/characters/use-characters'
import type { Character, CharacterMediaKind } from '@/lib/characters/types'

export interface SourceItem {
  id: string
  kind: CharacterMediaKind
  /** The file name. */
  label: string
  /** Playable URL: a `/outputs/...` path or an object URL. */
  src: string
  sizeBytes: number | null
  durationS: number | null
}

export interface MediaSource {
  /** The items of one kind, in order. */
  items: (kind: CharacterMediaKind) => SourceItem[]
  /** The face (image) or the default audio clip (audio); null for videos or when none is set. */
  defaultId: (kind: CharacterMediaKind) => string | null
  /** Add one file already checked to be of `kind`, with its probed metadata. Rejects with a readable message. */
  add: (kind: CharacterMediaKind, file: File, meta: MediaProbe) => Promise<unknown>
  remove: (item: SourceItem) => Promise<unknown>
  /** `ids` is the whole new order of that kind. */
  reorder: (kind: CharacterMediaKind, ids: string[]) => Promise<unknown>
  setDefault: (kind: 'image' | 'audio', id: string | null) => Promise<unknown>
  /** Why this item cannot be removed (its tooltip), or null when it can. */
  removeBlocked: (item: SourceItem) => string | null
}

export const NEEDS_FACE_TIP = 'A character needs a face'

export type CharacterMediaActions = Pick<CharactersState, 'update' | 'uploadMedia' | 'removeMedia' | 'reorderMedia'>

// ---- Live: a saved character ----

export function liveMediaSource(character: Character, actions: CharacterMediaActions): MediaSource {
  const { id } = character
  return {
    items: (kind) => mediaOfKind(character, kind).map((m) => ({
      id: m.id, kind: m.kind, label: m.label, src: m.local, sizeBytes: m.size_bytes, durationS: m.duration_s,
    })),
    defaultId: (kind) => (kind === 'image' ? character.default_face_id : kind === 'audio' ? character.default_audio_id : null),
    add: (kind, file, meta) => actions.uploadMedia(id, file, kind, meta),
    remove: (item) => actions.removeMedia(id, item.id),
    reorder: (kind, ids) => actions.reorderMedia(id, kind, ids),
    setDefault: (kind, mediaId) => actions.update(id, kind === 'image' ? { default_face_id: mediaId } : { default_audio_id: mediaId }),
    removeBlocked: (item) => (item.kind === 'image' && mediaOfKind(character, 'image').length <= 1 ? NEEDS_FACE_TIP : null),
  }
}

export function useLiveMediaSource(character: Character, actions: CharacterMediaActions): MediaSource {
  return useMemo(() => liveMediaSource(character, actions), [character, actions])
}

// ---- Staged: files held in memory by the creation wizard ----

export interface StagedFile extends SourceItem {
  file: File
  meta: MediaProbe
}

let stagedSeq = 0

function trackUrl(urls: Set<string>, f: StagedFile): StagedFile {
  urls.add(f.src)
  return f
}

/** Revoke once: setState updaters may run twice in development. */
function revokeUrl(urls: Set<string>, f: StagedFile | null | undefined): void {
  if (!f || !urls.has(f.src)) return
  urls.delete(f.src)
  URL.revokeObjectURL(f.src)
}

export function stageFile(kind: CharacterMediaKind, file: File, meta: MediaProbe): StagedFile {
  return {
    id: `staged-${++stagedSeq}`,
    kind,
    label: file.name,
    src: URL.createObjectURL(file),
    sizeBytes: file.size,
    durationS: typeof meta.duration_s === 'number' ? meta.duration_s : null,
    file,
    meta,
  }
}

type StagedByKind = Record<CharacterMediaKind, StagedFile[]>
const EMPTY: StagedByKind = { image: [], video: [], audio: [] }

export interface StagedMedia {
  /** The face image, shown first among the images and never removable from the looks. */
  face: StagedFile | null
  setFace: (file: File, meta: MediaProbe) => void
  /** The other files by kind, in order (images exclude the face). */
  files: StagedByKind
  /** The audio clip the user starred, or null for the first clip. */
  starredAudioId: string | null
  /** The audio clip that will be the default: the starred one, else the first. */
  defaultAudioId: string | null
  source: MediaSource
  /** True when there is a face or any file. */
  hasFiles: boolean
  /** Drop every staged file and revoke its preview URL. */
  clear: () => void
}

/**
 * Files staged for a new character. Each has an object-URL preview that is
 * revoked when the file is removed, replaced, cleared, or the owner unmounts.
 */
export function useStagedMedia(): StagedMedia {
  const [face, setFaceState] = useState<StagedFile | null>(null)
  const [files, setFiles] = useState<StagedByKind>(EMPTY)
  const [starredAudioId, setStarredAudioId] = useState<string | null>(null)

  // Every preview URL handed out and not yet revoked, so unmount can revoke them.
  const live = useRef(new Set<string>())
  const track = (f: StagedFile) => trackUrl(live.current, f)
  const revoke = (f: StagedFile | null | undefined) => revokeUrl(live.current, f)
  useEffect(() => {
    const urls = live.current
    return () => {
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
    }
  }, [])

  const setFace = useCallback((file: File, meta: MediaProbe) => {
    const next = track(stageFile('image', file, meta))
    setFaceState((prev) => {
      revoke(prev)
      return next
    })
  }, [])

  const clear = useCallback(() => {
    for (const url of live.current) URL.revokeObjectURL(url)
    live.current.clear()
    setFaceState(null)
    setFiles(EMPTY)
    setStarredAudioId(null)
  }, [])

  const defaultAudioId = (starredAudioId && files.audio.some((a) => a.id === starredAudioId) ? starredAudioId : files.audio[0]?.id) ?? null

  const source = useMemo<MediaSource>(() => ({
    items: (kind) => (kind === 'image' && face ? [face, ...files.image] : files[kind]),
    defaultId: (kind) => (kind === 'image' ? face?.id ?? null : kind === 'audio' ? defaultAudioId : null),
    add: async (kind, file, meta) => {
      const staged = track(stageFile(kind, file, meta))
      setFiles((prev) => ({ ...prev, [kind]: [...prev[kind], staged] }))
    },
    remove: async (item) => {
      setFiles((prev) => {
        revoke(prev[item.kind].find((f) => f.id === item.id))
        return { ...prev, [item.kind]: prev[item.kind].filter((f) => f.id !== item.id) }
      })
    },
    reorder: async (kind, ids) => {
      setFiles((prev) => {
        const byId = new Map(prev[kind].map((f) => [f.id, f]))
        const ordered = ids.map((id) => byId.get(id)).filter((f): f is StagedFile => !!f)
        return ordered.length === prev[kind].length ? { ...prev, [kind]: ordered } : prev
      })
    },
    setDefault: async (kind, id) => {
      if (kind === 'audio') setStarredAudioId(id)
    },
    removeBlocked: () => null,
  }), [face, files, defaultAudioId])

  const hasFiles = !!face || Object.values(files).some((list) => list.length > 0)

  return { face, setFace, files, starredAudioId, defaultAudioId, source, hasFiles, clear }
}
