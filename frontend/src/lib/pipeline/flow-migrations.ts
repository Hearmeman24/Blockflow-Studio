import type { SavedBlock, SavedFlow } from './flow-io'
import type { SourceMode } from './types'
import { describeUnsupportedBlock, isBlockTypeRegistered } from './legacy-blocks'
import { migrateReferencesToLoaders, type OutputKinds } from './migrate-references-to-loaders'
import { migrateVoiceToAudio } from './migrate-voice-to-audio'
import { canonicalizePortKind, getNodeType } from './registry'
import { LOADER_CONFIG_KEY, legacyImageItems, legacyVideoItems } from '@/lib/byok/loader-items'

/**
 * Saved-flow schema versions.
 *
 * - 1: legacy `version: 1` files (linear pipelines, no `schema_version`).
 * - 2: legacy `version: 2` files (pipelines with branches, no `schema_version`).
 * - 3: BYOK fork. Explicit `schema_version`. The legacy `version` field keeps
 *      its old "has branches" meaning so older builds can still read the file.
 * - 4: Image Loader and Video Loader keep an ordered `items` list. The Video
 *      Loader's single-video keys and the image loader's `uploads_v2` map are
 *      rewritten into it.
 * - 5: Generation blocks no longer hold references. Saved `references` move
 *      into a loader inserted directly upstream (migrate-references-to-loaders.ts).
 * - 6: Voice is audio. Voice lists, selections, references and the `voice`
 *      port's sources fold into audio (migrate-voice-to-audio.ts).
 *
 * Every import (flow files, workspace tabs, run snapshots) goes through
 * `migrateSavedFlow`: parse → structural sanitising → ordered migration steps
 * → registry validation. Only the sanitising stage may drop data, and only data
 * that is malformed (not a block, an index that points nowhere); the migration
 * steps never drop blocks, connections, branches, labels, disabled flags or
 * config.
 */
export const CURRENT_FLOW_SCHEMA_VERSION = 6

/** Deeper branch nesting than this is refused rather than risking a stack overflow. */
export const MAX_FLOW_DEPTH = 64

export const NEWER_SCHEMA_ERROR =
  'This flow was saved by a newer version of BlockFlow. Update BlockFlow to open it.'
const MISSING_BLOCKS_ERROR = 'Invalid flow file: missing blocks array'
const NOT_A_FLOW_ERROR = 'This file is not a BlockFlow flow.'
const UNREADABLE_ERROR = 'This flow could not be read.'
const TOO_DEEP_ERROR = 'This flow is nested too deeply to open.'

export interface UnsupportedBlockReport {
  type: string
  label: string
  reason: string
}

export interface FlowImportReport {
  from_version: number
  to_version: number
  unsupported: UnsupportedBlockReport[]
  warnings: string[]
}

export type FlowImportErrorCode = 'newer_schema' | 'invalid'

export type FlowMigrationResult =
  | { ok: true; flow: SavedFlow; report: FlowImportReport }
  | { ok: false; code: FlowImportErrorCode; error: string }

export interface MigrationContext {
  /** Output port kinds of a block type, to find what fed a block before. */
  outputKinds: OutputKinds
  /** Notes for the import report. */
  warnings?: string[]
}

export interface FlowMigrationStep {
  from: number
  to: number
  migrate: (flow: SavedFlow, ctx?: MigrationContext) => SavedFlow
}

/** Output kinds from the block registry. */
export function registryOutputKinds(type: string): string[] {
  return getNodeType(type)?.outputs.map((p) => canonicalizePortKind(p.kind)) ?? []
}

/**
 * Ordered, pure migration steps keyed by the schema they upgrade from.
 * A step returns a new flow and never mutates its input.
 */
