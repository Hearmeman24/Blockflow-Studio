'use client'

/**
 * Problems a block knows will make a run fail before anything is sent, such
 * as a broken reference or more items than the downstream model takes. Blocks
 * publish them here; `runPipeline` refuses to start while an enabled block has
 * one, the same way it refuses unsupported blocks. Keyed by block id (ids are
 * unique across tabs).
 */
import { useEffect } from 'react'
import { getNodeType } from './registry'
import type { PipelineBlock } from './types'

const blockers = new Map<string, string[]>()

export function setRunBlockers(blockId: string, messages: readonly string[]): void {
  if (messages.length === 0) blockers.delete(blockId)
  else blockers.set(blockId, [...messages])
}

export function clearRunBlockers(blockId: string): void {
  blockers.delete(blockId)
}

export function getRunBlockers(blockId: string): string[] {
  return blockers.get(blockId) ?? []
}

export interface FoundRunBlocker {
  blockId: string
  label: string
  messages: string[]
}

/** Blockers of enabled blocks. A disabled block is skipped with its branches, as the runner does. */
export function findRunBlockers(blocks: PipelineBlock[]): FoundRunBlocker[] {
  const found: FoundRunBlocker[] = []
  const visit = (chain: PipelineBlock[]) => {
    for (const block of chain) {
      if (block.disabled) continue
      const messages = blockers.get(block.id)
      if (messages && messages.length > 0) {
        found.push({ blockId: block.id, label: block.label || getNodeType(block.type)?.label || block.type, messages })
      }
      for (const branch of block.branches ?? []) visit(branch)
    }
  }
  visit(blocks)
  return found
}

/** Worded like the unsupported-block guard: "Pipeline not started: ...". */
export function formatRunBlockerMessage(found: readonly FoundRunBlocker[]): string {
  if (found.length === 1) {
    return `Pipeline not started: "${found[0].label}" ${found[0].messages.join('; ')}. Fix it, then run again.`
  }
  const parts = found.map((f) => `"${f.label}" ${f.messages.join('; ')}`)
  return `Pipeline not started: ${found.length} blocks need attention: ${parts.join('; ')}. Fix them, then run again.`
}

/** Publish a block's blockers while it is mounted. */
export function useRunBlockers(blockId: string, messages: readonly string[]): void {
  const joined = messages.join('\u0000')
  useEffect(() => {
    setRunBlockers(blockId, joined ? joined.split('\u0000') : [])
  }, [blockId, joined])
  useEffect(() => () => clearRunBlockers(blockId), [blockId])
}
