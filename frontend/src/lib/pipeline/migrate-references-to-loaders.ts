/**
 * Flow schema 4 to 5: references saved inside a generation block (its
 * `references` config) move into a loader block inserted directly upstream of
 * it, so nothing saved is lost when generation blocks stop holding references.
 *
 * - Image to Video and Image to Image get an Image Loader (`items`).
 * - Omni Reference to Video gets an Omni Reference Loader, one list per kind.
 *   Voice references (schema 5 still had them) are audio: they go into the
 *   audio list after the audio references, without their speaker name.
 *
 * Inserting a block shifts the depth-first global index of every later block,
 * so every `sources` / `source_selections` index in the flow is renumbered.
 * The generation block keeps reading what it read before plus the new loader,
 * upstream first, as its references were combined before:
 *
 * - `all`: unchanged (the loader is the closest producer, so it comes last).
 * - `custom`: the loader is appended to the selection.
 * - `closest` with an explicit source, or with an upstream producer of that
 *   kind: becomes `custom` with [that producer, loader].
 * - `closest` with no producer: unchanged; it now reads the loader.
 *
 * Pure: returns new objects and never mutates its input.
 */
import { generationBlockConfig } from '@/lib/byok/generation-blocks'
import { LOADER_CONFIG_KEY, OMNI_LOADER_KEYS, type LoaderItem } from '@/lib/byok/loader-items'
import { restoreReferences, type GenerationReference } from '@/lib/byok/references'
import type { MediaKind } from '@/lib/byok/types'
import type { SavedBlock, SavedFlow } from './flow-io'
import { voicesMovedMessage } from './migrate-voice-to-audio'

export type OutputKinds = (type: string) => readonly string[]

const IMAGE_LOADER = 'uploadImageToTmpfiles'
const OMNI_LOADER = 'omniReferenceLoader'
const LOADER_LABEL: Record<string, string> = { [IMAGE_LOADER]: 'Image Loader', [OMNI_LOADER]: 'Omni Reference Loader' }
const BLOCK_LABEL: Record<string, string> = {
  imageToVideo: 'Image to Video',
  imageToImage: 'Image to Image',
  omniReferenceToVideo: 'Omni Reference to Video',
}

function toItem(ref: GenerationReference): LoaderItem {
  const item: LoaderItem = { id: ref.id, label: ref.label ?? ref.id, status: ref.status === 'error' ? 'error' : 'ready' }
  if (ref.local) item.local = ref.local
  if (ref.url) item.url = ref.url
  for (const key of ['size_bytes', 'width', 'height', 'duration_s'] as const) if (ref[key] != null) item[key] = ref[key]
  if (ref.format) item.format = ref.format
  if (ref.error) item.error = ref.error
  return item
}

interface Plan {
  loader: SavedBlock
  kinds: MediaKind[]
  count: number
  /** Saved voice references, now audio clips. */
  voices: number
}

function isVoiceRow(row: unknown): boolean {
  return Boolean(row) && typeof row === 'object' && (row as { kind?: unknown }).kind === 'voice'
}

/** The loader to insert for a block, or null when it holds no references to move. */
function planFor(block: SavedBlock): Plan | null {
  const config = generationBlockConfig(block.type)
  if (!config || config.referenceKinds.length === 0 || !block.config || !('references' in block.config)) return null
  // Voice rows go last so the audio keeps its numbering; restoring reads them as audio.
  const raw = Array.isArray(block.config.references) ? block.config.references : []
  const voices = raw.filter(isVoiceRow).length
  const refs = restoreReferences([...raw.filter((r) => !isVoiceRow(r)), ...raw.filter(isVoiceRow)])
  if (refs.length === 0) return null
  const kinds = [...new Set(refs.map((r) => r.kind))]
  let loader: SavedBlock
  if (config.mode === 'omni_reference_to_video') {
    const lists: Record<string, LoaderItem[]> = {}
    for (const kind of ['video', 'image', 'audio'] as const) {
      lists[OMNI_LOADER_KEYS[kind]] = refs.filter((r) => r.kind === kind).map(toItem)
    }
    loader = { type: OMNI_LOADER, config: lists }
  } else {
    loader = { type: IMAGE_LOADER, config: { [LOADER_CONFIG_KEY]: refs.filter((r) => r.kind === 'image').map(toItem) } }
  }
  if (block.disabled) loader.disabled = true
  return { loader, kinds, count: refs.length, voices: config.mode === 'omni_reference_to_video' ? voices : 0 }
}

/** The loader block (type and config) holding `refs` for a generation block of `blockType`, or null. */
export function loaderForReferences(blockType: string, refs: unknown): SavedBlock | null {
  return planFor({ type: blockType, config: { references: refs } })?.loader ?? null
}

