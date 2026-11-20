'use client'

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react'
import {
  type Pipeline,
  type PipelineBlock,
  type BlockStatus,
  type BlockState,
  type IterationState,
  type SourceMode,
} from './types'
import {
  type PortKind,
  type BlockExecuteResult,
  type NodeTypeDef,
  canonicalizePortKind,
  bindingRequiresUpstream,
  getBlockDef,
  getNodeType,
  getValidNextTypes,
  getStarterTypes,
} from './registry'
import { toast } from 'sonner'
import {
  exportFlow as exportFlowIO,
  importFlowWithReport,
  type FlowImportOutcome,
} from './flow-io'
import { findRunBlockingUnsupportedBlocks, formatUnsupportedRunMessage } from './legacy-blocks'
import { createRunSnapshot, holdsGeneratedOutput } from './run-snapshot'
import { selectedSourceIds } from './source-resolution'
import { findRunBlockers, formatRunBlockerMessage } from './run-blockers'
import {
  walkBlocks,
  findBlockInTree,
  findBlockById,
  removeBlockFromTree,
} from './tree-utils'
import { usePipelineTabs, type TabActions } from './tabs-context'
import { saveRun } from '@/lib/api'
import type { BlockResult, RunEntry } from '@/lib/types'
import { hasPendingJobRunForBlock } from './job-pending'
import { blockStateWith, interruptRunningBlocks, sanitizeBlockState, type RunningBlockEnd } from './block-state'
import { deriveRunStatus, savedBlockStatus, shouldSaveRun } from './run-outcome'
import { abortPoll, hasActivePoll, subscribePolls } from './job-poller'
import {
  canStartRun,
  initialRunPhase,
  isCurrentRun,
  runtimeOf,
  tabRunOf,
  transitionRun,
  type RunEvent,
  type RunPhase,
} from './run-phase'

// ---- Persistence (sessionStorage, keyed by tabId) ----

const PIPELINE_PREFIX = 'pipeline_v2_'
const PIPELINE_RUNTIME_PREFIX = 'pipeline_runtime_v2_'

const EMPTY_PIPELINE: Pipeline = { id: 'default', blocks: [] }

function loadPipeline(tabId: string): Pipeline {
  if (typeof window === 'undefined') return EMPTY_PIPELINE
  try {
    const raw = sessionStorage.getItem(`${PIPELINE_PREFIX}${tabId}`)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed.steps && !parsed.blocks) {
        parsed.blocks = parsed.steps
        delete parsed.steps
      }
      return parsed
    }
  } catch { /* ignore */ }
  return EMPTY_PIPELINE
}

function savePipeline(tabId: string, pipeline: Pipeline) {
  try {
    sessionStorage.setItem(`${PIPELINE_PREFIX}${tabId}`, JSON.stringify(pipeline))
  } catch { /* quota exceeded */ }
}

export interface PersistedPipelineRuntime {
  blockStates: Array<[string, BlockState]>
  isRunning: boolean
  runningBlockId: string | null
}

export function normalizeRecoveredRuntime(
  runtime: PersistedPipelineRuntime,
  tabMarkedRunning: boolean,
): PersistedPipelineRuntime {
  // Check only this tab's blocks for pending polling runs (not global)
  const hasPendingJobs = !tabMarkedRunning && runtime.blockStates.some(([id]) => hasPendingJobRunForBlock(id))
  if (tabMarkedRunning || hasPendingJobs) {
    // Jobs to rejoin: the tab resumes. A block nothing finishes is ended when
    // the resume settles (`interruptRunningBlocks`).
    if (runtime.isRunning) return runtime
    const firstRunning = runtime.blockStates.find(([, state]) => state.status === 'running')
    return {
      ...runtime,
      isRunning: true,
      runningBlockId: runtime.runningBlockId ?? firstRunning?.[0] ?? null,
    }
  }

  // Nothing to rejoin: a block still running was interrupted by the reload,
  // whether or not the run was still marked running when it was stored.
  return {
    blockStates: [...interruptRunningBlocks(new Map(runtime.blockStates), 'interrupted')],
    isRunning: false,
    runningBlockId: null,
  }
}

function loadPipelineRuntime(tabId: string): PersistedPipelineRuntime {
  if (typeof window === 'undefined') {
    return { blockStates: [], isRunning: false, runningBlockId: null }
  }
  try {
    const raw = sessionStorage.getItem(`${PIPELINE_RUNTIME_PREFIX}${tabId}`)
    if (!raw) return { blockStates: [], isRunning: false, runningBlockId: null }
    const parsed = JSON.parse(raw) as {
      blockStates?: unknown
      isRunning?: unknown
      runningBlockId?: unknown
    }

    // States from this build or another one: an unknown status loads as idle.
    const entries: Array<[string, BlockState]> = []
    for (const entry of Array.isArray(parsed.blockStates) ? parsed.blockStates : []) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue
      const state = sanitizeBlockState(entry[1])
      if (state) entries.push([entry[0], state])
    }

    return {
      blockStates: entries,
      isRunning: parsed.isRunning === true,
      runningBlockId: typeof parsed.runningBlockId === 'string' ? parsed.runningBlockId : null,
    }
  } catch {
    return { blockStates: [], isRunning: false, runningBlockId: null }
  }
}

function savePipelineRuntime(tabId: string, runtime: PersistedPipelineRuntime) {
  try {
    sessionStorage.setItem(`${PIPELINE_RUNTIME_PREFIX}${tabId}`, JSON.stringify(runtime))
  } catch {
    // quota exceeded
  }
}

// ---- Accumulator types ----

interface AccumulatorEntry {
  blockId: string
  value: unknown
}

/** Multi-source accumulator: PortKind → list of upstream producers (in pipeline order) */
type Accumulator = Map<string, AccumulatorEntry[]>

/** The outputs each downstream block made for one iterator item, by block id. */
type ItemOutputs = Map<string, Record<string, unknown>>

/** How an iterator's last iteration ended: the items, and the outputs of each item that completed. */
interface IterationRecord {
  items: unknown[]
  /** By item index; null for an item that failed, was cancelled or was not reached. */
  completed: Array<ItemOutputs | null>
}

/** How one chain (with the branches it launched) ended: the first block error, if any. */
interface ChainOutcome {
  error: string | null
}

function sameItems(a: unknown[], b: unknown[]): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

// ---- Upstream producer info (for source selector UI) ----

export interface UpstreamProducer {
  blockId: string
  blockIndex: number
  blockLabel: string
}

/** A block whose input port reads a given block's output. */
export interface DownstreamConsumer {
  blockId: string
  type: string
  /** The block's own label, or its type's label. */
  label: string
  portName: string
}

/** An upstream producer plus its current output value, tagged by blockId. */
export interface UpstreamProducerValue extends UpstreamProducer {
  value: unknown
}

// ---- Context ----

type ExecuteFn = (inputs: Record<string, unknown>, signal: AbortSignal) => Promise<void | BlockExecuteResult>

/** Two animation frames, so React can paint forwarded outputs; a cancel ends the wait at once. */
function waitForPaint(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    let frame = 0
    function finish() {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    function onAbort() {
      cancelAnimationFrame(frame)
      finish()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(finish)
    })
  })
}

function findLastEnabledIndex(blocks: PipelineBlock[], maxExclusive: number): number {
  for (let i = Math.min(maxExclusive, blocks.length) - 1; i >= 0; i--) {
    if (!blocks[i].disabled) return i
  }
  return -1
}

function getAdvertisedOutputKinds(
  blocks: PipelineBlock[],
  index: number,
  hints?: Record<string, string>,
): Set<PortKind> {
  if (index < 0 || index >= blocks.length) return new Set()
  const block = blocks[index]
  const def = getNodeType(block.type)
  if (!def || def.outputs.length === 0) return new Set()

  // HITL is a passthrough: constrain addable-next suggestions to whatever
  // kind reached the block immediately before it.
  if (block.type === 'hitl') {
    const prevIdx = findLastEnabledIndex(blocks, index)
    if (prevIdx < 0) return new Set()
    return getAdvertisedOutputKinds(blocks, prevIdx, hints)
  }

  if (hints) {
    const hintedPort = hints[block.id]
    if (hintedPort) {
      const matchingPorts = def.outputs.filter((port) => port.name === hintedPort)
      if (matchingPorts.length > 0) {
        return new Set(matchingPorts.map((port) => canonicalizePortKind(port.kind)))
      }
    }
  }

  return new Set(def.outputs.map((port) => canonicalizePortKind(port.kind)))
}

