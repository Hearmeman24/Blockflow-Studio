/**
 * What the Artifacts gallery shows for a run: its primary media (resolving
 * image/video/audio refs as well as the plain URL strings of old runs), the
 * aspect ratio to reserve before the media loads, the prompt, the model and a
 * failure summary.
 */
import { readGenerationMeta, toDisplayUrls as imageDisplayUrls, type GenerationMeta } from '@/lib/image-ref'
import { toDisplayUrls as videoDisplayUrls } from '@/lib/video-ref'
import type { BlockResult, RunEntry } from '@/lib/types'

/** Tile shape when nothing says otherwise. */
export const DEFAULT_ASPECT = 1

/**
 * Runs saved before voice became audio have `voice` ports carrying
 * `voice-ref` values; they are read as audio.
 */
function outputKind(kind: string): string {
  return kind === 'voice' ? 'audio' : kind
}

/** Display URLs of a media output, preferring the local copy over the public URL. */
export function mediaUrls(kind: string, value: unknown): string[] {
  kind = outputKind(kind)
  if (kind === 'image') return imageDisplayUrls(value)
  if (kind === 'video') return videoDisplayUrls(value)
  if (kind === 'audio') {
    return flat(value)
      .map((v) => {
        if (typeof v === 'string') return v.trim()
        if (v && typeof v === 'object') {
          const ref = v as { local?: unknown; url?: unknown }
          if (typeof ref.local === 'string' && ref.local) return ref.local
          if (typeof ref.url === 'string') return ref.url
        }
        return ''
      })
      .filter(Boolean)
  }
  return []
}

function flat(value: unknown): unknown[] {
  return Array.isArray(value) ? value.flat(Infinity as 1) : [value]
}

export interface PrimaryArtifact {
  kind: string
  value: unknown
  label: string
  blockIndex: number
}

/**
 * The run's primary output: video > image > audio > prompt > anything. Within
 * a kind, generated output (refs with generation metadata) wins over loader
 * inputs; otherwise the last block wins.
 */
export function findPrimaryArtifact(results: readonly BlockResult[]): PrimaryArtifact | null {
  const pick = (i: number, out: { kind: string; value: unknown }): PrimaryArtifact => ({
    kind: outputKind(out.kind), value: out.value, label: results[i].block_label, blockIndex: results[i].block_index,
  })
  for (const kind of ['video', 'image', 'audio', 'prompt']) {
    let fallback: PrimaryArtifact | null = null
    for (let i = results.length - 1; i >= 0; i--) {
      for (const out of Object.values(results[i].outputs ?? {})) {
        if (outputKind(out.kind) !== kind) continue
        if (flat(out.value).some((v) => readGenerationMeta(v))) return pick(i, out)
        fallback ??= pick(i, out)
      }
    }
    if (fallback) return fallback
  }
  for (let i = results.length - 1; i >= 0; i--) {
    const first = Object.values(results[i].outputs ?? {})[0]
    if (first) return pick(i, first)
  }
  return null
}

/** Generation metadata of the primary output's first ref that has some. */
export function primaryMeta(primary: PrimaryArtifact | null): GenerationMeta | null {
  if (!primary) return null
  for (const v of flat(primary.value)) {
    const meta = readGenerationMeta(v)
    if (meta) return meta
  }
  return null
}

/** "16:9" → 1.777…; null for "auto", empty or malformed values. */
export function parseAspectRatio(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)\s*$/.exec(value)
  if (!m) return null
  const w = Number(m[1])
  const h = Number(m[2])
  return w > 0 && h > 0 ? w / h : null
}

type SnapshotBlock = { type?: unknown; config?: Record<string, unknown> }

function snapshotBlocks(run: RunEntry): SnapshotBlock[] {
  const blocks = (run.flow_snapshot as { blocks?: unknown } | undefined)?.blocks
  return Array.isArray(blocks) ? blocks.filter((b): b is SnapshotBlock => !!b && typeof b === 'object') : []
}

/** Generation blocks (they name a provider and a model), last first. */
function generationConfigs(run: RunEntry): Record<string, unknown>[] {
  return snapshotBlocks(run)
    .map((b) => b.config)
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof c.model === 'string' && typeof c.provider === 'string')
    .reverse()
}

function metadataValues(run: RunEntry): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const br of run.block_results ?? []) {
    for (const o of Object.values(br.outputs ?? {})) {
      if (o.kind !== 'metadata') continue
      for (const m of flat(o.value)) if (m && typeof m === 'object') out.push(m as Record<string, unknown>)
    }
  }
  return out
}