function withoutReferences(block: SavedBlock): SavedBlock {
  if (!block.config || !('references' in block.config)) return block
  if (!generationBlockConfig(block.type)?.referenceKinds.length) return block
  const config = { ...block.config }
  delete config.references
  return { ...block, config }
}

export function migrateReferencesToLoaders(flow: SavedFlow, outputKinds: OutputKinds, warnings?: string[]): SavedFlow {
  // 1. Old depth-first order and each block's ancestors (as the runner sees them).
  const oldOrder: SavedBlock[] = []
  const ancestorsOf = new Map<SavedBlock, SavedBlock[]>()
  const walk = (chain: SavedBlock[], prefix: SavedBlock[]) => {
    chain.forEach((block, i) => {
      const ancestors = [...prefix, ...chain.slice(0, i)]
      ancestorsOf.set(block, ancestors)
      oldOrder.push(block)
      for (const branch of block.branches ?? []) walk(branch, [...ancestors, block])
    })
  }
  walk(flow.blocks, [])

  // 2. New tree with loaders inserted.
  const copyOf = new Map<SavedBlock, SavedBlock>()
  const plans = new Map<SavedBlock, Plan>()
  const build = (chain: SavedBlock[]): SavedBlock[] => {
    const out: SavedBlock[] = []
    for (const block of chain) {
      const plan = planFor(block)
      const copy: SavedBlock = { ...withoutReferences(block) }
      if (block.branches) copy.branches = block.branches.map(build)
      if (plan) {
        out.push(plan.loader)
        plans.set(block, plan)
      }
      copyOf.set(block, copy)
      out.push(copy)
    }
    return out
  }
  const blocks = build(flow.blocks)
  if (plans.size === 0) {
    // Nothing to insert; only strip empty reference lists.
    return { ...flow, blocks }
  }

  // 3. New indices and the old-to-new map.
  const newIndex = new Map<SavedBlock, number>()
  let counter = 0
  const number = (chain: SavedBlock[]) => {
    for (const block of chain) {
      newIndex.set(block, counter++)
      for (const branch of block.branches ?? []) number(branch)
    }
  }
  number(blocks)
  const remap = (oldIdx: number): number | undefined => {
    const old = oldOrder[oldIdx]
    return old ? newIndex.get(copyOf.get(old)!) : undefined
  }

  // 4. Renumber every source in the flow.
  for (const old of oldOrder) {
    const copy = copyOf.get(old)!
    if (old.sources) {
      const sources: Record<string, number> = {}
      for (const [port, idx] of Object.entries(old.sources)) {
        const mapped = remap(idx)
        if (mapped !== undefined) sources[port] = mapped
      }
      copy.sources = sources
    }
    if (old.source_selections) {
      const selections: Record<string, number[]> = {}
      for (const [port, list] of Object.entries(old.source_selections)) {
        selections[port] = list.map(remap).filter((n): n is number => n !== undefined)
      }
      copy.source_selections = selections
    }
  }

  // 5. Each generation block keeps its old inputs and gains its loader.
  for (const [old, plan] of plans) {
    const copy = copyOf.get(old)!
    const loaderIdx = newIndex.get(plan.loader)!
    const ancestors = ancestorsOf.get(old) ?? []
    for (const kind of plan.kinds) {
      const port = kind
      const mode = old.source_modes?.[port] ?? 'closest'
      if (mode === 'all') continue
      if (mode === 'custom') {
        copy.source_selections = { ...copy.source_selections, [port]: [...(copy.source_selections?.[port] ?? []), loaderIdx] }
        continue
      }
      const explicit = copy.sources?.[port]
      let previous: number | undefined = explicit
      if (previous === undefined) {
        const producer = [...ancestors].reverse().find((a) => !a.disabled && outputKinds(a.type).includes(kind))
        previous = producer ? newIndex.get(copyOf.get(producer)!) : undefined
      }
      if (previous === undefined) continue
      if (copy.sources) {
        const sources = { ...copy.sources }
        delete sources[port]
        copy.sources = sources
      }
      copy.source_modes = { ...copy.source_modes, [port]: 'custom' }
      copy.source_selections = { ...copy.source_selections, [port]: [previous, loaderIdx] }
    }
    warnings?.push(
      `Moved ${plan.count} ${plan.count === 1 ? 'reference' : 'references'} from "${old.label || BLOCK_LABEL[old.type] || old.type}" into a new ${LOADER_LABEL[plan.loader.type]} before it.`,
    )
    if (plan.voices > 0) warnings?.push(voicesMovedMessage(plan.voices, LOADER_LABEL[plan.loader.type]))
  }

  // Drop empty maps left by renumbering, so exports stay tidy.
  for (const copy of copyOf.values()) {
    if (copy.sources && Object.keys(copy.sources).length === 0) delete copy.sources
    if (copy.source_selections && Object.keys(copy.source_selections).length === 0) delete copy.source_selections
  }
  return { ...flow, blocks }
}
