'use client'

/**
 * State shared by the loader blocks (Image Loader, Video Loader, Omni
 * Reference Loader). `useLoaderList` holds one ordered list of one media kind,
 * saved under its own config key and emitted on its own output port.
 * `useLoaderBlock` registers the block's execute function and run blockers
 * for all of its lists, and reports the fullest list to the card, which sets
 * the block's width from it.
 *
 * Files are saved to the local output folder through a `/save-local` route and
 * nothing is published on load; the generation service uploads the local file
 * to the provider at run time.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { directBackendUrl } from '@/lib/backend-url'
import { postFile } from '@/lib/post-file'
import { useSessionState } from '@/lib/use-session-state'
import type { BlockComponentProps } from '@/lib/pipeline/registry'
import { useRunBlockers } from '@/lib/pipeline/run-blockers'
import { useMediaItemCount } from '@/lib/pipeline/use-media-item-count'
import { kindPlural } from '@/lib/byok/check-references'
import { limitSource, strictestLimit } from '@/lib/byok/downstream-limits'
import {
  checkCandidates,
  flagItems,
  itemsToOutput,
  kindSingular,
  moveItem as moveInList,
  removeExtras as removeExtrasFromList,
  restoreLoaderItems,
  type ItemFlag,
  type LoaderCandidate,
  type LoaderItem,
  type LoaderKind,
} from '@/lib/byok/loader-items'
import { probeMedia } from '@/lib/byok/probe-media'
import { HEALTH_LABEL, isBrokenStatus, type ReferenceHealth } from '@/lib/byok/reference-health'
import { fileLabel } from '@/lib/byok/references'
import { useDownstreamLimits } from '@/lib/byok/use-downstream-limits'
import { useReferenceHealth } from '@/lib/byok/use-reference-health'

export const IMAGE_SAVE_ENDPOINT = '/api/blocks/upload_image_to_tmpfiles/save-local'
/** Videos and audio can be large; they go straight to FastAPI rather than through the Next proxy. */
export const VIDEO_SAVE_ENDPOINT = directBackendUrl('/api/blocks/video_loader/save-local')

export interface LoaderListOptions {
  kind: LoaderKind
  /** Config key the list is saved under (`items` for single-kind loaders). */
  configKey: string
  /** Output port the refs go to. */
  port: string
  /** `/api/blocks/<slug>/save-local`. */
  saveEndpoint: string
  /** Field of the save response holding the `/outputs/...` path. */
  responseField: 'image_url' | 'video_url'
  /** Items from older session keys, used when the list has never been saved. */
  legacyItems?: () => LoaderItem[]
  /**
   * A retired config key of the same block (the Omni Reference Loader's
   * `voice_items`): on first mount its session items are appended after this
   * list's, without duplicate ids, and the key is removed. For open tabs
   * restored from session storage; saved flows are rewritten by the flow
   * migration instead.
   */
  absorbConfigKey?: string
  /** Optional re-encode before saving (the image loader shrinks very large images). */
  prepare?: (file: File) => Promise<File>
  /** Emit one ref as a bare object instead of a one-item list (the image loader's contract). */
  emitSingleAsObject?: boolean
}

export interface LoaderRow {
  item: LoaderItem
  flag: ItemFlag
  health: ReferenceHealth | undefined
  broken: boolean
  /** "First frame" / "Last frame" when the list feeds Image to Video. */
  role: string | null
}

const ROLE_NAMES = ['First frame', 'Last frame'] as const

function newItemId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)
  return `item-${random}`
}

/** Read and remove a retired session key; its items, or [] when it is unset or unreadable. */
function takeSessionItems(key: string): LoaderItem[] {
  try {
    const raw = sessionStorage.getItem(key)
    if (raw === null) return []
    sessionStorage.removeItem(key)
    return restoreLoaderItems(JSON.parse(raw))
  } catch {
    return []
  }
}