/**
 * Aspect ratio (width / height) to reserve for the run's tile before its media
 * loads: the primary ref's own size, else the requested aspect ratio, else square.
 */
export function runAspect(run: RunEntry, primary: PrimaryArtifact | null = findPrimaryArtifact(run.block_results ?? [])): number {
  if (primary) {
    for (const v of flat(primary.value)) {
      const ref = v as { width?: unknown; height?: unknown } | null
      if (ref && typeof ref === 'object' && typeof ref.width === 'number' && typeof ref.height === 'number' && ref.width > 0 && ref.height > 0) {
        return ref.width / ref.height
      }
    }
  }
  for (const config of generationConfigs(run)) {
    const params = config.params as Record<string, unknown> | undefined
    const ratio = parseAspectRatio(params?.aspect_ratio) ?? parseAspectRatio(config.aspect_ratio)
    if (ratio) return ratio
  }
  return DEFAULT_ASPECT
}

/**
 * Block index of the generation block that produced the primary output. The
 * primary can sit on a viewer block that passes the same ref through, so this
 * looks for identity: the earliest result with an output of the primary's kind
 * whose ref carries the primary's generation job id. Without metadata (old
 * runs), the nearest block at or before the primary whose saved config is a
 * generation config. -1 when there is none.
 */
function producingBlockIndex(run: RunEntry, primary: PrimaryArtifact): number {
  const jobId = primaryMeta(primary)?.job_id
  if (jobId) {
    const hits: number[] = []
    for (const br of run.block_results ?? []) {
      for (const o of Object.values(br.outputs ?? {})) {
        if (outputKind(o.kind) !== primary.kind) continue
        if (flat(o.value).some((v) => readGenerationMeta(v)?.job_id === jobId)) hits.push(br.block_index)
      }
    }
    if (hits.length > 0) return Math.min(...hits)
  }
  const blocks = snapshotBlocks(run)
  for (let i = Math.min(primary.blockIndex, blocks.length - 1); i >= 0; i--) {
    const c = blocks[i].config
    if (c && typeof c.model === 'string' && typeof c.provider === 'string') return i
  }
  return -1
}

/**
 * The text the generation block at `genIndex` received: the text output of the
 * closest block before it that produced one (Prompt Writer, Prompt From Txt,
 * ...). Mirrors the pipeline's default source rule for a text input, the
 * closest upstream producer (`resolvePort` in pipeline-context and
 * `selectedSourceIds` in lib/pipeline/source-resolution). Outputs of kind
 * `prompt` count as text too.
 */
function upstreamText(run: RunEntry, genIndex: number): string {
  const results = [...(run.block_results ?? [])]
    .filter((r) => r.block_index < genIndex)
    .sort((a, b) => b.block_index - a.block_index)
  for (const br of results) {
    for (const o of Object.values(br.outputs ?? {})) {
      if (o.kind !== 'text' && o.kind !== 'prompt') continue
      if (typeof o.value === 'string' && o.value.trim()) return o.value.trim()
    }
  }
  return ''
}

/**
 * The prompt the run generated from: the generation block's own prompt, or
 * the upstream text it used, or (old runs) the prompt in a metadata output.
 * With several generation blocks, the one that produced the primary output
 * decides.
 */
export function runPrompt(run: RunEntry): string {
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const primary = findPrimaryArtifact(run.block_results ?? [])
  const producerIndex = primary ? producingBlockIndex(run, primary) : -1
  const primaryConfig = producerIndex >= 0 ? snapshotBlocks(run)[producerIndex]?.config : undefined
  if (primaryConfig && typeof primaryConfig.model === 'string' && typeof primaryConfig.provider === 'string') {
    if (primaryConfig.use_upstream_prompt === true) {
      const upstream = upstreamText(run, producerIndex)
      if (upstream) return upstream
    } else if (text(primaryConfig.prompt)) {
      return text(primaryConfig.prompt)
    }
  }
  for (const config of generationConfigs(run)) {
    if (config.use_upstream_prompt !== true && text(config.prompt)) return text(config.prompt)
  }
  const results = run.block_results ?? []
  for (let i = results.length - 1; i >= 0; i--) {
    for (const o of Object.values(results[i].outputs ?? {})) {
      if (o.kind === 'prompt' && text(o.value)) return text(o.value)
    }
  }
  for (const b of snapshotBlocks(run)) if (text(b.config?.prompt)) return text(b.config?.prompt)
  for (const m of metadataValues(run)) if (text(m.prompt)) return text(m.prompt)
  return ''
}

