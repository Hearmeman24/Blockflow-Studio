import type { Pipeline, PipelineBlock, PreservedBlockData, SourceMode } from './types'
import { getBlockDef, getNodeType } from './registry'
import { walkBlocks, buildGlobalIndex } from './tree-utils'
import {
  CURRENT_FLOW_SCHEMA_VERSION,
  getExtraBlockFields,
  migrateSavedFlow,
  type FlowImportErrorCode,
  type FlowImportReport,
} from './flow-migrations'

// ---- Types ----

export interface SavedBlock {
  type: string
  label?: string
  disabled?: boolean
  /** Source overrides with global block indices (not IDs). */
  sources?: Record<string, number>
  /** Source fan-in mode per input port. Defaults to closest upstream. */
  source_modes?: Record<string, SourceMode>
  /** Custom multi-source selections with global block indices. */
  source_selections?: Record<string, number[]>
  config?: Record<string, unknown>
  /** Branches forking from this block (recursive). */
  branches?: SavedBlock[][]
}

export interface SavedFlow {
  name: string
  /** Legacy field: 2 when the pipeline has branches, else 1. Kept so older builds can read the file. */
  version: 1 | 2
  /** Saved-flow schema version (see flow-migrations.ts). Absent in pre-BYOK files. */
  schema_version?: number
  created_at: string
  blocks: SavedBlock[]
}

// ---- Export ----

/**
 * A block's saveable config as it is now: its `configKeys` (or only the ones
 * in `only`) read from sessionStorage; for a block with no registered type,
 * the config it was imported with. Undefined when there is nothing to save.
 */
export function exportBlockConfig(block: PipelineBlock, only?: readonly string[]): Record<string, unknown> | undefined {
  if (getNodeType(block.type) === undefined) return block.preserved?.config
  const keys = getBlockDef(block.type)?.configKeys ?? []
  const config: Record<string, unknown> = {}
  for (const key of keys) {
    if (only && !only.includes(key)) continue
    const raw = sessionStorage.getItem(`block_${block.id}_${key}`)
    if (raw === null) continue
    try {
      config[key] = JSON.parse(raw)
    } catch {
      config[key] = raw
    }
  }
  return Object.keys(config).length > 0 ? config : undefined
}

export interface ExportFlowOptions {
  /** Where a block's config comes from; by default sessionStorage as it is now (`exportBlockConfig`). */
  configFor?: (block: PipelineBlock) => Record<string, unknown> | undefined
}

/** Build a SavedFlow from the current pipeline + sessionStorage configs. */
export function exportFlow(pipeline: Pipeline, name: string, options: ExportFlowOptions = {}): SavedFlow {
  const configFor = options.configFor ?? exportBlockConfig
  // Build a global index map (block ID → sequential index via depth-first walk)
  const blockIndexById = buildGlobalIndex(pipeline.blocks)

  function exportBlock(block: PipelineBlock): SavedBlock {
    const saved: SavedBlock = { type: block.type }
    const isSupported = getNodeType(block.type) !== undefined

    if (block.label) saved.label = block.label
    if (block.disabled) saved.disabled = true

    // Convert source block IDs → global indices
    if (block.sources) {
      const sources: Record<string, number> = {}
      for (const [port, sourceId] of Object.entries(block.sources)) {
        const idx = blockIndexById.get(sourceId)
        if (idx !== undefined) sources[port] = idx
      }
      if (Object.keys(sources).length > 0) saved.sources = sources
    }

    if (block.sourceModes) {
      saved.source_modes = { ...block.sourceModes }
    }

    if (block.sourceSelections) {
      const sourceSelections: Record<string, number[]> = {}
      for (const [port, sourceIds] of Object.entries(block.sourceSelections)) {
        const indices = sourceIds
          .map((sourceId) => blockIndexById.get(sourceId))
          .filter((idx): idx is number => idx !== undefined)
        if (indices.length > 0) sourceSelections[port] = indices
      }
      if (Object.keys(sourceSelections).length > 0) saved.source_selections = sourceSelections
    }

    // Saveable config from sessionStorage; an unsupported block writes back
    // the config it was imported with.
    const config = configFor(block)
    if (config) saved.config = config

    // Recursively export branches
    if (block.branches && block.branches.length > 0) {
      saved.branches = block.branches.map((branch) =>
        branch.map((b) => exportBlock(b))
      )
    }

    // Fields an unsupported block carried that this version does not know.
    if (!isSupported && block.preserved?.extra) {
      for (const [key, value] of Object.entries(block.preserved.extra)) {
        if (!(key in saved)) (saved as unknown as Record<string, unknown>)[key] = value
      }
    }

    return saved
  }

  const hasBranches = [...walkBlocks(pipeline.blocks)].some((b) => b.branches && b.branches.length > 0)

  return {
    name,
    version: hasBranches ? 2 : 1,
    schema_version: CURRENT_FLOW_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    blocks: pipeline.blocks.map((b) => exportBlock(b)),
  }
}