export interface LoaderItemsStateOptions {
  kind: LoaderKind
  /** Output port the refs go to. */
  port: string
  /** The items, in send order. The caller owns them (a loader's saved list, or a character's selected files). */
  items: readonly LoaderItem[]
  /** Emit one ref as a bare object instead of a one-item list (the image loader's contract). */
  emitSingleAsObject?: boolean
  /**
   * When the strictest consumer takes no items of this kind, send nothing and
   * do not block the run (the items are kept). Off for the loaders, which
   * block instead; on for the Load Character block, whose default audio clip
   * is pre-selected and would otherwise block every model that takes no audio.
   */
  skipUnsupported?: boolean
  /** The latest items at run time, when they can change between renders (saves finishing mid-run). */
  latest?: () => readonly LoaderItem[]
  /** Called by `prepareRun` before it reads `latest`, to wait for pending saves. */
  beforeRun?: () => Promise<void>
}

/**
 * Limits, flags, health, output and run blockers for one ordered list of one
 * media kind. Shared by the loaders (`useLoaderList`) and the Load Character
 * block, so both apply the same limits and use the same messages.
 */
export function useLoaderItemsState(blockId: string, setOutput: BlockComponentProps['setOutput'], options: LoaderItemsStateOptions) {
  const { kind, port, items, emitSingleAsObject, skipUnsupported, latest, beforeRun } = options
  const plural = kindPlural(kind)

  const limits = useDownstreamLimits(blockId, kind)
  const strictest = strictestLimit(limits.consumers)
  const skipped = Boolean(skipUnsupported && strictest && !strictest.accepted)
  const flags = useMemo(() => flagItems(kind, items, limits.consumers), [kind, items, limits.consumers])

  const targets = useMemo(
    () => items.filter((i) => i.status === 'ready' && (i.local || i.url)).map((i) => ({ kind, local: i.local, url: i.url })),
    [items, kind],
  )
  const health = useReferenceHealth(targets)
  const frameSlots = limits.consumers.find((c) => c.frameSlots !== null)?.frameSlots ?? null
  const rows: LoaderRow[] = items.map((item, i) => {
    const result = item.status === 'ready' ? health.get(item) : undefined
    return {
      item,
      flag: flags[i],
      health: result,
      broken: isBrokenStatus(result?.status),
      role: frameSlots !== null && i < frameSlots ? ROLE_NAMES[i] : null,
    }
  })

  // ---- Output ----
  const emit = useCallback((list: readonly LoaderItem[]) => {
    const refs = skipped ? [] : itemsToOutput(kind, list)
    if (refs.length === 0) setOutput(port, undefined)
    else setOutput(port, emitSingleAsObject && refs.length === 1 ? refs[0] : refs)
    return refs.length
  }, [kind, port, emitSingleAsObject, setOutput, skipped])

  useEffect(() => {
    emit(items)
  }, [items, emit])

  // ---- Problems that would fail the run ----
  const blockers: string[] = []
  if (!skipped) {
    const brokenRows = rows.filter((r) => r.broken)
    if (brokenRows.length > 0) {
      const names = brokenRows.map((r) => `${r.item.label} (${HEALTH_LABEL[r.health!.status]})`).join(', ')
      blockers.push(`has ${brokenRows.length === 1 ? 'a broken reference' : `${brokenRows.length} broken references`}: ${names}`)
    }
    const failed = rows.filter((r) => r.item.status === 'error')
    if (failed.length > 0) blockers.push(`could not save ${failed.map((r) => r.item.label).join(', ')}`)
    if (strictest && items.length > 0) {
      if (!strictest.accepted) {
        blockers.push(`holds ${items.length} ${items.length === 1 ? kindSingular(kind) : plural}, but ${limitSource(strictest)} does not take ${plural}`)
      } else if (items.length > strictest.maxCount) {
        blockers.push(`holds ${items.length} ${plural}; ${limitSource(strictest)} takes up to ${strictest.maxCount}`)
      }
    }
    for (const row of rows) {
      if (row.flag.status === 'incompatible' || (row.flag.status === 'over_limit' && items.length <= (strictest?.maxCount ?? Infinity))) {
        blockers.push(`${row.item.label}: ${row.flag.reason}`)
      }
    }
  }

  /** Wait for saves, refuse broken or unsaved items, emit, and return how many items were sent. */
  const prepareRun = useCallback(async () => {
    if (beforeRun) await beforeRun()
    const current = latest ? latest() : items
    if (skipped) return emit(current)
    const failedItem = current.find((i) => i.status === 'error')
    if (failedItem) throw new Error(`${failedItem.label}: ${failedItem.error ?? 'could not be saved.'} Replace or remove it.`)
    const broken = current.find((i) => isBrokenStatus(health.get(i)?.status))
    if (broken) {
      const result = health.get(broken)!
      throw new Error(`${broken.label}: ${result.detail || HEALTH_LABEL[result.status]} Replace or remove it.`)
    }
    return emit(current)
  }, [beforeRun, latest, items, skipped, emit, health])

  return {
    kind,
    plural,
    items,
    rows,
    limits,
    strictest,
    /** True when `skipUnsupported` is on and the strictest consumer takes none of this kind: nothing is sent. */
    skipped,
    health,
    blockers,
    prepareRun,
  }
}