export const FLOW_MIGRATIONS: ReadonlyArray<FlowMigrationStep> = Object.freeze([
  {
    from: 1,
    to: 2,
    // Version 1 only differs from 2 by never containing branches. Nothing to
    // rewrite; a v1 file that does carry branches keeps them.
    migrate: (flow: SavedFlow): SavedFlow => ({ ...flow, schema_version: 2 }),
  },
  {
    from: 2,
    to: 3,
    // BYOK fork. The kept blocks' configKeys were audited against the fork
    // base (40721f3) and none were renamed, so no config rewriting is needed.
    // Removed block types are not rewritten either: they stay in the flow with
    // their original type and data, and the registry validation that runs
    // after every migration marks them unsupported (that pass must also catch
    // unknown types in schema-3 files, so it is not tied to this step).
    migrate: (flow: SavedFlow): SavedFlow => ({ ...flow, schema_version: 3 }),
  },
  {
    from: 3,
    to: 4,
    // Loaders hold an ordered item list. Only the old loader keys are
    // rewritten; every other block and config value is left untouched.
    migrate: (flow: SavedFlow): SavedFlow => ({ ...flow, schema_version: 4, blocks: mapTree(flow.blocks, migrateLoaderConfig) }),
  },
  {
    from: 4,
    to: 5,
    // References leave the generation blocks: each block that saved some gets
    // its loader inserted directly upstream, and every source index is renumbered.
    migrate: (flow: SavedFlow, ctx?: MigrationContext): SavedFlow => ({
      ...migrateReferencesToLoaders(flow, ctx?.outputKinds ?? registryOutputKinds, ctx?.warnings),
      schema_version: 5,
    }),
  },
  {
    from: 5,
    to: 6,
    // Voice is audio: voices move into Audio after the audio, and a voice
    // input's sources fold into the audio input. Prompts are not touched.
    migrate: (flow: SavedFlow, ctx?: MigrationContext): SavedFlow => ({
      ...migrateVoiceToAudio(flow, ctx?.outputKinds ?? registryOutputKinds, ctx?.warnings),
      schema_version: 6,
    }),
  },
])

const VIDEO_LEGACY_KEYS = ['local_url', 'remote_url', 'uploaded_fingerprint', 'uploaded_video_url'] as const

function mapTree(blocks: SavedBlock[], fn: (block: SavedBlock) => SavedBlock): SavedBlock[] {
  return blocks.map((block) => {
    const next = fn(block)
    return next.branches ? { ...next, branches: next.branches.map((branch) => mapTree(branch, fn)) } : next
  })
}

function migrateLoaderConfig(block: SavedBlock): SavedBlock {
  const config = block.config
  if (!config || LOADER_CONFIG_KEY in config) return block
  if (block.type === 'videoLoader' && VIDEO_LEGACY_KEYS.some((k) => k in config)) {
    const rest = { ...config }
    for (const key of VIDEO_LEGACY_KEYS) delete rest[key]
    return { ...block, config: { ...rest, [LOADER_CONFIG_KEY]: legacyVideoItems(config) } }
  }
  if (block.type === 'uploadImageToTmpfiles' && 'uploads_v2' in config) {
    const { uploads_v2: uploads, ...rest } = config
    return { ...block, config: { ...rest, [LOADER_CONFIG_KEY]: legacyImageItems(uploads) } }
  }
  return block
}

const KNOWN_BLOCK_FIELDS = new Set([
  'type',
  'label',
  'disabled',
  'sources',
  'source_modes',
  'source_selections',
  'config',
  'branches',
])

const SOURCE_MODES: ReadonlySet<string> = new Set<SourceMode>(['closest', 'all', 'custom'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Saved block fields this version does not understand (kept for unsupported blocks). */
export function getExtraBlockFields(saved: SavedBlock): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(saved)) {
    if (!KNOWN_BLOCK_FIELDS.has(key)) extra[key] = value
  }
  return Object.keys(extra).length > 0 ? extra : undefined
}

class TooDeepError extends Error {}

/**
 * Structural pass. Produces well-formed SavedBlocks and renumbers source
 * indices around skipped entries. Indices are global depth-first positions, as
 * written by `exportFlow`.
 */
