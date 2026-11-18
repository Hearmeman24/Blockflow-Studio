import type { PipelineBlock } from './types'

/**
 * The upstream producer ids an input port reads, by the port's source mode.
 * `producerIds` are the enabled upstream producers of the port's kind, in
 * pipeline order (closest last). Mirrors `resolvePort` in pipeline-context:
 *
 * - closest: the explicit source if one is set, else the closest producer;
 * - all: every producer;
 * - custom: the selected producers (none selected reads nothing).
 */
export function selectedSourceIds(block: PipelineBlock, portName: string, producerIds: readonly string[]): string[] {
  const mode = block.sourceModes?.[portName] ?? 'closest'
  if (mode === 'all') return [...producerIds]
  if (mode === 'custom') return [...(block.sourceSelections?.[portName] ?? [])]
  const preferred = block.sources?.[portName] ?? producerIds[producerIds.length - 1]
  return preferred ? [preferred] : []
}