// ---- Import ----

export type FlowImportOutcome =
  | { ok: true; pipeline: Pipeline; flow: SavedFlow; report: FlowImportReport }
  | { ok: false; code: FlowImportErrorCode; error: string }

/**
 * Import a saved flow (JSON string or parsed object): migrate it to the current
 * schema and validate its block types (see `migrateSavedFlow`), then build a
 * Pipeline with fresh block IDs and write supported blocks' config to
 * sessionStorage. Never throws; on failure nothing is written.
 */
export function importFlowWithReport(input: unknown): FlowImportOutcome {
  const migrated = migrateSavedFlow(input)
  if (!migrated.ok) return migrated
  const pipeline = buildPipeline(migrated.flow)
  return { ok: true, pipeline, flow: migrated.flow, report: migrated.report }
}

/** Throwing variant of `importFlowWithReport` for callers that only need the pipeline. */
export function importFlow(json: string): Pipeline {
  const result = importFlowWithReport(json)
  if (!result.ok) throw new Error(result.error)
  return result.pipeline
}

/** Build a Pipeline from an already-migrated SavedFlow and write configs to sessionStorage. */
function buildPipeline(flow: SavedFlow): Pipeline {
  // Count all SavedBlocks in depth-first order to generate sequential IDs
  let total = 0
  const countAll = (blocks: SavedBlock[]) => {
    for (const b of blocks) {
      total++
      for (const branch of b.branches ?? []) countAll(branch)
    }
  }
  countAll(flow.blocks)

  const stamp = Date.now()
  const newIds: string[] = Array.from(
    { length: total },
    (_, i) => `block-${stamp}-${i}-${Math.random().toString(36).slice(2, 6)}`,
  )

  let globalIdx = 0

  function importChain(savedBlocks: SavedBlock[]): PipelineBlock[] {
    return savedBlocks.map((saved) => {
      const myIdx = globalIdx++
      const block: PipelineBlock = {
        id: newIds[myIdx],
        type: saved.type,
      }

      if (saved.label) block.label = saved.label
      if (saved.disabled) block.disabled = true

      // Map source indices → new block IDs (migration already validated them)
      if (saved.sources) {
        const sources: Record<string, string> = {}
        for (const [port, idx] of Object.entries(saved.sources)) {
          if (idx >= 0 && idx < newIds.length) sources[port] = newIds[idx]
        }
        if (Object.keys(sources).length > 0) block.sources = sources
      }

      if (saved.source_modes) {
        block.sourceModes = { ...saved.source_modes }
      }

      if (saved.source_selections) {
        const sourceSelections: Record<string, string[]> = {}
        for (const [port, indices] of Object.entries(saved.source_selections)) {
          const sourceIds = indices
            .filter((idx) => idx >= 0 && idx < newIds.length)
            .map((idx) => newIds[idx])
          if (sourceIds.length > 0) sourceSelections[port] = sourceIds
        }
        if (Object.keys(sourceSelections).length > 0) block.sourceSelections = sourceSelections
      }

      if (!getNodeType(saved.type)) {
        // Unsupported block: keep its saved data verbatim on the block so a
        // later export writes it back unchanged.
        const preserved: PreservedBlockData = {}
        if (saved.config) preserved.config = saved.config
        const extra = getExtraBlockFields(saved)
        if (extra) preserved.extra = extra
        if (preserved.config || preserved.extra) block.preserved = preserved
      } else if (saved.config) {
        // Write config values to sessionStorage
        for (const [key, value] of Object.entries(saved.config)) {
          try {
            sessionStorage.setItem(
              `block_${newIds[myIdx]}_${key}`,
              JSON.stringify(value),
            )
          } catch {
            // Quota errors should not abort flow import/clone.
          }
        }
      }

      // Recursively import branches
      if (saved.branches && saved.branches.length > 0) {
        block.branches = saved.branches.map((branch) => importChain(branch))
      }

      return block
    })
  }

  const blocks = importChain(flow.blocks)
  return { id: 'default', blocks }
}

// ---- File helpers ----

/** Trigger a JSON file download in the browser. */
export function downloadFlow(flow: SavedFlow) {
  const json = JSON.stringify(flow, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${flow.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.flow.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Open a file picker and return the file contents as a string. */
export function pickFlowFile(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.flow.json'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return reject(new Error('No file selected'))
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('Failed to read file'))
      reader.readAsText(file)
    }
    input.click()
  })
}
