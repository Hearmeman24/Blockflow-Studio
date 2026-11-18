import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'

const toastMock = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))
vi.mock('@/lib/api', () => ({
  saveRun: vi.fn(() => Promise.resolve({ ok: true })),
  fetchFlow: vi.fn(),
  fetchFlows: vi.fn(() => Promise.resolve({ ok: true, flows: [] })),
  saveFlowToDisk: vi.fn(),
}))

import { PipelineProvider, usePipeline } from './pipeline-context'
import { PipelineTabsProvider } from './tabs-context'
import { registerBlockDef } from './registry'
import { clearRunBlockers, findRunBlockers, formatRunBlockerMessage, setRunBlockers } from './run-blockers'
import { walkBlocks } from './tree-utils'

const executed: string[] = []

beforeAll(() => {
  registerBlockDef({
    type: 'rb_block', label: 'Loader', description: '', size: 'sm', canStart: true,
    inputs: [], outputs: [{ name: 'image', kind: 'image' }], component: () => null,
  })
})

let tab = 0
function setup(blocks: unknown[]) {
  const flowJson = JSON.stringify({ name: 't', version: 2, schema_version: 3, created_at: '', blocks })
  const tabId = `rb-${++tab}`
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PipelineTabsProvider><PipelineProvider tabId={tabId} flowJson={flowJson}>{children}</PipelineProvider></PipelineTabsProvider>
  )
  const hook = renderHook(() => usePipeline(), { wrapper })
  const ids = [...walkBlocks(hook.result.current.pipeline.blocks)].map((b) => b.id)
  for (const id of ids) {
    act(() => hook.result.current.registerBlockExecute(id, async () => { executed.push(id) }))
  }
  return { hook, ids }
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  executed.length = 0
  toastMock.error.mockReset()
})

describe('run blockers', () => {
  it('formats one and several blockers, naming the block and the reference', () => {
    expect(formatRunBlockerMessage([{ blockId: 'a', label: 'Image Loader', messages: ['photo.png: the file was not found'] }]))
      .toBe('Pipeline not started: "Image Loader" photo.png: the file was not found. Fix it, then run again.')
    expect(formatRunBlockerMessage([
      { blockId: 'a', label: 'Image Loader', messages: ['x'] },
      { blockId: 'b', label: 'Omni', messages: ['y', 'z'] },
    ])).toBe('Pipeline not started: 2 blocks need attention: "Image Loader" x; "Omni" y; z. Fix them, then run again.')
  })

  it('blocks a run while an enabled block has a blocker, and allows it once cleared', async () => {
    const { hook, ids } = setup([{ type: 'rb_block', label: 'Image Loader' }, { type: 'rb_block' }])
    setRunBlockers(ids[0], ['has a broken reference: photo.png (The local file photo.png no longer exists.)'])
    let result: { hadError: boolean } | undefined
    await act(async () => { result = await hook.result.current.runPipeline() })
    expect(result?.hadError).toBe(true)
    expect(executed).toEqual([])
    expect(toastMock.error).toHaveBeenCalledWith(
      'Pipeline not started: "Image Loader" has a broken reference: photo.png (The local file photo.png no longer exists.). Fix it, then run again.',
    )

    clearRunBlockers(ids[0])
    await act(async () => { result = await hook.result.current.runPipeline() })
    expect(result?.hadError).toBe(false)
    expect(executed).toEqual(ids)
  })

  it('ignores blockers on a disabled block and on blocks under it', () => {
    const { hook, ids } = setup([{ type: 'rb_block', disabled: true, branches: [[{ type: 'rb_block' }]] }, { type: 'rb_block' }])
    setRunBlockers(ids[0], ['a'])
    setRunBlockers(ids[1], ['b'])
    expect(findRunBlockers(hook.result.current.pipeline.blocks)).toEqual([])
    setRunBlockers(ids[2], ['c'])
    expect(findRunBlockers(hook.result.current.pipeline.blocks)).toEqual([{ blockId: ids[2], label: 'Loader', messages: ['c'] }])
    clearRunBlockers(ids[2])
  })
})
