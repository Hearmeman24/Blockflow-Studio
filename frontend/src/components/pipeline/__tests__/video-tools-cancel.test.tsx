/**
 * Video FX and Video Stitcher honour the AbortSignal their execute receives:
 * the request is sent with it, and after a cancel nothing writes a status or
 * an output over the runner's `cancelled`. Fetch is mocked at the HTTP
 * boundary and answers only when released.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import '@/components/pipeline/custom_blocks/_register'
import { blockDef as videoFx } from '@/components/pipeline/custom_blocks/generated/video_fx'
import { blockDef as videoStitcher } from '@/components/pipeline/custom_blocks/generated/video_stitcher'
import { blockProps, latestExecute } from '@/test-utils/byok-harness'

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

let held: Array<{ url: string; signal: AbortSignal | null | undefined; release: () => void }>
/** When true, the fake rejects on abort as a real fetch does; when false it ignores the signal. */
let honoursAbort: boolean
let body: unknown

beforeEach(() => {
  sessionStorage.clear()
  held = []
  honoursAbort = true
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal
    if (honoursAbort) signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    held.push({ url: String(input), signal, release: () => resolve(json(body)) })
  })))
})
afterEach(() => vi.unstubAllGlobals())

const cases = [
  { name: 'Video FX', def: videoFx, endpoint: '/api/blocks/video_fx/run', ok: { ok: true, videos: ['/outputs/fx.mp4'] } },
  { name: 'Video Stitcher', def: videoStitcher, endpoint: '/api/blocks/video_stitcher/run', ok: { ok: true, local_video_url: '/outputs/st.mp4' } },
] as const

describe.each(cases)('$name cancel', ({ def, endpoint, ok }) => {
  function start() {
    body = ok
    const props = blockProps('vt')
    const Comp = def.component
    render(<Comp {...props} />)
    const controller = new AbortController()
    let run!: Promise<unknown>
    act(() => {
      run = latestExecute(props)({ video: ['/outputs/a.mp4', '/outputs/b.mp4'] }, controller.signal)
    })
    return { props, controller, run: run.then(() => 'resolved', (e) => e) }
  }

  it('sends the request with the signal', async () => {
    const { controller, run } = start()
    await act(async () => { await Promise.resolve() })
    expect(held).toHaveLength(1)
    expect(held[0].url).toContain(endpoint)
    expect(held[0].signal).toBe(controller.signal)
    held[0].release()
    await act(async () => { await run })
  })

  it('a cancel during the request writes no error and no output', async () => {
    const { props, controller, run } = start()
    await act(async () => { await Promise.resolve() })
    props.setExecutionStatus.mockClear()
    props.setStatusMessage.mockClear()
    await act(async () => { controller.abort() })
    const outcome = await run
    expect(outcome).toBeInstanceOf(DOMException)
    expect((outcome as DOMException).name).toBe('AbortError')
    expect(props.setExecutionStatus).not.toHaveBeenCalled()
    expect(props.setStatusMessage).not.toHaveBeenCalled()
    expect(props.setOutput).not.toHaveBeenCalled()
  })

  it('an answer that arrives after a cancel writes no completed status and no output', async () => {
    honoursAbort = false
    const { props, controller, run } = start()
    await act(async () => { await Promise.resolve() })
    props.setExecutionStatus.mockClear()
    props.setStatusMessage.mockClear()
    controller.abort()
    await act(async () => {
      held[0].release()
      await run
    })
    expect(props.setExecutionStatus).not.toHaveBeenCalled()
    expect(props.setOutput).not.toHaveBeenCalled()
    expect(await run).toBeInstanceOf(DOMException)
  })

  it('without a cancel, still completes and emits its output', async () => {
    const { props, run } = start()
    await act(async () => { await Promise.resolve() })
    await act(async () => {
      held[0].release()
      await run
    })
    expect(await run).toBe('resolved')
    expect(props.setExecutionStatus).toHaveBeenLastCalledWith('completed')
    expect(props.setOutput).toHaveBeenCalledWith('video', expect.anything())
  })
})