function sanitizeBlocks(rawBlocks: unknown[], warnings: string[]): SavedBlock[] {
  let oldCounter = 0
  let newCounter = 0
  const oldToNew = new Map<number, number>()
  // Raw source indices per kept block, resolved after the whole tree is numbered.
  const pending: Array<{
    saved: SavedBlock
    newIdx: number
    sources?: Record<string, unknown>
    selections?: Record<string, unknown>
  }> = []

  const countSkipped = (raw: unknown, depth: number) => {
    oldCounter++
    if (depth > MAX_FLOW_DEPTH) throw new TooDeepError()
    if (isPlainObject(raw) && Array.isArray(raw.branches)) {
      for (const branch of raw.branches) {
        if (Array.isArray(branch)) for (const child of branch) countSkipped(child, depth + 1)
      }
    }
  }

  const visitChain = (chain: unknown[], depth: number): SavedBlock[] => {
    if (depth > MAX_FLOW_DEPTH) throw new TooDeepError()
    const out: SavedBlock[] = []
    for (const raw of chain) {
      const entryNo = oldCounter + 1
      if (!isPlainObject(raw)) {
        warnings.push(`Skipped entry ${entryNo}: it is not a block.`)
        oldCounter++
        continue
      }
      if (typeof raw.type !== 'string' || raw.type.length === 0) {
        warnings.push(`Skipped entry ${entryNo}: it has no block type.`)
        countSkipped(raw, depth)
        continue
      }

      const oldIdx = oldCounter++
      const newIdx = newCounter++
      oldToNew.set(oldIdx, newIdx)
      const blockNo = newIdx + 1
      const saved: SavedBlock = { type: raw.type }

      if ('label' in raw) {
        if (typeof raw.label === 'string') {
          if (raw.label) saved.label = raw.label
        } else warnings.push(`Block ${blockNo}: ignored a label that is not text.`)
      }
      if ('disabled' in raw) {
        if (raw.disabled === true) saved.disabled = true
        else if (raw.disabled !== false) warnings.push(`Block ${blockNo}: ignored an invalid disabled flag.`)
      }

      let rawSources: Record<string, unknown> | undefined
      if ('sources' in raw) {
        if (isPlainObject(raw.sources)) rawSources = raw.sources
        else warnings.push(`Block ${blockNo}: ignored invalid input sources.`)
      }

      if ('source_modes' in raw) {
        if (isPlainObject(raw.source_modes)) {
          const modes: Record<string, SourceMode> = {}
          for (const [port, mode] of Object.entries(raw.source_modes)) {
            if (typeof mode === 'string' && SOURCE_MODES.has(mode)) modes[port] = mode as SourceMode
            else warnings.push(`Block ${blockNo}: ignored an invalid source mode for "${port}".`)
          }
          if (Object.keys(modes).length > 0) saved.source_modes = modes
        } else warnings.push(`Block ${blockNo}: ignored invalid source modes.`)
      }

      let rawSelections: Record<string, unknown> | undefined
      if ('source_selections' in raw) {
        if (isPlainObject(raw.source_selections)) rawSelections = raw.source_selections
        else warnings.push(`Block ${blockNo}: ignored invalid source selections.`)
      }

      if ('config' in raw) {
        if (isPlainObject(raw.config)) saved.config = raw.config
        else warnings.push(`Block ${blockNo}: ignored settings that are not an object.`)
      }

      // Unknown fields ride along; flow-io keeps them for unsupported blocks.
      for (const [key, value] of Object.entries(raw)) {
        if (!KNOWN_BLOCK_FIELDS.has(key)) (saved as unknown as Record<string, unknown>)[key] = value
      }

      pending.push({ saved, newIdx, sources: rawSources, selections: rawSelections })

      if ('branches' in raw) {
        if (Array.isArray(raw.branches)) {
          const branches: SavedBlock[][] = []
          for (const branch of raw.branches) {
            if (Array.isArray(branch)) branches.push(visitChain(branch, depth + 1))
            else warnings.push(`Block ${blockNo}: skipped a branch that is not a list of blocks.`)
          }
          if (branches.length > 0) saved.branches = branches
        } else warnings.push(`Block ${blockNo}: ignored branches that are not a list.`)
      }

      out.push(saved)
    }
    return out
  }

  const blocks = visitChain(rawBlocks, 0)

  // A source must be a block earlier in depth-first order (an upstream block).
  // Self and forward references would form a cycle; others point nowhere.
  const resolve = (value: unknown, ownIdx: number): number | undefined => {
    if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
    const mapped = oldToNew.get(value)
    if (mapped === undefined || mapped >= ownIdx) return undefined
    return mapped
  }

  for (const { saved, newIdx, sources, selections } of pending) {
    const blockNo = newIdx + 1
    if (sources) {
      const out: Record<string, number> = {}
      for (const [port, value] of Object.entries(sources)) {
        const mapped = resolve(value, newIdx)
        if (mapped === undefined) warnings.push(`Block ${blockNo}: dropped an invalid source for "${port}".`)
        else out[port] = mapped
      }
      if (Object.keys(out).length > 0) saved.sources = out
    }
    if (selections) {
      const out: Record<string, number[]> = {}
      for (const [port, values] of Object.entries(selections)) {
        if (!Array.isArray(values)) {
          warnings.push(`Block ${blockNo}: ignored an invalid source selection for "${port}".`)
          continue
        }
        const mappedList: number[] = []
        for (const value of values) {
          const mapped = resolve(value, newIdx)
          if (mapped === undefined) warnings.push(`Block ${blockNo}: dropped an invalid selected source for "${port}".`)
          else mappedList.push(mapped)
        }
        if (mappedList.length > 0) out[port] = mappedList
      }
      if (Object.keys(out).length > 0) saved.source_selections = out
    }
  }

  // Re-emit in canonical key order so exports stay stable.
  return reorderTree(blocks)
}