/** Model id of the run's output: generation metadata, the snapshot, or old metadata outputs. */
export function runModelId(run: RunEntry, primary: PrimaryArtifact | null = findPrimaryArtifact(run.block_results ?? [])): string {
  const meta = primaryMeta(primary)
  if (meta?.model) return meta.model
  const config = generationConfigs(run)[0]
  if (config) return config.model as string
  for (const m of metadataValues(run)) if (typeof m.model === 'string' && m.model) return m.model
  return ''
}

/** A one-line summary of what went wrong, for runs that did not complete. */
export function runFailure(run: RunEntry): string | null {
  if (run.status === 'completed') return null
  const failed = (run.block_results ?? []).filter((b) => b.status === 'error').map((b) => b.block_label)
  if (failed.length > 0) return `${failed.join(', ')} failed.`
  return run.status === 'partial' ? 'The run finished partly.' : 'The run failed.'
}

export interface RunMedia {
  kind: 'image' | 'video' | 'audio'
  url: string
}

/** Every output on the primary port (a run can produce several), in order. */
export function runOutputs(run: RunEntry, primary: PrimaryArtifact | null = findPrimaryArtifact(run.block_results ?? [])): RunMedia[] {
  if (!primary || (primary.kind !== 'image' && primary.kind !== 'video' && primary.kind !== 'audio')) return []
  const kind = primary.kind
  return mediaUrls(kind, primary.value).map((url) => ({ kind, url }))
}

/** Provider id of the run's output: generation metadata, else the snapshot. */
export function runProviderId(run: RunEntry, primary: PrimaryArtifact | null = findPrimaryArtifact(run.block_results ?? [])): string {
  const meta = primaryMeta(primary)
  if (meta?.provider) return meta.provider
  const config = generationConfigs(run)[0]
  return config ? (config.provider as string) : ''
}

function humanize(key: string): string {
  const words = key.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The generation settings the run used, from its generation block in the
 * flow snapshot: resolution, aspect ratio, duration, then the model's own
 * settings. Empty values and settings that were off are left out.
 */
export function runSettings(run: RunEntry): { label: string; value: string }[] {
  const config = generationConfigs(run)[0]
  const params = (config?.params ?? {}) as Record<string, unknown>
  const rows: { label: string; value: string }[] = []
  const add = (label: string, v: unknown, suffix = '') => {
    if (v === true) rows.push({ label, value: 'On' })
    else if (typeof v === 'number' && Number.isFinite(v)) rows.push({ label, value: `${v}${suffix}` })
    else if (typeof v === 'string' && v.trim()) rows.push({ label, value: `${v.trim()}${suffix}` })
  }
  add('Resolution', params.resolution)
  add('Aspect ratio', params.aspect_ratio)
  add('Duration', params.duration, ' s')
  const settings = params.settings
  if (settings && typeof settings === 'object') {
    for (const [key, v] of Object.entries(settings as Record<string, unknown>)) add(humanize(key), v)
  }
  return rows
}

export interface RunReference {
  kind: 'image' | 'video' | 'audio'
  url: string
  label: string
}

/** Where loader blocks keep their items, and the kind of each list. `voice_items` is in snapshots of runs saved before voice became audio. */
const LOADER_LISTS: Record<string, Array<[key: string, kind: RunReference['kind']]>> = {
  uploadImageToTmpfiles: [['items', 'image']],
  videoLoader: [['items', 'video']],
  omniReferenceLoader: [['image_items', 'image'], ['video_items', 'video'], ['audio_items', 'audio'], ['voice_items', 'audio']],
}

/** The reference files the run's loader blocks supplied, from its flow snapshot. */
export function runReferences(run: RunEntry): RunReference[] {
  const out: RunReference[] = []
  for (const b of snapshotBlocks(run)) {
    const lists = typeof b.type === 'string' ? LOADER_LISTS[b.type] : undefined
    if (!lists || !b.config) continue
    for (const [key, kind] of lists) {
      const items = b.config[key]
      if (!Array.isArray(items)) continue
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const it = item as { local?: unknown; url?: unknown; label?: unknown }
        const url = typeof it.local === 'string' && it.local ? it.local : typeof it.url === 'string' ? it.url : ''
        if (!url) continue
        out.push({ kind, url, label: typeof it.label === 'string' && it.label ? it.label : url.split('/').pop() ?? url })
      }
    }
  }
  return out
}
