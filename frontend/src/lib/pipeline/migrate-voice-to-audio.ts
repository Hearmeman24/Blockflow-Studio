/**
 * Flow schema 5 to 6: voice is audio. BlockFlow has no named voices; a voice
 * sample is an audio clip, sent as audio, and the prompt says how to use it.
 *
 * - Omni Reference Loader: `voice_items` are appended after `audio_items`
 *   (existing audio keeps its numbering, so `Audio1`-style mentions keep their
 *   meaning), without their speaker `name`; `voice_items` is removed.
 * - Load Character: `selection.voice` (one media id) is appended after
 *   `selection.audio`; snapshot items of kind `voice` become `audio`.
 * - Generation blocks: `references` saved by older versions with kind `voice`
 *   become `audio`, without a name.
 * - Every block: the `voice` entries of `sources`, `source_modes` and
 *   `source_selections` are removed. Where the voice input read a producer the
 *   audio input would not read, the audio input becomes `custom` with both,
 *   upstream first (as the 4 to 5 step does), so no reference disappears.
 *
 * Prompt text is never modified. Pure: returns new objects, never throws.
 */
import type { SavedBlock, SavedFlow } from './flow-io'
import type { OutputKinds } from './migrate-references-to-loaders'

const OMNI_LOADER = 'omniReferenceLoader'
const LOAD_CHARACTER = 'loadCharacter'
/** Block types that had a `voice` output port in schema 5 (they all also output audio). */
const LEGACY_VOICE_PRODUCERS: ReadonlySet<string> = new Set([OMNI_LOADER, LOAD_CHARACTER])
/** Block types that had a `voice` input port in schema 5: its default (`closest`) mode read voices too. */
const LEGACY_VOICE_CONSUMERS: ReadonlySet<string> = new Set(['omniReferenceToVideo'])

const BLOCK_LABEL: Record<string, string> = {
  [OMNI_LOADER]: 'Omni Reference Loader',
  [LOAD_CHARACTER]: 'Load Character',
  omniReferenceToVideo: 'Omni Reference to Video',
  imageToVideo: 'Image to Video',
  imageToImage: 'Image to Image',
}

export const VOICE_PROMPT_NOTE = 'Voice mentions in prompts (such as @Name) are not rewritten. Use the audio mention instead.'
const MOVED_PREFIX = 'Voices are now audio: moved '

export function voicesMovedMessage(count: number, label: string): string {
  return `${MOVED_PREFIX}${count} voice ${count === 1 ? 'clip' : 'clips'} into Audio in "${label}".`
}

function rewiredMessage(label: string): string {
  return `Voices are now audio: the audio input of "${label}" now also reads what its voice input read.`
}

