/**
 * The flow a run is saved with: the pipeline as it was when the run started,
 * not as it is when the run ends.
 *
 * The run's block results are built from the blocks the run started with, so
 * the saved flow has to be built from the same blocks, or a block added or
 * removed mid-run shifts every index. Each block's settings are the ones it
 * started with: `started(block)` is called just before the block executes.
 * A block that never starts keeps its settings from the start of the run.
 * Keys a block writes itself while running (`resultConfigKeys`) are read when
 * the flow is exported, after the block wrote them.
 */
import { readGenerationMeta } from '@/lib/image-ref'
import type { BlockResult } from '@/lib/types'
import { exportBlockConfig, exportFlow, type SavedFlow } from './flow-io'
import { getBlockDef } from './registry'
import { walkBlocks } from './tree-utils'
import type { Pipeline, PipelineBlock } from './types'

export interface RunSnapshot {
  /** Record the settings `block` is about to run with. */
  started: (block: PipelineBlock) => void
  /** The saved flow of this run. */
  exportFlow: (name: string) => SavedFlow
}

export function createRunSnapshot(pipeline: Pipeline): RunSnapshot {
  const configs = new Map<string, Record<string, unknown> | undefined>()
  for (const block of walkBlocks(pipeline.blocks)) configs.set(block.id, exportBlockConfig(block))

  const configFor = (block: PipelineBlock): Record<string, unknown> | undefined => {
    const ran = configs.get(block.id)
    const resultKeys = getBlockDef(block.type)?.resultConfigKeys
    if (!resultKeys || resultKeys.length === 0) return ran
    const config: Record<string, unknown> = { ...ran }
    const results = exportBlockConfig(block, resultKeys) ?? {}
    // A result key the block has since cleared is left out, as a live export would.
    for (const key of resultKeys) {
      if (key in results) config[key] = results[key]
    }
    return Object.keys(config).length > 0 ? config : undefined
  }

  return {
    started: (block) => {
      configs.set(block.id, exportBlockConfig(block))
    },
    exportFlow: (name) => exportFlow(pipeline, name, { configFor }),
  }
}

const GENERATED_KINDS = new Set(['image', 'video', 'audio'])
const MAX_VALUE_DEPTH = 16

function isGeneratedRef(value: unknown, depth = 0): boolean {
  if (Array.isArray(value)) return depth < MAX_VALUE_DEPTH && value.some((v) => isGeneratedRef(v, depth + 1))
  return readGenerationMeta(value) !== null
}

/**
 * True if a block's saved outputs hold an image, video or audio made by a
 * generation job (a reference with `meta.job_id`). Loader files, plain URLs and
 * locally edited files do not count. The same rule as `_has_generated_output`
 * in `backend/db.py`, which decides whether an unfinished run is listed.
 */
export function holdsGeneratedOutput(outputs: BlockResult['outputs']): boolean {
  return Object.values(outputs).some((out) => GENERATED_KINDS.has(out.kind) && isGeneratedRef(out.value))
}
