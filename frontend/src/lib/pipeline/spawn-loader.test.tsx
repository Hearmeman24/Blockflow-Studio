/**
 * Adding a generation block that needs references inserts its loader directly
 * upstream in the same action (BlockDef.starterPrereqs), unless a suitable
 * loader is already directly upstream. Also covers inserting a block next to
 * another (used by "Add Video Viewer" and moving old references to a loader).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import '@/components/pipeline/custom_blocks/_register'
import { PipelineProvider, usePipeline } from './pipeline-context'
import { PipelineTabsProvider } from './tabs-context'
import { getBlockDef } from './registry'
import type { PipelineBlock } from './types'

let tab = 0
function setup(flow?: unknown[]) {
  const tabId = `spawn-${++tab}`
  const flowJson = flow ? JSON.stringify({ name: 't', version: 2, schema_version: 5, created_at: '', blocks: flow }) : undefined
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PipelineTabsProvider><PipelineProvider tabId={tabId} flowJson={flowJson}>{children}</PipelineProvider></PipelineTabsProvider>
  )
  return renderHook(() => usePipeline(), { wrapper }).result
}

const types = (chain: PipelineBlock[]) => chain.map((b) => b.type)

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

describe('spawning the loader with the generation block', () => {
  it('declares the loaders on the blocks that need them, and none on text-only blocks', () => {
    expect(getBlockDef('imageToVideo')?.starterPrereqs).toEqual(['uploadImageToTmpfiles'])
    expect(getBlockDef('imageToImage')?.starterPrereqs).toEqual(['uploadImageToTmpfiles'])
    expect(getBlockDef('omniReferenceToVideo')?.starterPrereqs).toEqual(['omniReferenceLoader'])
    expect(getBlockDef('textToVideo')?.starterPrereqs).toBeUndefined()
    expect(getBlockDef('textToImage')?.starterPrereqs).toBeUndefined()
  })

  it('first block: Image to Image arrives with an Image Loader before it, in one action', () => {
    const api = setup()
    let id = ''
    act(() => { id = api.current.addBlock('imageToImage') })
    expect(types(api.current.pipeline.blocks)).toEqual(['uploadImageToTmpfiles', 'imageToImage'])
    expect(api.current.pipeline.blocks[1].id).toBe(id)
    expect(api.current.getPortSources(id, 'image').map((p) => p.blockId)).toEqual([api.current.pipeline.blocks[0].id])
  })

  it('Omni Reference to Video spawns an Omni Reference Loader; text-only blocks spawn nothing', () => {
    const api = setup()
    act(() => { api.current.addBlock('textToImage') })
    act(() => { api.current.addBlock('omniReferenceToVideo') })
    act(() => { api.current.addBlock('textToVideo') })
    expect(types(api.current.pipeline.blocks)).toEqual(['textToImage', 'omniReferenceLoader', 'omniReferenceToVideo', 'textToVideo'])
  })

  it('mid-chain insert puts the loader directly before the new block', () => {
    const api = setup([{ type: 'textToImage' }, { type: 'imageViewer' }])
    act(() => { api.current.addBlock('imageToVideo', 1) })
    expect(types(api.current.pipeline.blocks)).toEqual(['textToImage', 'uploadImageToTmpfiles', 'imageToVideo', 'imageViewer'])
  })

  it('does not spawn a second loader when one is already directly upstream', () => {
    const api = setup([{ type: 'uploadImageToTmpfiles' }])
    act(() => { api.current.addBlock('imageToVideo') })
    expect(types(api.current.pipeline.blocks)).toEqual(['uploadImageToTmpfiles', 'imageToVideo'])
  })

  it('spawns when the loader directly upstream is disabled, since it would not feed the block', () => {
    const api = setup([{ type: 'uploadImageToTmpfiles', disabled: true }])
    act(() => { api.current.addBlock('imageToImage') })
    expect(types(api.current.pipeline.blocks)).toEqual(['uploadImageToTmpfiles', 'uploadImageToTmpfiles', 'imageToImage'])
  })

  it('branches: spawns inside the branch, and not when the fork block itself is the loader', () => {
    const api = setup([{ type: 'textToImage', branches: [[]] }, { type: 'uploadImageToTmpfiles', branches: [[]] }])
    const [fork, loaderFork] = api.current.pipeline.blocks
    act(() => { api.current.addBlockToBranch(fork.id, 0, 'imageToImage') })
    act(() => { api.current.addBlockToBranch(loaderFork.id, 0, 'imageToVideo') })
    const [a, b] = api.current.pipeline.blocks
    expect(types(a.branches![0])).toEqual(['uploadImageToTmpfiles', 'imageToImage'])
    expect(types(b.branches![0])).toEqual(['imageToVideo'])
  })

  it('a block with two loaders (Character Swap) arrives with both, in the declared order', () => {
    expect(getBlockDef('characterSwap')?.starterPrereqs).toEqual(['videoLoader', 'uploadImageToTmpfiles'])
    const api = setup()
    act(() => { api.current.addBlock('characterSwap') })
    expect(types(api.current.pipeline.blocks)).toEqual(['videoLoader', 'uploadImageToTmpfiles', 'characterSwap'])
  })

  it('two loaders: the ones already in a row directly upstream are not added again', () => {
    const both = setup([{ type: 'videoLoader' }, { type: 'uploadImageToTmpfiles' }])
    act(() => { both.current.addBlock('characterSwap') })
    expect(types(both.current.pipeline.blocks)).toEqual(['videoLoader', 'uploadImageToTmpfiles', 'characterSwap'])

    const reversed = setup([{ type: 'uploadImageToTmpfiles' }, { type: 'videoLoader' }])
    act(() => { reversed.current.addBlock('characterSwap') })
    expect(types(reversed.current.pipeline.blocks)).toEqual(['uploadImageToTmpfiles', 'videoLoader', 'characterSwap'])

    const imageOnly = setup([{ type: 'uploadImageToTmpfiles' }])
    act(() => { imageOnly.current.addBlock('characterSwap') })
    expect(types(imageOnly.current.pipeline.blocks)).toEqual(['uploadImageToTmpfiles', 'videoLoader', 'characterSwap'])
  })

  it('two loaders: a loader behind another block, or behind a disabled loader, does not count', () => {
    const behindOther = setup([{ type: 'videoLoader' }, { type: 'videoViewer' }, { type: 'uploadImageToTmpfiles' }])
    act(() => { behindOther.current.addBlock('characterSwap') })
    expect(types(behindOther.current.pipeline.blocks))
      .toEqual(['videoLoader', 'videoViewer', 'uploadImageToTmpfiles', 'videoLoader', 'characterSwap'])

    const disabled = setup([{ type: 'videoLoader' }, { type: 'uploadImageToTmpfiles', disabled: true }])
    act(() => { disabled.current.addBlock('characterSwap') })
    expect(types(disabled.current.pipeline.blocks))
      .toEqual(['videoLoader', 'uploadImageToTmpfiles', 'videoLoader', 'uploadImageToTmpfiles', 'characterSwap'])
  })

  it('two loaders: Load Character directly upstream stands in for both', () => {
    const api = setup([{ type: 'loadCharacter' }])
    act(() => { api.current.addBlock('characterSwap') })
    expect(types(api.current.pipeline.blocks)).toEqual(['loadCharacter', 'characterSwap'])
  })

  it('two loaders in a branch: the fork block counts as directly upstream', () => {
    const api = setup([{ type: 'videoLoader', branches: [[]] }])
    const [fork] = api.current.pipeline.blocks
    act(() => { api.current.addBlockToBranch(fork.id, 0, 'characterSwap') })
    expect(types(api.current.pipeline.blocks[0].branches![0])).toEqual(['uploadImageToTmpfiles', 'characterSwap'])
  })

  it('saves the same spawned loader id it renders, even when React runs the update twice (StrictMode)', () => {
    const tabId = `spawn-strict-${++tab}`
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <PipelineTabsProvider><PipelineProvider tabId={tabId}>{children}</PipelineProvider></PipelineTabsProvider>
      </StrictMode>
    )
    const api = renderHook(() => usePipeline(), { wrapper }).result
    act(() => { api.current.addBlock('imageToImage') })
    const stored = Object.entries(sessionStorage)
      .filter(([k]) => k.endsWith(tabId))
      .map(([, v]) => JSON.parse(v) as { blocks?: PipelineBlock[] })
      .find((p) => Array.isArray(p.blocks))
    expect(stored?.blocks?.map((b) => b.id)).toEqual(api.current.pipeline.blocks.map((b) => b.id))
  })

  it('the spawned loader is an ordinary block that can be removed on its own', () => {
    const api = setup()
    act(() => { api.current.addBlock('imageToImage') })
    act(() => { api.current.removeBlock(api.current.pipeline.blocks[0].id) })
    expect(types(api.current.pipeline.blocks)).toEqual(['imageToImage'])
  })
})

describe('a Load Character block stands in for the loader', () => {
  it('declares the loaders it stands in for', () => {
    expect(getBlockDef('loadCharacter')?.satisfiesPrereqs).toEqual(['uploadImageToTmpfiles', 'omniReferenceLoader', 'videoLoader'])
    expect(getBlockDef('loadCharacter')?.starterPrereqs).toBeUndefined()
  })

  it('adds no loader after an enabled Load Character, for each generation block that takes references', () => {
    for (const type of ['imageToVideo', 'imageToImage', 'omniReferenceToVideo']) {
      const api = setup([{ type: 'loadCharacter' }])
      let id = ''
      act(() => { id = api.current.addBlock(type) })
      expect(types(api.current.pipeline.blocks)).toEqual(['loadCharacter', type])
      expect(api.current.getPortSources(id, 'image').map((p) => p.blockId)).toEqual([api.current.pipeline.blocks[0].id])
    }
  })

  it('adds no loader to the first block of a branch whose fork is a Load Character', () => {
    const api = setup([{ type: 'loadCharacter', branches: [[]] }])
    act(() => { api.current.addBlockToBranch(api.current.pipeline.blocks[0].id, 0, 'omniReferenceToVideo') })
    expect(types(api.current.pipeline.blocks[0].branches![0])).toEqual(['omniReferenceToVideo'])
  })

  it('still adds the loader after a disabled Load Character, or when it is not directly upstream', () => {
    const disabled = setup([{ type: 'loadCharacter', disabled: true }])
    act(() => { disabled.current.addBlock('imageToImage') })
    expect(types(disabled.current.pipeline.blocks)).toEqual(['loadCharacter', 'uploadImageToTmpfiles', 'imageToImage'])
    const apart = setup([{ type: 'loadCharacter' }, { type: 'textToImage' }])
    act(() => { apart.current.addBlock('imageToVideo') })
    expect(types(apart.current.pipeline.blocks)).toEqual(['loadCharacter', 'textToImage', 'uploadImageToTmpfiles', 'imageToVideo'])
  })

  it('text-only blocks and a Load Character added before a generation block are unchanged', () => {
    const api = setup([{ type: 'loadCharacter' }])
    act(() => { api.current.addBlock('textToVideo') })
    act(() => { api.current.addBlock('loadCharacter', 0) })
    expect(types(api.current.pipeline.blocks)).toEqual(['loadCharacter', 'loadCharacter', 'textToVideo'])
  })
})

describe('insertBlockAdjacent', () => {
  it('inserts after a block in a branch, and before a block with config written to its keys', () => {
    const api = setup([{ type: 'textToImage', branches: [[{ type: 'imageToImage' }]] }])
    const fork = api.current.pipeline.blocks[0]
    const i2i = fork.branches![0][0]
    let viewer: string | null = null
    let loader: string | null = null
    act(() => { viewer = api.current.insertBlockAdjacent(i2i.id, 'after', 'imageViewer') })
    act(() => { loader = api.current.insertBlockAdjacent(i2i.id, 'before', 'uploadImageToTmpfiles', { items: [{ id: 'x', label: 'x.png', local: '/outputs/x.png', status: 'ready' }] }) })
    expect(types(api.current.pipeline.blocks[0].branches![0])).toEqual(['uploadImageToTmpfiles', 'imageToImage', 'imageViewer'])
    expect(api.current.pipeline.blocks[0].branches![0][2].id).toBe(viewer)
    expect(JSON.parse(sessionStorage.getItem(`block_${loader}_items`)!)).toHaveLength(1)
    expect(api.current.insertBlockAdjacent('missing', 'after', 'imageViewer')).toBeNull()
  })
})