function getRequiredInputNames(type: string): Set<string> {
  const def = getNodeType(type)
  if (!def) return new Set()

  const required = new Set(
    def.inputs
      .filter((input) => input.required !== false)
      .map((input) => input.name),
  )

  const blockDef = getBlockDef(type)
  for (const binding of blockDef?.bindings ?? []) {
    if (bindingRequiresUpstream(binding)) {
      required.add(binding.input)
    }
  }

  return required
}

interface PipelineContextValue {
  pipeline: Pipeline
  /** Returns the id of the newly created block (the primary one, not auto-inserted prereqs). */
  addBlock: (type: string, atIndex?: number) => string
  removeBlock: (blockId: string) => void
  /** Per-tab block selection — drives keyboard navigation + the canvas ring. */
  selectedBlockId: string | null
  setSelectedBlockId: (id: string | null) => void
  setBlockLabel: (blockId: string, label: string) => void
  blockStates: Map<string, BlockState>
  setBlockOutput: (blockId: string, portName: string, value: unknown) => void
  setBlockStatus: (blockId: string, status: BlockStatus, error?: string) => void
  setBlockStatusMessage: (blockId: string, message: string | undefined) => void
  getInputsForBlock: (blockId: string) => Record<string, unknown>
  isBlockReady: (blockId: string) => boolean
  /** Get block types valid at a specific position (index where block would be inserted).
   *  If no position given, defaults to end of pipeline. */
  getAddableTypes: (atIndex?: number) => NodeTypeDef[]
  registerBlockExecute: (blockId: string, fn: ExecuteFn) => void
  /** Hint which output port is active for a block (narrows add-block menu). */
  setOutputHint: (blockId: string, activePortName: string) => void
  runPipeline: (opts?: { continueFromExisting?: boolean }) => Promise<{ hadError: boolean }>
  cancelPipeline: () => void
  /** Whether any block has completed outputs from a previous run (enables "Continue" mode). */
  hasCompletedBlocks: boolean
  isRunning: boolean
  runningBlockId: string | null
  /** Set which upstream block feeds a specific input port */
  setBlockSource: (blockId: string, portName: string, sourceBlockId: string) => void
  /** Set whether an input reads the closest, all, or custom-selected upstream producers. */
  setBlockSourceMode: (blockId: string, portName: string, mode: SourceMode) => void
  /** Set custom upstream producer IDs for an input port. */
  setBlockSourceSelection: (blockId: string, portName: string, sourceBlockIds: string[]) => void
  /** Clear explicit source override for an input port (falls back to nearest producer). */
  clearBlockSource: (blockId: string, portName: string) => void
  /** Reset runtime state for a block and all downstream blocks in its chain/branches. */
  resetRuntimeFromBlock: (blockId: string, opts?: { preserveOutputHint?: boolean }) => void
  /** Get all upstream blocks that produce a given port kind, for a given block */
  getUpstreamProducers: (blockId: string, portKind: PortKind) => UpstreamProducer[]
  /** The upstream producers an input port reads, by its source mode (closest / all / custom). */
  getPortSources: (blockId: string, portName: string) => UpstreamProducer[]
  /** Enabled blocks whose input of this kind reads `blockId`'s output. */
  getDownstreamConsumers: (blockId: string, portKind: PortKind) => DownstreamConsumer[]
  /** Like getUpstreamProducers, but each entry also carries the producer's current output value (tagged by blockId). */
  getUpstreamProducerValues: (blockId: string, portKind: PortKind) => UpstreamProducerValue[]
  /** Whether any block has unsatisfied required inputs */
  hasMissingRequired: boolean
  /** Import a flow from a JSON string (no file picker). On failure the current
   *  pipeline is left untouched and the outcome carries the error. */
  importFlowJson: (json: string) => FlowImportOutcome
  /** Toggle a block's disabled state (skipped during execution). */
  toggleBlockDisabled: (blockId: string) => void
  /** Export the current pipeline as a flow JSON string. */
  exportFlowJson: (name?: string) => string
  /** Add an empty branch forking from a block. */
  addBranch: (forkBlockId: string) => void
  /** Insert a block directly before or after another; returns its id, or null when the anchor is gone. */
  insertBlockAdjacent: (anchorId: string, position: 'before' | 'after', type: string, config?: Record<string, unknown>) => string | null
  /** Add a block to a specific branch of a fork block. */
  /** Returns the id of the newly added block. */
  addBlockToBranch: (forkBlockId: string, branchIndex: number, type: string, atIndex?: number) => string
  /** Remove an entire branch from a fork block. */
  removeBranch: (forkBlockId: string, branchIndex: number) => void
  /** Get valid block types for a position within a branch. */
  getAddableTypesForBranch: (ancestors: PipelineBlock[], chain: PipelineBlock[], atIndex?: number) => NodeTypeDef[]
  /** The progress of each iteration in this run, by iterator block id (empty when no run is in flight). */
  iterationStates: ReadonlyMap<string, IterationState>
  /** Whether this tab's pipeline is running in loop mode. */
  isLooping: boolean
}

const PipelineCtx = createContext<PipelineContextValue | null>(null)