function reorderTree(blocks: SavedBlock[]): SavedBlock[] {
  return blocks.map((b) => {
    const out: SavedBlock = { type: b.type }
    if (b.label !== undefined) out.label = b.label
    if (b.disabled) out.disabled = true
    if (b.sources) out.sources = b.sources
    if (b.source_modes) out.source_modes = b.source_modes
    if (b.source_selections) out.source_selections = b.source_selections
    if (b.config) out.config = b.config
    if (b.branches) out.branches = b.branches.map(reorderTree)
    const extra = getExtraBlockFields(b)
    if (extra) Object.assign(out, extra)
    return out
  })
}

function validateAgainstRegistry(
  blocks: SavedBlock[],
  isRegistered: (type: string) => boolean,
  report: FlowImportReport,
) {
  let index = 0
  const visit = (chain: SavedBlock[]) => {
    for (const saved of chain) {
      const blockNo = ++index
      if (!isRegistered(saved.type)) {
        const info = describeUnsupportedBlock(saved.type)
        report.unsupported.push({ type: saved.type, label: saved.label || info.label, reason: info.reason })
      } else {
        const extra = getExtraBlockFields(saved)
        if (extra) {
          report.warnings.push(
            `Ignored unknown fields on block ${blockNo} ("${saved.label || saved.type}"): ${Object.keys(extra).join(', ')}.`,
          )
        }
      }
      for (const branch of saved.branches ?? []) visit(branch)
    }
  }
  visit(blocks)
}

/**
 * The single import entry point for saved flows, workspace tabs and run
 * snapshots. Pure: never mutates `input`, never throws, never touches storage.
 */
export function migrateSavedFlow(
  input: unknown,
  options: { isRegistered?: (type: string) => boolean; outputKinds?: OutputKinds } = {},
): FlowMigrationResult {
  const isRegistered = options.isRegistered ?? isBlockTypeRegistered

  // Normalise to a private JSON-safe copy: protects the caller's object and
  // rejects cyclic or non-serialisable values up front.
  let data: unknown
  try {
    data = typeof input === 'string' ? JSON.parse(input) : JSON.parse(JSON.stringify(input) ?? 'null')
  } catch {
    return { ok: false, code: 'invalid', error: typeof input === 'string' ? NOT_A_FLOW_ERROR : UNREADABLE_ERROR }
  }
  if (!isPlainObject(data)) return { ok: false, code: 'invalid', error: NOT_A_FLOW_ERROR }
  if (!Array.isArray(data.blocks)) return { ok: false, code: 'invalid', error: MISSING_BLOCKS_ERROR }

  const warnings: string[] = []
  const legacyVersion = data.version === 2 ? 2 : 1
  let fromVersion: number = legacyVersion
  if ('schema_version' in data) {
    const sv = data.schema_version
    if (typeof sv === 'number' && Number.isInteger(sv) && sv >= 1) {
      if (sv > CURRENT_FLOW_SCHEMA_VERSION) return { ok: false, code: 'newer_schema', error: NEWER_SCHEMA_ERROR }
      fromVersion = sv
    } else {
      warnings.push(`Ignored an invalid schema version; treated the flow as version ${legacyVersion}.`)
    }
  }

  let blocks: SavedBlock[]
  try {
    blocks = sanitizeBlocks(data.blocks, warnings)
  } catch (error) {
    if (error instanceof TooDeepError) return { ok: false, code: 'invalid', error: TOO_DEEP_ERROR }
    return { ok: false, code: 'invalid', error: UNREADABLE_ERROR }
  }
  if (blocks.length === 0 && data.blocks.length === 0) warnings.push('This flow has no blocks.')

  let flow: SavedFlow = {
    name: typeof data.name === 'string' ? data.name : '',
    version: legacyVersion,
    schema_version: fromVersion,
    created_at: typeof data.created_at === 'string' ? data.created_at : '',
    blocks,
  }
  const ctx: MigrationContext = { outputKinds: options.outputKinds ?? registryOutputKinds, warnings }
  for (const step of FLOW_MIGRATIONS) {
    if (flow.schema_version === step.from) flow = step.migrate(flow, ctx)
  }

  const report: FlowImportReport = {
    from_version: fromVersion,
    to_version: CURRENT_FLOW_SCHEMA_VERSION,
    unsupported: [],
    warnings,
  }
  validateAgainstRegistry(flow.blocks, isRegistered, report)
  return { ok: true, flow, report }
}
