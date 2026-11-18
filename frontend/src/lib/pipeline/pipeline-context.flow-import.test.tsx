import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'

const toastMock = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

const apiMock = vi.hoisted(() => ({
  saveRun: vi.fn(() => Promise.resolve({ ok: true })),
  fetchFlow: vi.fn(),
  fetchFlows: vi.fn(() => Promise.resolve({ ok: true, flows: [] })),
  saveFlowToDisk: vi.fn(),
}))
vi.mock('@/lib/api', () => apiMock)

import { PipelineProvider, usePipeline } from './pipeline-context'
import { PipelineTabsProvider } from './tabs-context'
import { registerBlockDef } from './registry'
import { NEWER_SCHEMA_ERROR } from './flow-migrations'

const executed: string[] = []

beforeAll(() => {
  registerBlockDef({
    type: 'pcfi_src',
    label: 'Src',
    description: '',
    size: 'sm',
    inputs: [],
    outputs: [{ name: 'text', kind: 'text' }],
    canStart: true,
    configKeys: ['prompt'],
    component: () => null,
  } as unknown as Parameters<typeof registerBlockDef>[0])
})

let tabCounter = 0
function setup(flowJson?: string) {
  const tabId = `pcfi-${++tabCounter}`
  function wrapper({ children }: { children: ReactNode }) {
    return (
      <PipelineTabsProvider>
        <PipelineProvider tabId={tabId} flowJson={flowJson}>{children}</PipelineProvider>
      </PipelineTabsProvider>
    )
  }
  return renderHook(() => usePipeline(), { wrapper })
}

function flow(blocks: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ name: 't', version: 1, created_at: '', blocks, ...extra })
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  executed.length = 0
  toastMock.warning.mockReset()
  toastMock.error.mockReset()
  apiMock.saveRun.mockClear()
})

describe('importFlowJson', () => {
  it('returns the outcome with its report and replaces the pipeline', () => {
    const { result } = setup()
    let outcome: ReturnType<typeof result.current.importFlowJson> | undefined
    act(() => {
      outcome = result.current.importFlowJson(flow([{ type: 'pcfi_src' }, { type: 'comfyGen', config: { prompt: 'p' } }]))
    })
    expect(outcome?.ok).toBe(true)
    if (outcome?.ok) expect(outcome.report.unsupported.map((u) => u.type)).toEqual(['comfyGen'])
    expect(result.current.pipeline.blocks.map((b) => b.type)).toEqual(['pcfi_src', 'comfyGen'])
    expect(result.current.pipeline.blocks[1].preserved).toEqual({ config: { prompt: 'p' } })
  })

  it('leaves the current canvas untouched when the flow is from a newer schema', () => {
    const { result } = setup()
    act(() => {
      result.current.importFlowJson(flow([{ type: 'pcfi_src', label: 'Keep me' }]))
    })
    const before = result.current.pipeline
    let outcome: ReturnType<typeof result.current.importFlowJson> | undefined
    act(() => {
      outcome = result.current.importFlowJson(flow([{ type: 'pcfi_src', label: 'Future' }], { schema_version: 9 }))
    })
    expect(outcome).toEqual({ ok: false, code: 'newer_schema', error: NEWER_SCHEMA_ERROR })
    expect(result.current.pipeline).toBe(before)
    expect(result.current.pipeline.blocks[0].label).toBe('Keep me')
  })

  it.each([['{'], ['[]'], ['{"blocks": 3}']])('never throws for malformed JSON %s', (json) => {
    const { result } = setup()
    expect(() => act(() => { result.current.importFlowJson(json) })).not.toThrow()
    expect(result.current.pipeline.blocks).toEqual([])
  })

  it('a tab created with an unreadable flowJson mounts empty instead of crashing', () => {
    const { result } = setup('{"schema_version": 99, "blocks": []}')
    expect(result.current.pipeline.blocks).toEqual([])
  })
})

describe('run guard for unsupported blocks', () => {
  it('does not start a run that contains an enabled unsupported block', async () => {
    const { result } = setup(flow([
      { type: 'pcfi_src' },
      { type: 'comfyGen', label: 'Old Gen' },
      { type: 'pcfi_src', branches: [[{ type: 'mysteryBlock' }]] },
    ]))
    let outcome: { hadError: boolean } | undefined
    await act(async () => {
      outcome = await result.current.runPipeline()
    })
    expect(outcome).toEqual({ hadError: true })
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error).toHaveBeenCalledWith(
      'Pipeline not started: 2 blocks are no longer supported ("Old Gen", "mysteryBlock"). Remove or disable them, then run again.',
    )
    expect(apiMock.saveRun).not.toHaveBeenCalled()
    expect(result.current.isRunning).toBe(false)
    expect(result.current.blockStates.size).toBe(0)
  })

  it('runs normally when the unsupported block is disabled', async () => {
    const { result } = setup(flow([
      { type: 'pcfi_src' },
      { type: 'comfyGen', disabled: true },
    ]))
    let outcome: { hadError: boolean } | undefined
    await act(async () => {
      outcome = await result.current.runPipeline()
    })
    expect(outcome).toEqual({ hadError: false })
    expect(toastMock.error).not.toHaveBeenCalled()
    expect(apiMock.saveRun).toHaveBeenCalledTimes(1)
    const [src, legacy] = result.current.pipeline.blocks
    expect(result.current.blockStates.get(legacy.id)?.status).toBe('skipped')
    expect(result.current.blockStates.get(src.id)?.status).toBe('completed')
  })

  it('the saved run snapshot keeps the disabled unsupported block and its config', async () => {
    const { result } = setup(flow([
      { type: 'pcfi_src' },
      { type: 'comfyGen', disabled: true, config: { prompt: 'kept' } },
    ]))
    await act(async () => {
      await result.current.runPipeline()
    })
    const run = (apiMock.saveRun.mock.calls as unknown as unknown[][])[0][0] as { flow_snapshot: { schema_version: number; blocks: unknown[] } }
    expect(run.flow_snapshot.schema_version).toBe(6)
    expect(run.flow_snapshot.blocks[1]).toEqual({ type: 'comfyGen', disabled: true, config: { prompt: 'kept' } })
  })
})