export function blockLabel(block: SavedBlock): string {
  return block.label || BLOCK_LABEL[block.type] || block.type
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function withoutName(value: unknown): unknown {
  if (!isRecord(value) || !('name' in value)) return value
  const copy = { ...value }
  delete copy.name
  return copy
}

/** Omni Reference Loader: voices after the audio. Returns the new config and how many clips moved. */
function foldLoader(config: Record<string, unknown>): { config: Record<string, unknown>; moved: number } {
  if (!('voice_items' in config)) return { config, moved: 0 }
  const next = { ...config }
  const voices = Array.isArray(config.voice_items) ? config.voice_items : []
  delete next.voice_items
  const audio = Array.isArray(config.audio_items) ? config.audio_items : []
  const ids = new Set<unknown>(audio.map((i) => (isRecord(i) ? i.id : undefined)).filter((id) => id !== undefined))
  const added = voices.filter((v) => !(isRecord(v) && ids.has(v.id))).map(withoutName)
  if (added.length > 0 || !Array.isArray(config.audio_items)) next.audio_items = [...audio, ...added]
  return { config: next, moved: added.length }
}

/** Load Character: the voice id after the audio ids; voice snapshot items become audio. */
function foldCharacter(config: Record<string, unknown>): { config: Record<string, unknown>; moved: number } {
  let next = config
  let moved = 0
  if (isRecord(config.selection) && 'voice' in config.selection) {
    const { voice, ...selection } = config.selection
    const audio = Array.isArray(selection.audio) ? selection.audio : []
    if (typeof voice === 'string' && voice && !audio.includes(voice)) {
      selection.audio = [...audio, voice]
      moved = 1
    } else if (!Array.isArray(selection.audio)) {
      selection.audio = audio
    }
    next = { ...next, selection }
  }
  if (isRecord(config.snapshot) && isRecord(config.snapshot.items)) {
    const items = config.snapshot.items
    if (Object.values(items).some((i) => isRecord(i) && i.kind === 'voice')) {
      const rewritten = Object.fromEntries(Object.entries(items).map(([id, i]) => [id, isRecord(i) && i.kind === 'voice' ? { ...i, kind: 'audio' } : i]))
      next = { ...next, snapshot: { ...config.snapshot, items: rewritten } }
    }
  }
  return { config: next, moved }
}

/** Generation blocks: saved voice references become audio references. */
function foldReferences(config: Record<string, unknown>): { config: Record<string, unknown>; moved: number } {
  if (!Array.isArray(config.references)) return { config, moved: 0 }
  let moved = 0
  const references = config.references.map((r) => {
    if (!isRecord(r) || r.kind !== 'voice') return r
    moved += 1
    return { ...(withoutName(r) as Record<string, unknown>), kind: 'audio' }
  })
  return moved > 0 ? { config: { ...config, references }, moved } : { config, moved: 0 }
}

function foldConfig(block: SavedBlock): { config: Record<string, unknown> | undefined; moved: number } {
  const config = block.config
  if (!config) return { config, moved: 0 }
  if (block.type === OMNI_LOADER) return foldLoader(config)
  if (block.type === LOAD_CHARACTER) return foldCharacter(config)
  return foldReferences(config)
}

/**
 * The producer indices a port reads, as the runner resolves it (`source-resolution.ts`):
 * `all` every producer, `custom` its selection, `closest` the explicit source or the closest producer.
 */
export function portReads(block: SavedBlock, port: string, producers: readonly number[]): number[] {
  const mode = block.source_modes?.[port] ?? 'closest'
  if (mode === 'all') return [...producers]
  if (mode === 'custom') return [...(block.source_selections?.[port] ?? [])]
  const explicit = block.sources?.[port]
  if (explicit !== undefined) return [explicit]
  const closest = producers[producers.length - 1]
  return closest === undefined ? [] : [closest]
}

/**
 * Make `port` read `extra` too, keeping what it reads now, upstream first
 * (depth-first index order). Returns null when it already reads all of them.
 */
export function readAlso(block: SavedBlock, port: string, producers: readonly number[], extra: readonly number[]): SavedBlock | null {
  const current = portReads(block, port, producers)
  if (extra.every((i) => current.includes(i))) return null
  const next: SavedBlock = { ...block }
  if (next.sources && port in next.sources) {
    const sources = { ...next.sources }
    delete sources[port]
    next.sources = sources
  }
  next.source_modes = { ...next.source_modes, [port]: 'custom' }
  next.source_selections = { ...next.source_selections, [port]: [...new Set([...current, ...extra])].sort((a, b) => a - b) }
  return next
}

function dropPort(block: SavedBlock, port: string): SavedBlock {
  const next: SavedBlock = { ...block }
  for (const field of ['sources', 'source_modes', 'source_selections'] as const) {
    const map = next[field] as Record<string, unknown> | undefined
    if (!map || !(port in map)) continue
    const copy = { ...map }
    delete copy[port]
    if (Object.keys(copy).length > 0) (next as unknown as Record<string, unknown>)[field] = copy
    else delete next[field]
  }
  return next
}

function hasVoicePort(block: SavedBlock): boolean {
  return LEGACY_VOICE_CONSUMERS.has(block.type)
    || [block.sources, block.source_modes, block.source_selections].some((map) => Boolean(map && 'voice' in map))
}

export function migrateVoiceToAudio(flow: SavedFlow, outputKinds: OutputKinds, warnings?: string[]): SavedFlow {
  const producesVoice = (type: string) => LEGACY_VOICE_PRODUCERS.has(type) || outputKinds(type).includes('voice')
  const producesAudio = (type: string) => LEGACY_VOICE_PRODUCERS.has(type) || outputKinds(type).includes('audio')

  // Depth-first order (the index sources use) and each block's ancestors, as the runner sees them.
  const indexOf = new Map<SavedBlock, number>()
  const ancestorsOf = new Map<SavedBlock, SavedBlock[]>()
  let counter = 0
  const walk = (chain: SavedBlock[], prefix: SavedBlock[]) => {
    chain.forEach((block, i) => {
      const ancestors = [...prefix, ...chain.slice(0, i)]
      indexOf.set(block, counter++)
      ancestorsOf.set(block, ancestors)
      for (const branch of block.branches ?? []) walk(branch, [...ancestors, block])
    })
  }
  walk(flow.blocks, [])

  const notes: string[] = []
  const migrateBlock = (block: SavedBlock): SavedBlock => {
    let next: SavedBlock = { ...block }
    const { config, moved } = foldConfig(block)
    if (config !== block.config) next.config = config
    if (moved > 0) notes.push(voicesMovedMessage(moved, blockLabel(block)))

    if (hasVoicePort(block)) {
      const ancestors = (ancestorsOf.get(block) ?? []).filter((a) => !a.disabled)
      const producers = (test: (type: string) => boolean) => ancestors.filter((a) => test(a.type)).map((a) => indexOf.get(a)!)
      const voiceReads = portReads(block, 'voice', producers(producesVoice))
      const rewired = readAlso(next, 'audio', producers(producesAudio), voiceReads)
      if (rewired) {
        next = rewired
        notes.push(rewiredMessage(blockLabel(block)))
      }
      next = dropPort(next, 'voice')
    }
    if (block.branches) next.branches = block.branches.map((branch) => branch.map(migrateBlock))
    return next
  }
  const blocks = flow.blocks.map(migrateBlock)

  if (warnings) {
    warnings.push(...notes)
    if (warnings.some((w) => w.startsWith(MOVED_PREFIX)) && !warnings.includes(VOICE_PROMPT_NOTE)) warnings.push(VOICE_PROMPT_NOTE)
  }
  return { ...flow, blocks }
}
