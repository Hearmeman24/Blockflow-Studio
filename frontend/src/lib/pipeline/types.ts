import type { BlockStatus } from '@/lib/status'

export interface PipelineBlock {
  id: string
  type: string
  /** User-defined display name. Falls back to the block type's default label. */
  label?: string
  /** When true, the block is skipped during execution and invisible to the data graph. */
  disabled?: boolean
  /** Source overrides: maps input port name → source block ID.
   *  Used when multiple upstream blocks produce the same port kind. */
  sources?: Record<string, string>
  /** Source fan-in mode per input port. Defaults to closest upstream. */
  sourceModes?: Record<string, SourceMode>
  /** Custom multi-source selection per input port. Used when sourceModes[port] === 'custom'. */
  sourceSelections?: Record<string, string[]>
  /** Branches forking off from this block. Each branch is a linear chain of blocks.
   *  The trunk continues after this block; branches are independent side-paths. */
  branches?: PipelineBlock[][]
  /** Saved data of a block whose type is not registered (an unsupported block).
   *  Carried verbatim so exporting the flow again loses nothing. */
  preserved?: PreservedBlockData
}

export interface PreservedBlockData {
  /** The block's saved `config`, exactly as it was in the flow file. */
  config?: Record<string, unknown>
  /** Saved block fields this version does not understand. */
  extra?: Record<string, unknown>
}

export type SourceMode = 'closest' | 'all' | 'custom'

export interface Pipeline {
  id: string
  blocks: PipelineBlock[]
}

// Declared in `@/lib/status`; re-exported for existing imports.
export type { BlockStatus }

interface BlockStateBase {
  outputs: Record<string, unknown>
  /** The block's status message (e.g. "Generating prompt…"). Cleared on status
   *  change; where each status shows it is `blockStatusDisplay` (block-status-badge). */
  statusMessage?: string
}

/** A block's runtime state. Error text exists only on a block in error
 *  (build one with `blockStateWith` in `./block-state`). */
export type BlockState =
  | (BlockStateBase & { status: 'error'; error?: string })
  | (BlockStateBase & { status: Exclude<BlockStatus, 'error'>; error?: undefined })

// ---- Iteration (multi-item loaders) ----

export type IterationItemStatus = 'pending' | 'running' | 'completed' | 'error' | 'skipped'

export interface IterationItemState {
  index: number
  /** Display label — e.g. filename or "Item 1" */
  label: string
  status: IterationItemStatus
  error?: string
  /** Thumbnail URL for visual identification (optional) */
  thumbnailUrl?: string
}

export interface IterationState {
  /** The iterator block that produced the items */
  blockId: string
  /** Currently executing item index (-1 when not started) */
  currentIndex: number
  totalCount: number
  items: IterationItemState[]
}
