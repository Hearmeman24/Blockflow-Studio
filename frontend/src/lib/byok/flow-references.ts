/**
 * The saved references in a flow (loader items and references added inside
 * generation blocks), and how many of them the backend can no longer find.
 * Used when a flow, workspace or run snapshot is opened, for the import
 * report. Each block also checks its own references when it mounts.
 */
import { snapshotTargets } from '@/lib/characters/load-character'
import type { SavedBlock, SavedFlow } from '@/lib/pipeline/flow-io'
import { generationBlockConfig } from './generation-blocks'
import { LOADER_CONFIG_KEY, restoreLoaderItems } from './loader-items'
import { checkReferenceHealth, hasSource, healthSignature, isBrokenStatus, type HealthTarget } from './reference-health'
import { restoreReferences } from './references'

const LOADER_KINDS: Record<string, 'image' | 'video'> = {
  uploadImageToTmpfiles: 'image',
  videoLoader: 'video',
}

function blockTargets(block: SavedBlock): HealthTarget[] {
  const config = block.config
  if (!config) return []
  const loaderKind = LOADER_KINDS[block.type]
  if (loaderKind) {
    return restoreLoaderItems(config[LOADER_CONFIG_KEY])
      .filter((i) => i.status === 'ready')
      .map((i) => ({ kind: loaderKind, local: i.local, url: i.url }))
  }
  // Load Character: the selected files as last seen (the character or a file may be gone).
  if (block.type === 'loadCharacter') return snapshotTargets(config)
  if (generationBlockConfig(block.type)) {
    return restoreReferences(config.references)
      .filter((r) => r.status !== 'error')
      .map((r) => ({ kind: r.kind, local: r.local, url: r.url }))
  }
  return []
}

/** Every saved reference with a file or URL, in depth-first block order. */
export function collectFlowReferences(flows: readonly SavedFlow[]): HealthTarget[] {
  const out: HealthTarget[] = []
  const visit = (blocks: readonly SavedBlock[]) => {
    for (const block of blocks) {
      out.push(...blockTargets(block).filter(hasSource))
      for (const branch of block.branches ?? []) visit(branch)
    }
  }
  for (const flow of flows) visit(flow.blocks)
  return out
}

/**
 * How many saved references are broken. Duplicates are checked once but
 * counted per use. Resolves to null when the check could not run, so callers
 * say nothing rather than guess.
 */
export async function countBrokenFlowReferences(flows: readonly SavedFlow[]): Promise<number | null> {
  const all = collectFlowReferences(flows)
  if (all.length === 0) return 0
  const unique = new Map<string, HealthTarget>()
  for (const t of all) unique.set(healthSignature(t), t)
  try {
    const targets = [...unique.values()]
    const results = await checkReferenceHealth(targets)
    const broken = new Set(targets.filter((_, i) => isBrokenStatus(results[i].status)).map(healthSignature))
    return all.filter((t) => broken.has(healthSignature(t))).length
  } catch {
    return null
  }
}
