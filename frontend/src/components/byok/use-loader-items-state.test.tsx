/**
 * The loader core (`useLoaderItemsState`): limits, flags, health, emit and run
 * blockers for an items array the caller owns. The loaders feed it their saved
 * list; the Load Character block feeds it the selected character files.
 * Downstream limits are stubbed (they have their own tests); fetch is stubbed
 * at the HTTP boundary for the health check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { DownstreamLimit } from '@/lib/byok/downstream-limits'
import type { LoaderItem } from '@/lib/byok/loader-items'
import type { MediaLimit } from '@/lib/byok/types'

const limitsMock = vi.hoisted(() => ({ consumers: [] as DownstreamLimit[] }))
vi.mock('@/lib/byok/use-downstream-limits', () => ({
  useDownstreamLimits: () => ({ consumers: limitsMock.consumers, strictest: limitsMock.consumers[0] ?? null, loading: false }),
}))

import { useLoaderItemsState } from './use-media-loader'

const LIMIT: MediaLimit = {
  max_count: 1, formats: [], max_size_bytes: null, max_duration_s: null, min_duration_s: null,
  max_total_duration_s: null, min_side_px: null, max_side_px: null,
} as unknown as MediaLimit

function consumer(over: Partial<DownstreamLimit> = {}): DownstreamLimit {
  return {
    blockId: 'gen', type: 'omniReferenceToVideo', label: 'Omni Reference to Video', mode: 'omni_reference_to_video',
    modeName: 'Omni', provider: 'kie', providerName: 'Kie', model: 'm', modelName: 'Model X',
    accepted: true, reason: null, limit: LIMIT, maxCount: 1, frameSlots: null, ...over,
  }
}

const clip = (id: string): LoaderItem => ({ id, label: `${id}.wav`, local: `/outputs/${id}.wav`, status: 'ready' })

let healthStatus = 'ok'
beforeEach(() => {
  healthStatus = 'ok'
  limitsMock.consumers = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { references: unknown[] }
    return new Response(JSON.stringify({ ok: true, results: body.references.map((_, index) => ({ index, status: healthStatus, detail: '' })) }))
  }))
})
afterEach(() => vi.unstubAllGlobals())

function render(items: LoaderItem[], skipUnsupported?: boolean) {
  const setOutput = vi.fn()
  const hook = renderHook(() => useLoaderItemsState('blk', setOutput, { kind: 'audio', port: 'audio', items, skipUnsupported }))
  return { setOutput, result: hook.result }
}

describe('useLoaderItemsState', () => {
  it('emits the items as an array of refs on the port', () => {
    const { setOutput } = render([clip('v1')])
    expect(setOutput).toHaveBeenLastCalledWith('audio', [
      { kind: 'audio-ref', local: '/outputs/v1.wav', label: 'v1.wav' },
    ])
  })

  it('emits undefined with no items', () => {
    const { setOutput } = render([])
    expect(setOutput).toHaveBeenLastCalledWith('audio', undefined)
  })

  it('without skipUnsupported, a kind the model does not take is emitted and blocks the run', () => {
    limitsMock.consumers = [consumer({ accepted: false, limit: null, maxCount: 0 })]
    const { setOutput, result } = render([clip('v1')])
    expect(setOutput).toHaveBeenLastCalledWith('audio', expect.any(Array))
    expect(result.current.skipped).toBe(false)
    expect(result.current.blockers).toEqual(['holds 1 audio clip, but Omni Reference to Video · Model X does not take audio clips'])
  })

  it('with skipUnsupported, the kind is not emitted, does not block, and prepareRun sends nothing', async () => {
    limitsMock.consumers = [consumer({ accepted: false, limit: null, maxCount: 0 })]
    healthStatus = 'missing_local'
    const { setOutput, result } = render([clip('v1')], true)
    expect(setOutput).toHaveBeenLastCalledWith('audio', undefined)
    expect(result.current.skipped).toBe(true)
    // Even once the health check marks it broken, an item that is not sent does not block.
    await waitFor(() => expect(result.current.rows[0].broken).toBe(true))
    expect(result.current.blockers).toEqual([])
    expect(await result.current.prepareRun()).toBe(0)
    expect(setOutput).toHaveBeenLastCalledWith('audio', undefined)
  })

  it('with skipUnsupported, a kind the model takes behaves exactly as a loader list', async () => {
    limitsMock.consumers = [consumer()]
    const { setOutput, result } = render([clip('v1'), clip('v2')], true)
    expect(result.current.skipped).toBe(false)
    expect(setOutput).toHaveBeenLastCalledWith('audio', expect.arrayContaining([expect.objectContaining({ local: '/outputs/v2.wav' })]))
    expect(result.current.rows.map((r) => r.flag.status)).toEqual(['ok', 'over_limit'])
    expect(result.current.blockers).toEqual(['holds 2 audio clips; Omni Reference to Video · Model X takes up to 1'])
  })

  it('prepareRun refuses a broken item, naming it', async () => {
    healthStatus = 'missing_local'
    const { result } = render([clip('v1')])
    await waitFor(() => expect(result.current.rows[0].broken).toBe(true))
    expect(result.current.blockers).toEqual(['has a broken reference: v1.wav (File not found)'])
    await expect(result.current.prepareRun()).rejects.toThrow('v1.wav: File not found Replace or remove it.')
  })
})
