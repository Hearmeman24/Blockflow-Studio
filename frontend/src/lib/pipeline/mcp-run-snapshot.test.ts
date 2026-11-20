/**
 * The flow snapshots the backend saves for MCP jobs (backend/mcp_runs.py) must
 * open as a working pipeline when a run is restored from Artifacts. The fixture
 * is produced by that Python builder (tests/test_mcp_runs.py keeps it current).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import '@/components/pipeline/custom_blocks/_register'
import snapshots from '@/lib/byok/__fixtures__/mcp-run-snapshots.json'
import { GENERATION_BLOCK_CONFIGS } from '@/lib/byok/generation-blocks'
import { restoreLoaderItems } from '@/lib/byok/loader-items'
import { importFlowWithReport } from './flow-io'
import { CURRENT_FLOW_SCHEMA_VERSION } from './flow-migrations'
import { getBlockDef, getNodeType } from './registry'

const FIXTURES = snapshots as Record<string, { schema_version: number; blocks: Array<{ type: string; config?: Record<string, unknown> }> }>

beforeEach(() => sessionStorage.clear())

describe('MCP run snapshots', () => {
  it('cover every generation mode', () => {
    // Several blocks can share a mode (Character Swap runs Omni Reference to Video): one fixture per mode.
    expect(Object.keys(FIXTURES).sort()).toEqual(
      [...new Set(Object.values(GENERATION_BLOCK_CONFIGS).map((c) => c.mode))].sort(),
    )
  })

  it.each(Object.entries(FIXTURES))('%s imports without warnings or unsupported blocks', (mode, flow) => {
    // The backend (`backend/mcp_runs.py` FLOW_SCHEMA_VERSION) writes the current schema.
    expect(flow.schema_version).toBe(CURRENT_FLOW_SCHEMA_VERSION)
    expect(JSON.stringify(flow)).not.toMatch(/voice/i)
    const result = importFlowWithReport(flow)
    if (!result.ok) throw new Error(result.error)
    expect(result.report.unsupported).toEqual([])
    expect(result.report.warnings).toEqual([])
    expect(result.report.from_version).toBe(flow.schema_version)
    expect(result.flow.schema_version).toBe(CURRENT_FLOW_SCHEMA_VERSION)

    const blocks = result.pipeline.blocks
    expect(blocks.map((b) => b.type)).toEqual(flow.blocks.map((b) => b.type))
    for (const block of blocks) {
      expect(getNodeType(block.type)).toBeDefined()
      expect(block.preserved).toBeUndefined()
    }

    // The generation block is the one for this mode, and its saved config keys
    // are exactly ones it persists.
    const gen = blocks.find((b) => GENERATION_BLOCK_CONFIGS[b.type])!
    expect(GENERATION_BLOCK_CONFIGS[gen.type].mode).toBe(mode)
    const genSaved = flow.blocks.find((b) => b.type === gen.type)!.config!
    const keys = getBlockDef(gen.type)?.configKeys ?? []
    for (const key of Object.keys(genSaved)) expect(keys).toContain(key)
    expect(JSON.parse(sessionStorage.getItem(`block_${gen.id}_prompt`)!)).toBe(genSaved.prompt)
    expect(JSON.parse(sessionStorage.getItem(`block_${gen.id}_provider`)!)).toBe(genSaved.provider)

    // Loader items survive the loader's own sanitising unchanged.
    const loaderIdx = flow.blocks.findIndex((b) => b.type === 'uploadImageToTmpfiles' || b.type === 'omniReferenceLoader')
    if (loaderIdx >= 0) {
      const loader = blocks[loaderIdx]
      const loaderKeys = getBlockDef(loader.type)?.configKeys ?? []
      for (const [key, items] of Object.entries(flow.blocks[loaderIdx].config!)) {
        expect(loaderKeys).toContain(key)
        const stored = JSON.parse(sessionStorage.getItem(`block_${loader.id}_${key}`)!)
        expect(restoreLoaderItems(stored)).toEqual(items)
      }
    }
  })
})