function newBlockIdFor(): string {
  return `block-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Insert `block` into `chain` at `index`, preceded by the block types its
 * definition lists in `starterPrereqs` (a generation block's loaders). A
 * prerequisite is skipped when an enabled block directly upstream already has
 * that type, or lists it in `satisfiesPrereqs`, because it is then the closest
 * source. "Directly upstream" is the unbroken run of enabled blocks before the
 * insert point that each supply one of the prerequisites (the previous blocks
 * in the chain, then the fork block for a branch); for a block with one
 * prerequisite that is the block right before it. Mutates `chain`.
 */
function insertWithPrereqs(chain: PipelineBlock[], index: number, fork: PipelineBlock | null, block: PipelineBlock, prereqIds: string[]) {
  const prereqs = getBlockDef(block.type)?.starterPrereqs ?? []
  const supplied = new Set<string>()
  for (let i = index - 1; i >= -1; i--) {
    const upstream = i >= 0 ? chain[i] : fork
    if (!upstream || upstream.disabled) break
    const supplies = [upstream.type, ...(getBlockDef(upstream.type)?.satisfiesPrereqs ?? [])].filter((type) => prereqs.includes(type))
    if (supplies.length === 0) break
    supplies.forEach((type) => supplied.add(type))
  }
  const missing = prereqs.filter((type) => !supplied.has(type))
  const inserted: PipelineBlock[] = missing.map((type, i) => ({ id: prereqIds[i], type }))
  chain.splice(index, 0, ...inserted, block)
}

/** Ids for a block's prerequisites, made outside the state updater so a re-run of the updater yields the same tree. */
function prereqIdsFor(type: string): string[] {
  return (getBlockDef(type)?.starterPrereqs ?? []).map(() => newBlockIdFor())
}

export function usePipeline() {
  const ctx = useContext(PipelineCtx)
  if (!ctx) throw new Error('usePipeline must be used within PipelineProvider')
  return ctx
}

export function useOptionalPipeline() {
  return useContext(PipelineCtx)
}

// ---- Provider ----

interface PipelineProviderProps {
  tabId: string
  /** SavedFlow JSON to import on first mount. */
  flowJson?: string
  children: ReactNode
}

export function PipelineProvider({ tabId, flowJson, children }: PipelineProviderProps) {
  const { registerTabActions, unregisterTabActions, publishTabRun, setTabRuntimeInfo, tabRunStates, loopingTabs } = usePipelineTabs()
  const tabMarkedRunning = (tabRunStates[tabId] ?? 'idle') === 'running'
  // Read once, on mount.
  const [initialRuntime] = useState<PersistedPipelineRuntime>(
    () => normalizeRecoveredRuntime(loadPipelineRuntime(tabId), tabMarkedRunning),
  )
  // The tab's run lifecycle: one phase, changed only by `dispatchRun`. A
  // recovered runtime that is still running resumes the jobs a reload found.
  const [runPhase, setRunPhase] = useState<RunPhase>(() => initialRunPhase(
    initialRuntime,
    initialRuntime.blockStates.map(([id]) => id).filter(hasPendingJobRunForBlock),
  ))
  const runPhaseRef = useRef<RunPhase>(runPhase)
  const lastRunIdRef = useRef(0)
  const { isRunning, runningBlockId } = runtimeOf(runPhase)
  const [pipeline, setPipeline] = useState<Pipeline>(() => {
    // If flowJson provided, import it immediately. Callers that open flows
    // validate and report first (tabs-context); an unreadable flow here falls
    // back to the tab's stored pipeline rather than throwing during render.
    if (flowJson) {
      const imported = importFlowWithReport(flowJson)
      if (imported.ok) {
        savePipeline(tabId, imported.pipeline)
        return imported.pipeline
      }
    }
    return loadPipeline(tabId)
  })
  const [blockStates, setBlockStates] = useState<Map<string, BlockState>>(
    () => new Map(initialRuntime.blockStates),
  )
  // The progress of every iteration in flight, by iterator block id: iterators
  // in parallel branches or nested in each other each keep their own.
  const [iterationStates, setIterationStates] = useState<ReadonlyMap<string, IterationState>>(() => new Map())
  // How each iterator's last iteration ended, by iterator block id, so a
  // Continue run re-runs only the items that did not complete. In memory only.
  const iterationRecordsRef = useRef<Map<string, IterationRecord>>(new Map())
  // Per-tab block selection. Local state only — not persisted; clears
  // automatically when a block is removed from the tree.
  const [selectedBlockId, setSelectedBlockIdState] = useState<string | null>(null)
  const setSelectedBlockId = useCallback((id: string | null) => {
    setSelectedBlockIdState(id)
  }, [])
  const pipelineRef = useRef(pipeline)
  const blockStatesRef = useRef(blockStates)
  const executeFns = useRef<Map<string, ExecuteFn>>(new Map())
  /** Map of blockId → active output port name (e.g. 'image'). Used to narrow add-block menu. */
  const [outputHints, setOutputHints] = useState<Record<string, string>>({})

  const persistRuntimeSnapshot = useCallback(
    (nextBlockStates: Map<string, BlockState>, phase: RunPhase = runPhaseRef.current) => {
      savePipelineRuntime(tabId, {
        blockStates: Array.from(nextBlockStates.entries()),
        ...runtimeOf(phase),
      })
    },
    [tabId],
  )

  /**
   * The only writer of the run phase. Persists the derived runtime and
   * publishes the tab bar's run state from the same phase, so they agree.
   * Returns the phase after the event (unchanged when it did not apply).
   */
  const dispatchRun = useCallback((event: RunEvent): RunPhase => {
    const prev = runPhaseRef.current
    const next = transitionRun(prev, event)
    if (next === prev) return prev
    runPhaseRef.current = next
    setRunPhase(next)
    persistRuntimeSnapshot(blockStatesRef.current, next)
    const before = tabRunOf(prev)
    const after = tabRunOf(next)
    if (before.state !== after.state || before.outcome !== after.outcome) publishTabRun(tabId, after)
    return next
  }, [persistRuntimeSnapshot, publishTabRun, tabId])

  // Publish the phase the tab starts in (running when a reload resumed jobs).
  useEffect(() => {
    publishTabRun(tabId, tabRunOf(runPhaseRef.current))
  }, [publishTabRun, tabId])

  // When a resume ends, a block still running has nothing left to finish it.
  // A resumed block reports its own end in a promise callback after its poll
  // ends, so the sweep waits one task and then ends only what is left.
  const leftoverSweepRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const endLeftoverRunningBlocks = useCallback((end: RunningBlockEnd) => {
    if (leftoverSweepRef.current) clearTimeout(leftoverSweepRef.current)
    leftoverSweepRef.current = setTimeout(() => {
      leftoverSweepRef.current = null
      // A run started since then owns the block states.
      if (runPhaseRef.current.kind !== 'idle') return
      const next = interruptRunningBlocks(blockStatesRef.current, end)
      if (next === blockStatesRef.current) return
      blockStatesRef.current = next
      setBlockStates(next)
      persistRuntimeSnapshot(next)
    }, 0)
  }, [persistRuntimeSnapshot])
  useEffect(() => () => {
    if (leftoverSweepRef.current) clearTimeout(leftoverSweepRef.current)
  }, [])

  // A resume ends when none of the blocks it tracks still polls or holds a
  // pending job: each poll ends on success, failure or cancel.
  const resuming = runPhase.kind === 'resuming'
  useEffect(() => {
    if (!resuming) return
    const settleIfDone = () => {
      const phase = runPhaseRef.current
      if (phase.kind !== 'resuming') return
      if (phase.blockIds.some((id) => hasActivePoll(id) || hasPendingJobRunForBlock(id))) return
      dispatchRun({ type: 'resumeSettled' })
      endLeftoverRunningBlocks('interrupted')
    }
    settleIfDone()
    return subscribePolls(settleIfDone)
  }, [dispatchRun, endLeftoverRunningBlocks, resuming])

  // Wrapper that updates the ref + sessionStorage synchronously so callbacks
  // reading pipelineRef.current during the same render cycle see fresh data.
  const updatePipeline = useCallback((updater: (prev: Pipeline) => Pipeline) => {
    setPipeline((prev) => {
      const next = updater(prev)
      pipelineRef.current = next
      savePipeline(tabId, next)
      return next
    })
  }, [tabId])

  useEffect(() => {
    pipelineRef.current = pipeline
  }, [pipeline])

  useEffect(() => {
    blockStatesRef.current = blockStates
  }, [blockStates])

  useEffect(() => {
    savePipelineRuntime(tabId, {
      blockStates: Array.from(blockStates.entries()),
      isRunning,
      runningBlockId,
    })
  }, [tabId, blockStates, isRunning, runningBlockId])

  // Build accumulator from a block's ancestors (tree-aware)
  const buildAccumulatorFromAncestors = useCallback(
    (ancestors: PipelineBlock[], states: Map<string, BlockState>): Accumulator => {
      const acc: Accumulator = new Map()
      for (const block of ancestors) {
        if (block.disabled) continue
        const state = states.get(block.id)
        if (!state) continue
        const def = getNodeType(block.type)
        if (!def) continue
        for (const port of def.outputs) {
          if (state.outputs[port.name] !== undefined) {
            const kind = canonicalizePortKind(port.kind)
            const entries = acc.get(kind) ?? []
            entries.push({ blockId: block.id, value: state.outputs[port.name] })
            acc.set(kind, entries)
          }
        }
      }
      return acc
    },
    [],
  )

  // Build a lightweight producer map from a block's ancestors (tree-aware)
  // Include pipeline.blocks in deps so consumers re-evaluate after structural changes
  const buildProducerMapFromAncestors = useCallback(
    (ancestors: PipelineBlock[]): Map<string, UpstreamProducer[]> => {
      const map = new Map<string, UpstreamProducer[]>()
      for (let i = 0; i < ancestors.length; i++) {
        const block = ancestors[i]
        if (block.disabled) continue
        const def = getNodeType(block.type)
        if (!def) continue
        const outputKinds = getAdvertisedOutputKinds(
          ancestors,
          i,
          outputHints,
        )
        for (const kind of outputKinds) {
          const entries = map.get(kind) ?? []
          entries.push({ blockId: block.id, blockIndex: i, blockLabel: block.label || def.label })
          map.set(kind, entries)
        }
      }
      return map
    },
    [outputHints, pipeline.blocks],
  )

  // Resolve a single input port value from the accumulator, respecting source overrides
  const resolvePort = (
    block: PipelineBlock,
    portName: string,
    portKind: string,
    acc: Accumulator,
    producerMap: Map<string, UpstreamProducer[]>,
  ): unknown | undefined => {
    const canonicalKind = canonicalizePortKind(portKind as PortKind)
    const entries = acc.get(canonicalKind)
    const producers = producerMap.get(canonicalKind) ?? []
    const sourceMode = block.sourceModes?.[portName] ?? 'closest'

    if (sourceMode === 'all') {
      if (!entries || entries.length === 0) return undefined
      return entries.map((entry) => entry.value)
    }

    if (sourceMode === 'custom') {
      const selectedIds = block.sourceSelections?.[portName] ?? []
      if (selectedIds.length === 0) return undefined
      if (!entries || entries.length === 0) return undefined

      const values: unknown[] = []
      for (const sourceId of selectedIds) {
        const entry = entries.find((candidate) => candidate.blockId === sourceId)
        if (!entry) return undefined
        values.push(entry.value)
      }
      return values
    }

    // Source resolution priority:
    // 1) Explicit source override chosen by user.
    // 2) Implicit default source = closest upstream producer (same as dropdown default).
    const preferredSourceId = block.sources?.[portName] ?? producers[producers.length - 1]?.blockId
    if (preferredSourceId) {
      if (!entries || entries.length === 0) return undefined
      const entry = entries.find((e) => e.blockId === preferredSourceId)
      // Strict source selection: do not fall back to older producers when
      // the preferred source has not emitted output yet.
      return entry?.value
    }

    if (!entries || entries.length === 0) return undefined

    // Default: last (closest upstream) producer
    return entries[entries.length - 1].value
  }

  // Resolve inputs for a block from a given states snapshot (tree-aware)
  const resolveInputsForBlocks = useCallback(
    (
      blocks: PipelineBlock[],
      blockId: string,
      states: Map<string, BlockState>,
    ): Record<string, unknown> => {
      const location = findBlockInTree(blocks, blockId)
      if (!location) return {}
      const block = location.chain[location.index]
      const def = getNodeType(block.type)
      if (!def) return {}
      const acc = buildAccumulatorFromAncestors(location.ancestors, states)
      const producerMap = buildProducerMapFromAncestors(location.ancestors)
      const inputs: Record<string, unknown> = {}
      for (const port of def.inputs) {
        const val = resolvePort(block, port.name, port.kind, acc, producerMap)
        if (val !== undefined) inputs[port.name] = val
      }
      return inputs
    },
    [buildAccumulatorFromAncestors, buildProducerMapFromAncestors],
  )

  const resolveInputs = useCallback(
    (blockId: string, states: Map<string, BlockState>): Record<string, unknown> => {
      return resolveInputsForBlocks(pipelineRef.current.blocks, blockId, states)
    },
    [resolveInputsForBlocks],
  )

  const getInputsForBlock = useCallback(
    (blockId: string): Record<string, unknown> => {
      return resolveInputsForBlocks(pipeline.blocks, blockId, blockStatesRef.current)
    },
    [pipeline.blocks, resolveInputsForBlocks],
  )

  // Check if a block has all required inputs satisfied by upstream producers (tree-aware)
  const isBlockReady = useCallback(
    (blockId: string): boolean => {
      const location = findBlockInTree(pipeline.blocks, blockId)
      if (!location) return false
      const def = getNodeType(location.chain[location.index].type)
      if (!def) return false
      if (def.inputs.length === 0) return true

      const producerMap = buildProducerMapFromAncestors(location.ancestors)
      const requiredInputNames = getRequiredInputNames(location.chain[location.index].type)
      const requiredInputs = def.inputs.filter((p) => requiredInputNames.has(p.name))
      return requiredInputs.every((port) => {
        const producers = producerMap.get(canonicalizePortKind(port.kind))
        return producers && producers.length > 0
      })
    },
    [buildProducerMapFromAncestors, pipeline.blocks],
  )

  const getUpstreamProducers = useCallback(
    (blockId: string, portKind: PortKind): UpstreamProducer[] => {
      const location = findBlockInTree(pipeline.blocks, blockId)
      if (!location) return []
      const producerMap = buildProducerMapFromAncestors(location.ancestors)
      return producerMap.get(canonicalizePortKind(portKind)) ?? []
    },
    [buildProducerMapFromAncestors, pipeline.blocks],
  )

  // The producers an input port actually reads, by its source mode.
  const getPortSources = useCallback(
    (blockId: string, portName: string): UpstreamProducer[] => {
      const location = findBlockInTree(pipeline.blocks, blockId)
      if (!location) return []
      const block = location.chain[location.index]
      const port = getNodeType(block.type)?.inputs.find((p) => p.name === portName)
      if (!port) return []
      const producers = buildProducerMapFromAncestors(location.ancestors).get(canonicalizePortKind(port.kind)) ?? []
      const ids = selectedSourceIds(block, portName, producers.map((p) => p.blockId))
      return ids.map((id) => producers.find((p) => p.blockId === id)).filter((p): p is UpstreamProducer => Boolean(p))
    },
    [buildProducerMapFromAncestors, pipeline.blocks],
  )

  // The inverse of getPortSources: enabled blocks whose input of this kind
  // reads `blockId`. A disabled block is skipped with its branches, as the
  // runner does.
  const getDownstreamConsumers = useCallback(
    (blockId: string, portKind: PortKind): DownstreamConsumer[] => {
      const kind = canonicalizePortKind(portKind)
      const out: DownstreamConsumer[] = []
      const visit = (chain: PipelineBlock[]) => {
        for (const block of chain) {
          if (block.disabled) continue
          if (block.id !== blockId) {
            const def = getNodeType(block.type)
            for (const port of def?.inputs ?? []) {
              if (canonicalizePortKind(port.kind) !== kind) continue
              if (getPortSources(block.id, port.name).some((p) => p.blockId === blockId)) {
                out.push({ blockId: block.id, type: block.type, label: block.label || def!.label, portName: port.name })
              }
            }
          }
          for (const branch of block.branches ?? []) visit(branch)
        }
      }
      visit(pipeline.blocks)
      return out
    },
    [getPortSources, pipeline.blocks],
  )

  // Like getUpstreamProducers, but joins each producer with its current output
  // value from the accumulator. The resolved inputs.<port> array drops which
  // block produced which value; consumers that need per-source routing (e.g.
  // per-segment prompt sourcing) use this to address values by blockId.
  const getUpstreamProducerValues = useCallback(
    (blockId: string, portKind: PortKind): UpstreamProducerValue[] => {
      const location = findBlockInTree(pipeline.blocks, blockId)
      if (!location) return []
      const canonicalKind = canonicalizePortKind(portKind)
      const producers = buildProducerMapFromAncestors(location.ancestors).get(canonicalKind) ?? []
      const entries = buildAccumulatorFromAncestors(location.ancestors, blockStatesRef.current).get(canonicalKind) ?? []
      const valueByBlockId = new Map(entries.map((e) => [e.blockId, e.value]))
      return producers.map((p) => ({ ...p, value: valueByBlockId.get(p.blockId) }))
    },
    [buildAccumulatorFromAncestors, buildProducerMapFromAncestors, pipeline.blocks],
  )

  const addBlock = useCallback((type: string, atIndex?: number): string => {
    const newBlockId = newBlockIdFor()
    const prereqIds = prereqIdsFor(type)
    updatePipeline((prev) => {
      const blocks = [...prev.blocks]
      const insertAt = Math.min(atIndex ?? blocks.length, blocks.length)
      insertWithPrereqs(blocks, insertAt, null, { id: newBlockId, type }, prereqIds)
      return { ...prev, blocks }
    })
    return newBlockId
  }, [updatePipeline])

  // Insert a block directly before or after another one, in the same chain.
  // Optional config is written to the new block's keys first, as flow import does.
  const insertBlockAdjacent = useCallback(
    (anchorId: string, position: 'before' | 'after', type: string, config?: Record<string, unknown>): string | null => {
      if (!findBlockInTree(pipelineRef.current.blocks, anchorId)) return null
      const id = newBlockIdFor()
      for (const [key, value] of Object.entries(config ?? {})) {
        try {
          sessionStorage.setItem(`block_${id}_${key}`, JSON.stringify(value))
        } catch {
          // storage full: the block still appears, empty
        }
      }
      updatePipeline((prev) => {
        const next = structuredClone(prev)
        const location = findBlockInTree(next.blocks, anchorId)
        if (!location) return prev
        location.chain.splice(position === 'before' ? location.index : location.index + 1, 0, { id, type })
        return next
      })
      return id
    },
    [updatePipeline],
  )

  const removeBlock = useCallback((blockId: string) => {
    // Collect all block IDs being removed (the target + any blocks in its branches)
    const location = findBlockInTree(pipelineRef.current.blocks, blockId)
    const idsToClean = new Set<string>()
    if (location) {
      const block = location.chain[location.index]
      for (const b of walkBlocks([block])) idsToClean.add(b.id)
    }

    updatePipeline((prev) => {
      const next = structuredClone(prev)
      removeBlockFromTree(next.blocks, blockId)
      return next
    })
    setBlockStates((prev) => {
      const next = new Map(prev)
      for (const id of idsToClean) next.delete(id)
      blockStatesRef.current = next
      persistRuntimeSnapshot(next)
      return next
    })
    for (const id of idsToClean) {
      executeFns.current.delete(id)
      setOutputHints((prev) => {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
    }
    // Clear selection if the selected block was just removed.
    setSelectedBlockIdState((prev) => (prev && idsToClean.has(prev) ? null : prev))
  }, [persistRuntimeSnapshot, updatePipeline])

  const toggleBlockDisabled = useCallback((blockId: string) => {
    updatePipeline((prev) => {
      const next = structuredClone(prev)
      const block = findBlockById(next.blocks, blockId)
      if (!block) return prev
      block.disabled = !block.disabled
      return next
    })
  }, [updatePipeline])

  const setBlockLabel = useCallback((blockId: string, label: string) => {
    updatePipeline((prev) => {
      const next = structuredClone(prev)
      const block = findBlockById(next.blocks, blockId)
      if (!block) return prev
      block.label = label || undefined
      return next
    })
  }, [updatePipeline])

  const setBlockOutput = useCallback(
    (blockId: string, portName: string, value: unknown) => {
      // Update ref synchronously so pipeline runner can read outputs immediately
      // (React state updates are batched and won't flush mid-pipeline)
      const prev = blockStatesRef.current
      const existing = prev.get(blockId) ?? { status: 'idle' as const, outputs: {} }
      const prevValue = existing.outputs[portName]
      if (Object.is(prevValue, value)) return

      const next = new Map(prev)
      next.set(blockId, {
        ...existing,
        outputs: { ...existing.outputs, [portName]: value },
      })
      blockStatesRef.current = next
      setBlockStates(next)
      persistRuntimeSnapshot(next)
    },
    [persistRuntimeSnapshot],
  )

  const setBlockStatus = useCallback(
    (blockId: string, status: BlockStatus, error?: string) => {
      // Update ref synchronously so rapid status changes aren't lost to batching
      const prev = blockStatesRef.current
      const existing = prev.get(blockId) ?? { status: 'idle' as const, outputs: {} }
      // Error text belongs to an error status only.
      const nextError = status === 'error' ? error ?? undefined : undefined
      if (
        existing.status === status &&
        (existing.error ?? undefined) === nextError &&
        existing.statusMessage === undefined
      ) {
        return
      }

      const next = new Map(prev)
      next.set(blockId, blockStateWith(status, existing.outputs, nextError))
      blockStatesRef.current = next
      setBlockStates(next)
      persistRuntimeSnapshot(next)
    },
    [persistRuntimeSnapshot],
  )

  const setBlockStatusMessage = useCallback(
    (blockId: string, message: string | undefined) => {
      const prev = blockStatesRef.current
      const existing = prev.get(blockId) ?? { status: 'idle' as const, outputs: {} }
      if (existing.statusMessage === message) return

      const next = new Map(prev)
      next.set(blockId, { ...existing, statusMessage: message })
      blockStatesRef.current = next
      setBlockStates(next)
      persistRuntimeSnapshot(next)
    },
    [persistRuntimeSnapshot],
  )

  const setBlockSource = useCallback(
    (blockId: string, portName: string, sourceBlockId: string) => {
      updatePipeline((prev) => {
        const next = structuredClone(prev)
        const block = findBlockById(next.blocks, blockId)
        if (!block) return prev
        block.sources = { ...block.sources, [portName]: sourceBlockId }
        return next
      })
    },
    [updatePipeline],
  )

  const setBlockSourceMode = useCallback(
    (blockId: string, portName: string, mode: SourceMode) => {
      updatePipeline((prev) => {
        const next = structuredClone(prev)
        const block = findBlockById(next.blocks, blockId)
        if (!block) return prev
        if (mode === 'closest') {
          if (!block.sourceModes?.[portName]) return prev
          const sourceModes = { ...block.sourceModes }
          delete sourceModes[portName]
          if (Object.keys(sourceModes).length === 0) delete block.sourceModes
          else block.sourceModes = sourceModes
          return next
        }
        block.sourceModes = { ...block.sourceModes, [portName]: mode }
        return next
      })
    },
    [updatePipeline],
  )

  const setBlockSourceSelection = useCallback(
    (blockId: string, portName: string, sourceBlockIds: string[]) => {
      updatePipeline((prev) => {
        const next = structuredClone(prev)
        const block = findBlockById(next.blocks, blockId)
        if (!block) return prev

        const uniqueIds = Array.from(new Set(sourceBlockIds))
        if (uniqueIds.length === 0) {
          if (!block.sourceSelections?.[portName]) return prev
          const sourceSelections = { ...block.sourceSelections }
          delete sourceSelections[portName]
          if (Object.keys(sourceSelections).length === 0) delete block.sourceSelections
          else block.sourceSelections = sourceSelections
          return next
        }

        block.sourceSelections = { ...block.sourceSelections, [portName]: uniqueIds }
        return next
      })
    },
    [updatePipeline],
  )

  const clearBlockSource = useCallback(
    (blockId: string, portName: string) => {
      updatePipeline((prev) => {
        const next = structuredClone(prev)
        const block = findBlockById(next.blocks, blockId)
        if (!block?.sources?.[portName]) return prev
        const sources = { ...block.sources }
        delete sources[portName]
        if (Object.keys(sources).length === 0) delete block.sources
        else block.sources = sources
        return next
      })
    },
    [updatePipeline],
  )

  const resetRuntimeFromBlock = useCallback(
    (blockId: string, opts?: { preserveOutputHint?: boolean }) => {
      const location = findBlockInTree(pipeline.blocks, blockId)
      if (!location) return

      const idsToReset = new Set<string>()
      for (const downstreamBlock of location.chain.slice(location.index)) {
        for (const nested of walkBlocks([downstreamBlock])) {
          idsToReset.add(nested.id)
        }
      }

      const next = new Map(blockStatesRef.current)
      for (const id of idsToReset) {
        next.set(id, { status: 'idle', outputs: {} })
      }

      blockStatesRef.current = next
      setBlockStates(next)
      persistRuntimeSnapshot(next)
      // A reset block's earlier items no longer stand: Continue runs every item again.
      iterationRecordsRef.current.clear()
      setOutputHints((prev) => {
        const next = { ...prev }
        for (const id of idsToReset) {
          if (!opts?.preserveOutputHint || id !== blockId) {
            delete next[id]
          }
        }
        return next
      })
    },
    [persistRuntimeSnapshot, pipeline.blocks],
  )

  const registerBlockExecute = useCallback(
    (blockId: string, fn: ExecuteFn) => {
      executeFns.current.set(blockId, fn)
    },
    [],
  )

  const setOutputHint = useCallback(
    (blockId: string, activePortName: string) => {
      setOutputHints((prev) => {
        const currentHint = prev[blockId] ?? ''
        if (currentHint === activePortName) return prev
        if (!activePortName) {
          if (!(blockId in prev)) return prev
          const next = { ...prev }
          delete next[blockId]
          return next
        }
        return { ...prev, [blockId]: activePortName }
      })
    },
    [],
  )

  const cancelPipeline = useCallback(() => {
    const phase = runPhaseRef.current
    // Abort only polls belonging to this tab's blocks (not all tabs), including
    // the blocks a reload resumed, which a flow import may have replaced.
    const pollBlockIds = new Set([...walkBlocks(pipelineRef.current.blocks)].map((block) => block.id))
    if (phase.kind === 'resuming') for (const id of phase.blockIds) pollBlockIds.add(id)
    for (const id of pollBlockIds) abortPoll(id)
    if (phase.kind === 'running') phase.controller.abort()
    dispatchRun({ type: 'cancel' })
    // A running run marks the blocks it interrupts itself; a resume has no runner.
    if (phase.kind === 'resuming') endLeftoverRunningBlocks('cancelled')
    setTabRuntimeInfo(tabId, {})
  }, [dispatchRun, endLeftoverRunningBlocks, setTabRuntimeInfo, tabId])

  const runPipeline = useCallback(async (opts?: { continueFromExisting?: boolean }): Promise<{ hadError: boolean }> => {
    if (!canStartRun(runPhaseRef.current)) return { hadError: false }
    // A block with no registered type has no execute function; the runner
    // would silently pass through it. Refuse to start instead.
    const unsupportedBlockers = findRunBlockingUnsupportedBlocks(pipelineRef.current.blocks)
    if (unsupportedBlockers.length > 0) {
      toast.error(formatUnsupportedRunMessage(unsupportedBlockers))
      return { hadError: true }
    }
    // Broken references and over-limit loaders would fail mid-run; say so up front.
    const knownBlockers = findRunBlockers(pipelineRef.current.blocks)
    if (knownBlockers.length > 0) {
      toast.error(formatRunBlockerMessage(knownBlockers))
      return { hadError: true }
    }
    const continueMode = opts?.continueFromExisting ?? false
    const runId = ++lastRunIdRef.current
    const runAbortController = new AbortController()
    // This run's own signal: every cancel check in this run reads it, never shared state.
    const signal = runAbortController.signal

    const blocks = pipelineRef.current.blocks
    // The saved run describes these blocks, whatever is added, removed or edited mid-run.
    const runSnapshot = createRunSnapshot(pipelineRef.current)
    dispatchRun({ type: 'start', runId, controller: runAbortController })
    const startTime = Date.now()

    // A fresh run forgets earlier iterations; a Continue run picks them up.
    if (!continueMode) iterationRecordsRef.current.clear()

    // In continue mode, preserve completed blocks; otherwise reset all
    const freshStates = new Map<string, BlockState>()
    const prevStates = blockStatesRef.current
    for (const block of walkBlocks(blocks)) {
      const prev = prevStates.get(block.id)
      if (continueMode && prev && prev.status === 'completed' && Object.keys(prev.outputs).length > 0) {
        freshStates.set(block.id, prev)
      } else {
        freshStates.set(block.id, { status: 'idle', outputs: {} })
      }
    }
    setBlockStates(freshStates)
    blockStatesRef.current = freshStates
    persistRuntimeSnapshot(freshStates)

    let hadError = false
    let hadPartialFailure = false
    let completedBlockExecutions = 0
    // Blocks that finished an execution in this run; a Continue run carries the rest over.
    const finishedThisRun = new Set<string>()
    // How many times each block completed in this run: an iterator item collects
    // only the outputs of blocks that completed while that item ran.
    const completions = new Map<string, number>()

    // This run's own record of what each block did (status and outputs). The
    // saved run and the iteration read it, so a newer run that resets the
    // shared block states cannot change what this run saves.
    const record = new Map<string, BlockState>(freshStates)
    // Whether this run still owns the tab's block states: false once a newer
    // run has started, and then this run writes only to its own record.
    const ownsStates = () => isCurrentRun(runPhaseRef.current, runId)

    const writeStatus = (blockId: string, status: BlockStatus, error?: string) => {
      const owns = ownsStates()
      const outputs = (owns ? blockStatesRef.current.get(blockId)?.outputs : undefined)
        ?? record.get(blockId)?.outputs ?? {}
      record.set(blockId, blockStateWith(status, outputs, error))
      if (owns) setBlockStatus(blockId, status, error)
    }
    const writeOutput = (blockId: string, portName: string, value: unknown) => {
      const prev = record.get(blockId) ?? blockStateWith('idle', {})
      record.set(blockId, { ...prev, outputs: { ...prev.outputs, [portName]: value } })
      if (ownsStates()) setBlockOutput(blockId, portName, value)
    }
    const writeMessage = (blockId: string, message: string) => {
      if (ownsStates()) setBlockStatusMessage(blockId, message)
    }
    /** Downstream blocks start an item idle; they keep their outputs so viewers show earlier items meanwhile. */
    const resetForItem = (ids: readonly string[]) => {
      for (const id of ids) record.set(id, blockStateWith('idle', record.get(id)?.outputs ?? {}))
      if (!ownsStates()) return
      const next = new Map(blockStatesRef.current)
      for (const id of ids) next.set(id, blockStateWith('idle', next.get(id)?.outputs ?? {}))
      blockStatesRef.current = next
      setBlockStates(next)
    }
    const showIteration = (state: IterationState) => {
      if (!ownsStates()) return
      const shown = { ...state, items: state.items.map((item) => ({ ...item })) }
      setIterationStates((prev) => new Map(prev).set(state.blockId, shown))
    }

    function extractItemLabel(item: unknown, index: number): string {
      if (typeof item === 'string') {
        try {
          const url = new URL(item)
          const segments = url.pathname.split('/')
          return segments[segments.length - 1] || `Item ${index + 1}`
        } catch {
          // Not a URL — try filesystem path
          const parts = item.split('/')
          return parts[parts.length - 1] || `Item ${index + 1}`
        }
      }
      return `Item ${index + 1}`
    }

    /** The iterator's list, or null when its output is not a list of several items. */
    function iterationInput(block: PipelineBlock): { portName: string; items: unknown[] } | null {
      const iterDef = getBlockDef(block.type)
      if (!iterDef?.iterator) return null
      // Auto-detect which output port has an array if iteratorOutput is not specified
      let portName = iterDef.iteratorOutput ?? ''
      const blockOutputs = record.get(block.id)?.outputs ?? {}
      if (!portName) {
        // Find the first output port that contains an array with >1 items
        for (const port of iterDef.outputs) {
          const val = blockOutputs[port.name]
          if (Array.isArray(val) && val.length > 1) {
            portName = port.name
            break
          }
        }
        // Fallback to first output port
        if (!portName) portName = iterDef.outputs[0]?.name ?? ''
      }
      const items = blockOutputs[portName]
      return Array.isArray(items) && items.length > 1 ? { portName, items } : null
    }

    /** Every block the iteration of `chain[idx]` runs once per item: the rest of the chain and the iterator's branches. */
    function iterationDownstream(chain: PipelineBlock[], idx: number): PipelineBlock[] {
      const blocks = [...walkBlocks(chain.slice(idx + 1))]
      for (const branch of chain[idx].branches ?? []) blocks.push(...walkBlocks(branch))
      return blocks
    }

    /**
     * Whether Continue has work in a completed iterator's iteration: an item
     * that did not complete last time, or (with no record of the last
     * iteration, as after a reload) a downstream block that did not complete.
     */
    function iterationNeedsContinue(chain: PipelineBlock[], idx: number, items: unknown[]): boolean {
      const previous = iterationRecordsRef.current.get(chain[idx].id)
      if (previous && sameItems(previous.items, items)) return previous.completed.some((outputs) => outputs === null)
      return iterationDownstream(chain, idx).some((b) => {
        if (b.disabled) return false
        const status = record.get(b.id)?.status
        return status !== 'completed' && status !== 'skipped'
      })
    }

    /**
     * Run the rest of `chain` and the iterator's branches once per item of the
     * iterator `chain[idx]`. An item ends completed, failed (the block's error;
     * the next item still runs) or skipped (cancelled). Only outputs a block
     * made for an item are collected; a block that failed, was cancelled or did
     * not run for it still holds the previous item's output. `resume` (a
     * Continue run carrying the iterator over without running it) re-uses the
     * items the last iteration completed with the same list; an iterator that
     * runs, such as one nested in another's item, runs every item.
     * Inside an item, the branches run one after another.
     */
    async function iterate(
      chain: PipelineBlock[],
      idx: number,
      input: { portName: string; items: unknown[] },
      resume: boolean,
    ): Promise<ChainOutcome> {
      const block = chain[idx]
      const { portName: iterPortName, items: iterOutput } = input
      const remainingChain = chain.slice(idx + 1)
      const iterBranches = block.branches ?? []
      const downstreamIds = iterationDownstream(chain, idx).map((b) => b.id)
      const previous = resume ? iterationRecordsRef.current.get(block.id) : undefined
      const reused = previous && sameItems(previous.items, iterOutput) ? previous.completed : []

      const iterState: IterationState = {
        blockId: block.id,
        currentIndex: -1,
        totalCount: iterOutput.length,
        items: iterOutput.map((item, i) => ({
          index: i,
          label: extractItemLabel(item, i),
          status: 'pending' as const,
          thumbnailUrl: typeof item === 'string' ? item : undefined,
        })),
      }
      showIteration(iterState)

      // The outputs collected for each item, and those of the items that completed.
      const collected: Array<ItemOutputs | null> = iterOutput.map(() => null)
      const completed: Array<ItemOutputs | null> = iterOutput.map(() => null)
      let firstError: string | null = null

      for (let itemIdx = 0; itemIdx < iterOutput.length; itemIdx++) {
        if (signal.aborted) break

        const carried = reused[itemIdx]
        if (carried) {
          // Completed in the run this Continue run picks up.
          collected[itemIdx] = carried
          completed[itemIdx] = carried
          iterState.items[itemIdx].status = 'completed'
          showIteration(iterState)
          continue
        }

        iterState.currentIndex = itemIdx
        iterState.items[itemIdx].status = 'running'
        showIteration(iterState)

        // Override the iterator block's output to this single item
        writeOutput(block.id, iterPortName, iterOutput[itemIdx])
        resetForItem(downstreamIds)
        const before = new Map(downstreamIds.map((id) => [id, completions.get(id) ?? 0]))

        const outcomes = [await executeChain(remainingChain)]
        for (const branch of iterBranches) outcomes.push(await executeChain(branch))
        const itemError = outcomes.find((o) => o.error !== null)?.error ?? null

        const made: ItemOutputs = new Map()
        for (const id of downstreamIds) {
          if ((completions.get(id) ?? 0) === before.get(id)) continue
          const outputs = record.get(id)?.outputs
          if (outputs) made.set(id, outputs)
        }
        collected[itemIdx] = made

        if (signal.aborted) {
          iterState.items[itemIdx].status = 'skipped'
          showIteration(iterState)
          break
        }
        if (itemError !== null) {
          iterState.items[itemIdx].status = 'error'
          iterState.items[itemIdx].error = itemError
          firstError ??= itemError
          hadPartialFailure = true
          // Skip failed item, continue to next
        } else {
          iterState.items[itemIdx].status = 'completed'
          completed[itemIdx] = made
        }
        showIteration(iterState)
      }

      // Restore the full array as output after all iterations
      writeOutput(block.id, iterPortName, iterOutput)

      // Restore accumulated downstream outputs, in item order, so artifacts capture all iterations
      const accumulated = new Map<string, Record<string, unknown[]>>()
      for (const made of collected) {
        for (const [bId, outputs] of made ?? []) {
          let acc = accumulated.get(bId)
          if (!acc) { acc = {}; accumulated.set(bId, acc) }
          for (const [portName, value] of Object.entries(outputs)) {
            if (!acc[portName]) acc[portName] = []
            // Flatten arrays (e.g. a batch block that outputs 4 URLs)
            if (Array.isArray(value)) acc[portName].push(...value)
            else acc[portName].push(value)
          }
        }
      }
      for (const [bId, ports] of accumulated) {
        for (const [portName, values] of Object.entries(ports)) {
          writeOutput(bId, portName, values.length === 1 ? values[0] : values)
        }
      }

      if (ownsStates()) iterationRecordsRef.current.set(block.id, { items: iterOutput, completed })

      const failedCount = iterState.items.filter((i) => i.status === 'error').length
      const completedCount = iterState.items.filter((i) => i.status === 'completed').length
      const allFailed = completedCount === 0 && failedCount > 0
      if (allFailed) hadError = true
      writeMessage(block.id, `${completedCount}/${iterState.totalCount} items completed`)
      // An item failure is a partial failure of the chain; every item failing is its error.
      return { error: allFailed ? firstError : null }
    }

    // Recursive chain executor: runs blocks sequentially, launches branches in parallel
    async function executeChain(chain: PipelineBlock[]): Promise<ChainOutcome> {
      const pendingBranches: Promise<ChainOutcome>[] = []
      let chainError: string | null = null
      const forwardOutputs = (block: PipelineBlock, freshInputs: Record<string, unknown>) => {
        const blockDef = getBlockDef(block.type)
        for (const forward of blockDef?.forwards ?? []) {
          const mode = forward.when ?? 'if_present'
          const value = freshInputs[forward.fromInput]
          if (mode === 'always' || value !== undefined) {
            writeOutput(block.id, forward.toOutput, value)
          }
        }
      }

      const validateBindingRequirements = (block: PipelineBlock, freshInputs: Record<string, unknown>) => {
        const blockDef = getBlockDef(block.type)
        for (const binding of blockDef?.bindings ?? []) {
          if (!bindingRequiresUpstream(binding)) continue
          if (freshInputs[binding.input] === undefined) {
            throw new Error(`Missing required upstream input "${binding.input}" for "${binding.field}"`)
          }
        }
      }

      const markSkippedTree = (root: PipelineBlock) => {
        for (const block of walkBlocks([root])) {
          writeStatus(block.id, 'skipped')
        }
      }

      const markCompleted = (blockId: string) => {
        writeStatus(blockId, 'completed')
        completedBlockExecutions++
        finishedThisRun.add(blockId)
        completions.set(blockId, (completions.get(blockId) ?? 0) + 1)
      }

      for (let idx = 0; idx < chain.length; idx++) {
        if (signal.aborted) break

        const block = chain[idx]
        if (block.disabled) {
          writeStatus(block.id, 'skipped')
          continue
        }

        // In continue mode, skip blocks that already completed with outputs
        const existingState = record.get(block.id)
        if (continueMode && existingState?.status === 'completed' && Object.keys(existingState.outputs).length > 0) {
          completedBlockExecutions++
          // A completed iterator whose iteration has unfinished items runs those items again.
          const input = iterationInput(block)
          if (input && iterationNeedsContinue(chain, idx, input.items)) {
            const outcome = await iterate(chain, idx, input, true)
            chainError ??= outcome.error
            break
          }
          // Still launch branches for completed blocks
          if (block.branches) {
            for (const branch of block.branches) {
              pendingBranches.push(executeChain(branch))
            }
          }
          continue
        }

        dispatchRun({ type: 'blockStarted', runId, blockId: block.id })
        writeStatus(block.id, 'running')
        const blockDef_ = getNodeType(block.type)
        setTabRuntimeInfo(tabId, { runningBlockLabel: block.label || blockDef_?.label || block.type })

        const executeFn = executeFns.current.get(block.id)
        const freshInputs = resolveInputs(block.id, blockStatesRef.current)
        runSnapshot.started(block)
        try {
          validateBindingRequirements(block, freshInputs)
          if (executeFn) {
            const cancelRace = new Promise<never>((_, reject) => {
              if (signal.aborted) {
                reject(new DOMException('Pipeline cancelled', 'AbortError'))
                return
              }
              signal.addEventListener('abort', () => {
                reject(new DOMException('Pipeline cancelled', 'AbortError'))
              }, { once: true })
            })
            const execResult = await Promise.race([executeFn(freshInputs, signal), cancelRace])
            forwardOutputs(block, freshInputs)
            markCompleted(block.id)
            if (execResult?.partialFailure) {
              hadPartialFailure = true
            }
            if (execResult?.terminateChain) {
              // Skip all descendants and remaining siblings in this chain.
              for (const branch of block.branches ?? []) {
                for (const branchBlock of branch) markSkippedTree(branchBlock)
              }
              for (let rest = idx + 1; rest < chain.length; rest++) {
                markSkippedTree(chain[rest])
              }
              break
            }
          } else {
            forwardOutputs(block, freshInputs)
            markCompleted(block.id)
            // Let React paint forwarded outputs before the next block starts.
            await waitForPaint(signal)
          }
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') {
            // A cancel interrupted the block: it ends cancelled, never left running.
            writeStatus(block.id, 'cancelled')
            break
          }
          const message = String(e)
          writeStatus(block.id, 'error', message)
          hadError = true
          chainError ??= message
          break // Stop this chain on error (branches already launched continue)
        }

        // After executing this block, check if it's an iterator
        const input = iterationInput(block)
        if (input) {
          const outcome = await iterate(chain, idx, input, false)
          chainError ??= outcome.error
          // Skip the rest of the chain — iterations already handled it
          break
        }

        // Launch all branches of this block in parallel (non-iterator path)
        if (block.branches) {
          for (const branch of block.branches) {
            pendingBranches.push(executeChain(branch))
          }
        }
      }

      // Wait for all branches launched from this chain to complete
      const branchOutcomes = await Promise.all(pendingBranches)
      return { error: chainError ?? branchOutcomes.find((o) => o.error !== null)?.error ?? null }
    }

    try {
      await executeChain(blocks)

      // ---- Auto-save run to history ----
      const durationMs = Date.now() - startTime
      const wasCancelled = signal.aborted
      const runStatus = deriveRunStatus({
        errored: hadError,
        partialFailure: hadPartialFailure,
        completedExecutions: completedBlockExecutions,
        cancelled: wasCancelled,
      })

      let globalIdx = 0
      let generatedThisRun = false
      const blockResults: BlockResult[] = []
      for (const block of walkBlocks(blocks)) {
        const state = record.get(block.id)
        const def = getNodeType(block.type)
        const outputs: Record<string, { kind: string; value: unknown }> = {}
        if (state?.outputs && def) {
          for (const [portName, value] of Object.entries(state.outputs)) {
            const portDef = def.outputs.find((p) => p.name === portName)
            outputs[portName] = { kind: portDef?.kind ?? 'unknown', value }
          }
        }
        blockResults.push({
          block_index: globalIdx++,
          block_type: block.type,
          block_label: block.label || def?.label || block.type,
          status: savedBlockStatus(state?.status),
          outputs,
        })
        if (finishedThisRun.has(block.id) && holdsGeneratedOutput(outputs)) generatedThisRun = true
      }

      if (!shouldSaveRun({ cancelled: wasCancelled, generatedThisRun })) return { hadError }

      const flowSnapshot = runSnapshot.exportFlow('Pipeline Run')
      const now = new Date()
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const dateStr = now.toLocaleDateString([], { month: 'short', day: 'numeric' })

      const run: RunEntry = {
        id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: `Pipeline Run — ${dateStr} ${timeStr}`,
        status: runStatus,
        duration_ms: durationMs,
        flow_snapshot: flowSnapshot as unknown as Record<string, unknown>,
        block_results: blockResults,
        created_at: now.toISOString(),
      }

      // Fire-and-forget — don't block the UI
      saveRun(run).catch(() => {})

      return { hadError }
    } finally {
      // A run cancelled and replaced by a newer one leaves that run's state alone.
      if (isCurrentRun(runPhaseRef.current, runId)) {
        setIterationStates(new Map())
        setTabRuntimeInfo(tabId, {})
      }
      dispatchRun({ type: 'finished', runId, outcome: hadError ? 'failed' : 'completed' })
    }
  }, [dispatchRun, persistRuntimeSnapshot, resolveInputs, setBlockOutput, setBlockStatus, setBlockStatusMessage, setTabRuntimeInfo, tabId])

  const getAddableTypes = useCallback((atIndex?: number): NodeTypeDef[] => {
    const blocks = pipeline.blocks
    const insertAt = atIndex ?? blocks.length

    if (insertAt === 0 || blocks.length === 0) return getStarterTypes()

    const lastEnabledIdx = findLastEnabledIndex(blocks, insertAt)
    if (lastEnabledIdx < 0) return getStarterTypes()

    const lastEnabledBlock = blocks[lastEnabledIdx]
    const lastOutputKinds = getAdvertisedOutputKinds(blocks, lastEnabledIdx, outputHints)
    if (lastOutputKinds.size === 0) return []

    const lastType = lastEnabledBlock.type
    const consumers = getValidNextTypes(lastOutputKinds).filter((def) => def.type !== lastType)

    const existingTypes = new Set(blocks.map((b) => b.type))
    const starters = getStarterTypes().filter((starter) => {
      if (existingTypes.has(starter.type)) return false
      return starter.outputs.some((out) => {
        const consumersOfKind = getValidNextTypes(new Set([out.kind]))
        return consumersOfKind.some((c) => !existingTypes.has(c.type))
      })
    })

    if (consumers.length === 0 && starters.length === 0) return []

    const seen = new Set<string>()
    const result: NodeTypeDef[] = []
    for (const def of [...consumers, ...starters]) {
      if (!seen.has(def.type)) {
        seen.add(def.type)
        result.push(def)
      }
    }
    return result
  }, [outputHints, pipeline.blocks])

  // ---- Branching methods ----

  const addBranch = useCallback((forkBlockId: string) => {
    updatePipeline((prev) => {
      const next = structuredClone(prev)
      const block = findBlockById(next.blocks, forkBlockId)
      if (!block) return prev
      // Only non-terminal blocks can fork
      const def = getNodeType(block.type)
      if (!def || def.outputs.length === 0) return prev
      if (!block.branches) block.branches = []
      if (block.branches.length >= 2) return prev
      block.branches.push([])
      return next
    })
  }, [updatePipeline])

  const addBlockToBranch = useCallback(
    (forkBlockId: string, branchIndex: number, type: string, atIndex?: number): string => {
      const id = newBlockIdFor()
      const prereqIds = prereqIdsFor(type)
      updatePipeline((prev) => {
        const next = structuredClone(prev)
        const block = findBlockById(next.blocks, forkBlockId)
        if (!block?.branches?.[branchIndex]) return prev
        const branch = block.branches[branchIndex]
        const insertAt = Math.min(atIndex ?? branch.length, branch.length)
        insertWithPrereqs(branch, insertAt, block, { id, type }, prereqIds)
        return next
      })
      return id
    },
    [updatePipeline],
  )

  const removeBranch = useCallback(
    (forkBlockId: string, branchIndex: number) => {
      // Collect all block IDs in the branch for cleanup
      const block = findBlockById(pipelineRef.current.blocks, forkBlockId)
      const idsToClean = new Set<string>()
      if (block?.branches?.[branchIndex]) {
        for (const b of walkBlocks(block.branches[branchIndex])) idsToClean.add(b.id)
      }

      updatePipeline((prev) => {
        const next = structuredClone(prev)
        const blk = findBlockById(next.blocks, forkBlockId)
        if (!blk?.branches?.[branchIndex]) return prev
        blk.branches.splice(branchIndex, 1)
        if (blk.branches.length === 0) delete blk.branches
        return next
      })
      setBlockStates((prev) => {
        const next = new Map(prev)
        for (const id of idsToClean) next.delete(id)
        blockStatesRef.current = next
        persistRuntimeSnapshot(next)
        return next
      })
      for (const id of idsToClean) {
        executeFns.current.delete(id)
        setOutputHints((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
      // Clear selection if it pointed into the removed branch.
      setSelectedBlockIdState((prev) => (prev && idsToClean.has(prev) ? null : prev))
    },
    [persistRuntimeSnapshot, updatePipeline],
  )

  /** Get addable block types for a position within a branch.
   *  `ancestors` = all blocks that precede this branch (trunk up to fork + branch blocks before atIndex). */
  const getAddableTypesForBranch = useCallback(
    (ancestors: PipelineBlock[], chain: PipelineBlock[], atIndex?: number): NodeTypeDef[] => {
      const insertAt = atIndex ?? chain.length
      const linear = [...ancestors, ...chain.slice(0, insertAt)]
      const lastEnabledIdx = findLastEnabledIndex(linear, linear.length)
      if (lastEnabledIdx < 0) return getStarterTypes()

      const lastOutputKinds = getAdvertisedOutputKinds(linear, lastEnabledIdx, outputHints)
      if (lastOutputKinds.size === 0) return []

      const lastType = linear[lastEnabledIdx].type
      return getValidNextTypes(lastOutputKinds).filter((def) => def.type !== lastType)
    },
    [outputHints],
  )

  const importFlowJson = useCallback((json: string): FlowImportOutcome => {
    const outcome = importFlowWithReport(json)
    if (!outcome.ok) return outcome
    const imported = outcome.pipeline
    pipelineRef.current = imported
    savePipeline(tabId, imported)
    setPipeline(imported)
    // Reset block states for the new pipeline
    const emptyStates = new Map<string, BlockState>()
    setBlockStates(emptyStates)
    blockStatesRef.current = emptyStates
    // The run phase is left as it is: a run in flight keeps the tab running
    // until it ends or is stopped, and the tab bar keeps agreeing with it.
    persistRuntimeSnapshot(emptyStates)
    executeFns.current.clear()
    iterationRecordsRef.current.clear()
    setOutputHints({})
    return outcome
  }, [persistRuntimeSnapshot, tabId])

  const exportFlowJson = useCallback((name = 'pipeline'): string => {
    const flow = exportFlowIO(pipelineRef.current, name)
    return JSON.stringify(flow)
  }, [])

  // Stable refs to avoid re-registering on every render
  const runPipelineRef = useRef(runPipeline)
  useEffect(() => { runPipelineRef.current = runPipeline }, [runPipeline])
  const cancelPipelineRef = useRef(cancelPipeline)
  useEffect(() => { cancelPipelineRef.current = cancelPipeline }, [cancelPipeline])

  // Register actions with tabs context
  useEffect(() => {
    const actions: TabActions = {
      runPipeline: (opts) => runPipelineRef.current(opts),
      cancelPipeline: () => cancelPipelineRef.current(),
      exportFlowJson,
      importFlowJson,
      hasHitlBlocks: () => [...walkBlocks(pipelineRef.current.blocks)].some((b) => b.type === 'hitl'),
    }
    registerTabActions(tabId, actions)
    return () => unregisterTabActions(tabId)
  }, [tabId, registerTabActions, unregisterTabActions, exportFlowJson, importFlowJson])

  // Check if any block (trunk + branches) has unsatisfied required inputs
  const hasMissingRequired = [...walkBlocks(pipeline.blocks)].some((block) => {
    if (block.disabled) return false
    const def = getNodeType(block.type)
    if (!def) return false
    const requiredInputNames = getRequiredInputNames(block.type)
    const requiredInputs = def.inputs.filter((p) => requiredInputNames.has(p.name))
    if (requiredInputs.length === 0) return false
    const location = findBlockInTree(pipeline.blocks, block.id)
    if (!location) return false
    const upstreamKinds = new Set<string>()
    for (const anc of location.ancestors) {
      if (anc.disabled) continue
      const ancIndex = location.ancestors.findIndex((candidate) => candidate.id === anc.id)
      const outputKinds = getAdvertisedOutputKinds(
        location.ancestors,
        ancIndex,
        outputHints,
      )
      for (const kind of outputKinds) upstreamKinds.add(kind)
    }
    return requiredInputs.some((port) => !upstreamKinds.has(canonicalizePortKind(port.kind)))
  })

  const hasCompletedBlocks = [...blockStates.values()].some(
    (s) => s.status === 'completed' && Object.keys(s.outputs).length > 0,
  )

  return (
    <PipelineCtx.Provider
      value={{
        pipeline,
        addBlock,
        removeBlock,
        setBlockLabel,
        blockStates,
        setBlockOutput,
        setBlockStatus,
        setBlockStatusMessage,
        getInputsForBlock,
        isBlockReady,
        getAddableTypes,
        registerBlockExecute,
        setOutputHint,
        runPipeline,
        cancelPipeline,
        isRunning,
        runningBlockId,
        setBlockSource,
        setBlockSourceMode,
        setBlockSourceSelection,
        clearBlockSource,
        resetRuntimeFromBlock,
        getUpstreamProducers,
        getUpstreamProducerValues,
        getPortSources,
        getDownstreamConsumers,
        hasMissingRequired,
        hasCompletedBlocks,
        importFlowJson,
        toggleBlockDisabled,
        exportFlowJson,
        addBranch,
        addBlockToBranch,
        insertBlockAdjacent,
        removeBranch,
        getAddableTypesForBranch,
        iterationStates,
        isLooping: loopingTabs[tabId] ?? false,
        selectedBlockId,
        setSelectedBlockId,
      }}
    >
      {children}
    </PipelineCtx.Provider>
  )
}