export type LoaderItemsState = ReturnType<typeof useLoaderItemsState>

export function useLoaderList(blockId: string, setOutput: BlockComponentProps['setOutput'], options: LoaderListOptions) {
  const { kind, configKey, port, saveEndpoint, responseField, prepare, emitSingleAsObject, absorbConfigKey } = options

  const [legacyDefault] = useState<LoaderItem[]>(() => options.legacyItems?.() ?? [])
  const [rawItems, setRawItems] = useSessionState<unknown>(`block_${blockId}_${configKey}`, legacyDefault)
  const items = useMemo(() => restoreLoaderItems(rawItems), [rawItems])
  // Synchronous mirror so saves that finish mid-run are seen by execute.
  const itemsRef = useRef<LoaderItem[]>(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])
  const inFlight = useRef(new Map<string, Promise<void>>())
  const [addMessages, setAddMessages] = useState<string[]>([])

  const update = useCallback((fn: (prev: LoaderItem[]) => LoaderItem[]) => {
    const next = fn(itemsRef.current)
    itemsRef.current = next
    setRawItems(next)
  }, [setRawItems])

  // Fold a retired list of this block into this one, once (see `absorbConfigKey`).
  useEffect(() => {
    if (!absorbConfigKey) return
    const absorbed = takeSessionItems(`block_${blockId}_${absorbConfigKey}`)
    if (absorbed.length === 0) return
    update((prev) => [...prev, ...absorbed.filter((a) => !prev.some((p) => p.id === a.id))])
  }, [absorbConfigKey, blockId, update])

  const latest = useCallback(() => itemsRef.current, [])
  const beforeRun = useCallback(async () => {
    if (inFlight.current.size > 0) await Promise.allSettled([...inFlight.current.values()])
  }, [])
  const core = useLoaderItemsState(blockId, setOutput, { kind, port, items, emitSingleAsObject, latest, beforeRun })
  const { limits } = core

  // ---- Adding, replacing ----
  const save = useCallback((id: string, file: File, meta: Partial<LoaderItem>) => {
    const task = (async () => {
      try {
        const body = await postFile(saveEndpoint, file)
        const path = typeof body[responseField] === 'string' ? String(body[responseField]).trim() : ''
        if (!body.ok || !path) throw new Error(body.error || 'The file could not be saved.')
        update((prev) => prev.map((i) => (i.id === id ? { ...i, ...meta, local: path, url: undefined, status: 'ready', error: undefined } : i)))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        update((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'error', error: `Could not save the file: ${message}` } : i)))
      } finally {
        inFlight.current.delete(id)
      }
    })()
    inFlight.current.set(id, task)
    return task
  }, [saveEndpoint, responseField, update])

  const consider = useCallback(async (files: File[], replacingId?: string) => {
    const prepared = await Promise.all(files.map((f) => (prepare ? prepare(f).catch(() => f) : Promise.resolve(f))))
    const probes = await Promise.all(prepared.map((f) => probeMedia(f, kind)))
    const candidates: LoaderCandidate[] = prepared.map((f, i) => ({ name: f.name, type: f.type, size_bytes: f.size, ...probes[i] }))
    const result = checkCandidates(kind, itemsRef.current, candidates, limits.consumers, replacingId)
    setAddMessages(result.messages)
    return result.accepted.map((index) => ({ file: prepared[index], candidate: candidates[index] }))
  }, [prepare, kind, limits.consumers])

  const metaOf = useCallback((file: File, candidate: LoaderCandidate): Partial<LoaderItem> => ({
    label: file.name,
    size_bytes: file.size,
    ...(candidate.width != null ? { width: candidate.width } : {}),
    ...(candidate.height != null ? { height: candidate.height } : {}),
    ...(candidate.duration_s != null ? { duration_s: candidate.duration_s } : {}),
  }), [])

  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    const accepted = await consider(files)
    if (accepted.length === 0) return
    const added: LoaderItem[] = accepted.map(({ file, candidate }) => ({
      id: newItemId(),
      ...metaOf(file, candidate),
      label: file.name,
      status: 'saving' as const,
    }))
    update((prev) => [...prev, ...added])
    await Promise.all(accepted.map(({ file, candidate }, i) => save(added[i].id, file, metaOf(file, candidate))))
  }, [consider, save, update, metaOf])

  /** Swap the file of an item; its id and position stay. */
  const replaceItem = useCallback(async (id: string, file: File) => {
    const accepted = await consider([file], id)
    if (accepted.length === 0) return
    const { candidate } = accepted[0]
    update((prev) => prev.map((i) => (i.id === id
      ? { id, label: file.name, status: 'saving', ...metaOf(file, candidate) }
      : i)))
    await save(id, file, metaOf(file, candidate))
  }, [consider, save, update, metaOf])

  /** Add a file that is already in the output folder (an earlier generation). */
  const addSaved = useCallback((local: string) => {
    const name = fileLabel(local) ?? local
    const result = checkCandidates(kind, itemsRef.current, [{ name, type: '' }], limits.consumers)
    setAddMessages(result.messages)
    if (result.accepted.length === 0) return false
    update((prev) => [...prev, { id: newItemId(), label: name, local, status: 'ready' }])
    return true
  }, [kind, limits.consumers, update])

  const removeItem = useCallback((id: string) => update((prev) => prev.filter((i) => i.id !== id)), [update])
  const moveItem = useCallback((id: string, delta: -1 | 1) => update((prev) => moveInList(prev, id, delta)), [update])
  const removeExtras = useCallback(() => {
    update((prev) => removeExtrasFromList(prev, flagItems(kind, prev, limits.consumers)))
  }, [kind, limits.consumers, update])

  return {
    ...core,
    addMessages,
    dismissAddMessages: () => setAddMessages([]),
    addFiles,
    addSaved,
    replaceItem,
    removeItem,
    moveItem,
    removeExtras,
    hasSaving: () => inFlight.current.size > 0,
  }
}

export type LoaderListState = ReturnType<typeof useLoaderList>

/** Execute, run blockers and the card width for a loader block made of one or more lists. */
export function useLoaderBlock(props: BlockComponentProps, lists: readonly LoaderListState[], emptyMessage: string) {
  const { blockId, registerExecute, setStatusMessage } = props
  useRunBlockers(blockId, lists.flatMap((l) => l.blockers))
  useMediaItemCount(props.setMediaItemCount, lists.map((l) => l.items.length))
  useEffect(() => {
    registerExecute(async () => {
      if (lists.some((l) => l.hasSaving())) setStatusMessage('Saving files…')
      if (lists.every((l) => l.items.length === 0)) throw new Error(emptyMessage)
      const counts = []
      for (const list of lists) {
        const count = await list.prepareRun()
        if (count > 0) counts.push(`${count} ${count === 1 ? kindSingular(list.kind) : list.plural}`)
      }
      setStatusMessage(`${counts.join(', ')} ready`)
    })
  })
}
