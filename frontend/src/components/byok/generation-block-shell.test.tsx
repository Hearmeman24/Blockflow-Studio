import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CATALOG_BOTH, CATALOG_KIE, CATALOG_NONE } from '@/lib/byok/__fixtures__'
import {
  blockProps,
  jobSnapshot,
  latestExecute,
  renderGenerationBlock,
  stubGenerationFetch,
  type TestBlockProps,
} from '@/test-utils/byok-harness'
import { abortPoll } from '@/lib/pipeline/job-poller'
import { GenerationBlockShell, type GenerationBlockConfig } from './generation-block-shell'

const T2V: GenerationBlockConfig = { mode: 'text_to_video', output: 'video', referenceKinds: [] }
const OMNI: GenerationBlockConfig = { mode: 'omni_reference_to_video', output: 'video', referenceKinds: ['video', 'image', 'audio'] }

function Shell(props: TestBlockProps & { config: GenerationBlockConfig }) {
  return <GenerationBlockShell {...props} pollIntervalMs={1} />
}

function mount(config: GenerationBlockConfig, props: TestBlockProps) {
  return renderGenerationBlock(Shell, { ...props, config })
}

function seed(blockId: string, values: Record<string, unknown>) {
  for (const [k, v] of Object.entries(values)) sessionStorage.setItem(`block_${blockId}_${k}`, JSON.stringify(v))
}

beforeEach(() => sessionStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('GenerationBlockShell states', () => {
  it('shows a skeleton while the catalog loads, then the selectors', async () => {
    stubGenerationFetch({ catalog: CATALOG_BOTH })
    mount(T2V, blockProps('s1'))
    expect(screen.getByLabelText('Loading providers')).toHaveAttribute('aria-busy', 'true')
    expect(await screen.findByRole('combobox', { name: 'Model' })).toHaveTextContent('Seedance 2')
    expect(screen.getByRole('combobox', { name: 'Provider' })).toHaveTextContent('Kie')
  })

  it('shows an error with a retry when the catalog fails', async () => {
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH })
    harness.fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }))
    const user = userEvent.setup()
    mount(T2V, blockProps('s2'))
    expect(await screen.findByText('Could not load the providers')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('combobox', { name: 'Model' })).toBeInTheDocument()
  })

  it('keeps the block usable when a catalog revalidation fails after it loaded', async () => {
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH })
    const view = mount(T2V, blockProps('s6'))
    await screen.findByRole('combobox', { name: 'Model' })
    harness.fetchMock.mockResolvedValue(new Response('{}', { status: 500 }))
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.queryByText('Could not load the providers')).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('Seedance 2')
    view.unmount()
  })

  it('guides setup when no key is configured and refuses to run', async () => {
    const harness = stubGenerationFetch({ catalog: CATALOG_NONE })
    const props = blockProps('s3')
    mount(T2V, props)
    expect(await screen.findByText('Add a provider key to generate')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/settings')
    expect(screen.getByRole('link', { name: /Create a Kie account/ })).toHaveAttribute('href', expect.stringContaining('kie.ai'))
    expect(screen.getByRole('link', { name: /Create a PiAPI account/ })).toHaveAttribute('href', expect.stringContaining('piapi.ai'))
    await expect(latestExecute(props)({}, new AbortController().signal)).rejects.toThrow('Add a Kie or PiAPI API key in Settings')
    expect(harness.requests('/api/generation/validate')).toHaveLength(0)
    expect(harness.requests('/api/generation/submit')).toHaveLength(0)
  })

  it('explains why the chosen model is unavailable and links to Settings', async () => {
    stubGenerationFetch({ catalog: CATALOG_KIE })
    seed('s4', { provider: 'piapi', model: 'seedance-2' })
    const props = blockProps('s4')
    mount(T2V, props)
    expect(await screen.findByText('Seedance 2 is not available on PiAPI')).toBeInTheDocument()
    expect(screen.getByText('Requires a PiAPI API key.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add the key in Settings' })).toHaveAttribute('href', '/settings')
    await expect(latestExecute(props)({}, new AbortController().signal)).rejects.toThrow('Requires a PiAPI API key')
  })

  it('a saved selection the catalog no longer offers (PiAPI Kling 4.0 Omni) says why and sends nothing', async () => {
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH })
    seed('s6', { provider: 'piapi', model: 'kling-4.0', prompt: '@image_1 walks in' })
    const props = blockProps('s6')
    mount(OMNI, props)
    expect(await screen.findByText('Kling 4.0 is not available on PiAPI')).toBeInTheDocument()
    expect(screen.getByText(/PiAPI does not run Kling 4\.0 Omni generation yet\. Use Kie/)).toBeInTheDocument()
    // The saved values are kept, not silently replaced.
    expect(JSON.parse(sessionStorage.getItem('block_s6_provider')!)).toBe('piapi')
    expect(JSON.parse(sessionStorage.getItem('block_s6_model')!)).toBe('kling-4.0')
    await expect(latestExecute(props)({}, new AbortController().signal)).rejects.toThrow(/PiAPI does not run Kling 4\.0 Omni/)
    expect(harness.requests('/api/generation/validate')).toHaveLength(0)
    expect(harness.requests('/api/generation/submit')).toHaveLength(0)
  })

  it('hides the prompt when the mode takes none', async () => {
    stubGenerationFetch({ catalog: CATALOG_BOTH })
    seed('s5', { model: 'image-upscaler' })
    renderGenerationBlock(Shell, { ...blockProps('s5'), config: { mode: 'image_to_image', output: 'image', referenceKinds: ['image'] } })
    await screen.findByRole('combobox', { name: 'Model' })
    expect(screen.queryByLabelText(/Prompt/)).toBeNull()
  })
})

describe('GenerationBlockShell run', () => {
  it('blocks submission and shows the issues when validation fails', async () => {
    const issues = [{ code: 'prompt_required', severity: 'error', field: 'prompt', message: 'Seedance 2 on Kie needs a prompt for Text to Video.' }]
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH, validate: () => ({ body: { ok: false, issues } }) })
    const props = blockProps('r1')
    mount(T2V, props)
    await screen.findByRole('combobox', { name: 'Model' })
    let error: unknown
    await act(async () => {
      error = await latestExecute(props)({}, new AbortController().signal).catch((e) => e)
    })
    expect((error as Error).message).toBe(issues[0].message)
    expect(harness.requests('/api/generation/submit')).toHaveLength(0)
    expect(screen.getAllByText(issues[0].message).length).toBeGreaterThan(0)
  })

  it('reports progress and sets the output port on success', async () => {
    const harness = stubGenerationFetch({
      catalog: CATALOG_BOTH,
      jobs: [
        jobSnapshot({ status: 'RUNNING', progress: 0.5 }),
        jobSnapshot({ status: 'COMPLETED', outputs: [{ kind: 'video', url: 'https://cdn/out.mp4', local_url: '/outputs/out.mp4' }] }),
      ],
    })
    const props = blockProps('r2')
    mount(T2V, props)
    fireEvent.change(await screen.findByLabelText('Generation Prompt'), { target: { value: 'a cat surfing' } })
    await act(async () => {
      await latestExecute(props)({}, new AbortController().signal)
    })
    expect(harness.requests('/api/generation/submit')[0]).toMatchObject({ params: { prompt: 'a cat surfing' } })
    expect(props.setStatusMessage).toHaveBeenCalledWith('Running 50%')
    expect(props.setOutput).toHaveBeenCalledWith('video', expect.objectContaining({ kind: 'video-ref', local: '/outputs/out.mp4', url: 'https://cdn/out.mp4' }))
    // The header badge is the only status: no body badge, and no filler like "Done" or "Completed".
    expect(screen.queryByTestId('run-status')).toBeNull()
    expect(screen.queryByText('Completed')).toBeNull()
    expect(screen.queryByText('Done')).toBeNull()
  })

  it('shows only the provider detail line while running, never a second status badge', async () => {
    stubGenerationFetch({ catalog: CATALOG_BOTH, jobs: [jobSnapshot({ status: 'RUNNING', progress: 0.4, message: 'Queued at Kie' })] })
    const props = blockProps('r6')
    mount(T2V, props)
    fireEvent.change(await screen.findByLabelText('Generation Prompt'), { target: { value: 'x' } })
    const controller = new AbortController()
    const run = latestExecute(props)({}, controller.signal).catch(() => undefined)
    const line = await screen.findByTestId('run-detail')
    expect(line).toHaveTextContent('Queued at Kie · 40%')
    expect(screen.queryByText('Running')).toBeNull()
    expect(within(screen.getByTestId('generation-block')).queryByText(/^Running/)).toBeNull()
    await act(async () => { controller.abort(); await run })
  })

  it('shows the job error message when the job fails', async () => {
    stubGenerationFetch({
      catalog: CATALOG_BOTH,
      jobs: [jobSnapshot({ status: 'FAILED', error: { kind: 'content_policy', message: 'Kie rejected the prompt as sensitive.' } })],
    })
    const props = blockProps('r3')
    mount(T2V, props)
    fireEvent.change(await screen.findByLabelText('Generation Prompt'), { target: { value: 'x' } })
    let error: unknown
    await act(async () => {
      error = await latestExecute(props)({}, new AbortController().signal).catch((e) => e)
    })
    expect((error as Error).message).toBe('Kie rejected the prompt as sensitive.')
    expect(props.setOutput).not.toHaveBeenCalled()
    expect(within(screen.getByTestId('run-status')).getByText('Kie rejected the prompt as sensitive.')).toBeInTheDocument()
    expect(within(screen.getByTestId('run-status')).queryByText('Failed')).toBeNull()
  })

  it('cancels the job when the pipeline aborts', async () => {
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH, jobs: [jobSnapshot({ status: 'RUNNING' })] })
    const props = blockProps('r4')
    mount(T2V, props)
    fireEvent.change(await screen.findByLabelText('Generation Prompt'), { target: { value: 'x' } })
    const controller = new AbortController()
    let settled: unknown
    const run = latestExecute(props)({}, controller.signal).catch((e) => { settled = e })
    await waitFor(() => expect(props.setStatusMessage).toHaveBeenCalledWith('Running…'))
    await act(async () => {
      controller.abort()
      await run
    })
    expect((settled as DOMException).name).toBe('AbortError')
    await waitFor(() => expect(harness.fetchMock.mock.calls.some(([u]) => String(u) === '/api/jobs/job-1/cancel')).toBe(true))
  })

  it('resumes a job that was running before a reload', async () => {
    sessionStorage.setItem('block_r5_pending_jobs_v1', JSON.stringify({
      kind: 'generation', total: 1, submissionFailures: 0, submitted: [{ idx: 0, jobId: 'job-7' }], startedAt: Date.now(),
    }))
    stubGenerationFetch({
      catalog: CATALOG_BOTH,
      jobs: [jobSnapshot({ job_id: 'job-7', status: 'COMPLETED', outputs: [{ kind: 'video', url: 'https://cdn/r.mp4' }] })],
    })
    const props = blockProps('r5')
    mount(T2V, props)
    await waitFor(() => expect(props.setOutput).toHaveBeenCalledWith('video', expect.objectContaining({ kind: 'video-ref', local: 'https://cdn/r.mp4', url: 'https://cdn/r.mp4' })))
    expect(props.setExecutionStatus).toHaveBeenCalledWith('running')
    expect(props.setExecutionStatus).toHaveBeenLastCalledWith('completed')
  })

  it('a resumed job stopped by the user leaves the block cancelled, not running or idle', async () => {
    sessionStorage.setItem('block_r6_pending_jobs_v1', JSON.stringify({
      kind: 'generation', total: 1, submissionFailures: 0, submitted: [{ idx: 0, jobId: 'job-8' }], startedAt: Date.now(),
    }))
    stubGenerationFetch({ catalog: CATALOG_BOTH, jobs: [jobSnapshot({ job_id: 'job-8', status: 'RUNNING' })] })
    const props = blockProps('r6')
    mount(T2V, props)
    await waitFor(() => expect(props.setExecutionStatus).toHaveBeenCalledWith('running'))
    act(() => { abortPoll('r6') })
    await waitFor(() => expect(props.setExecutionStatus).toHaveBeenLastCalledWith('cancelled'))
  })
})

describe('GenerationBlockShell run outcomes after a reload', () => {
  function pending(blockId: string, jobId: string) {
    sessionStorage.setItem(`block_${blockId}_pending_jobs_v1`, JSON.stringify({
      kind: 'generation', total: 1, submissionFailures: 0, submitted: [{ idx: 0, jobId }], startedAt: Date.now(),
    }))
  }

  it('a resumed job that was cancelled shows Cancelled, as a normal run does', async () => {
    pending('rc', 'job-c')
    stubGenerationFetch({ catalog: CATALOG_BOTH, jobs: [jobSnapshot({ job_id: 'job-c', status: 'CANCELLED', error: { kind: 'interrupted', message: 'Cancelled from Artifacts.' } })] })
    const props = blockProps('rc')
    mount(T2V, props)
    await waitFor(() => expect(props.setExecutionStatus).toHaveBeenLastCalledWith('cancelled'))
    const panel = within(await screen.findByTestId('run-status'))
    expect(panel.getByText('The generation was cancelled')).toBeInTheDocument()
    expect(panel.getByText('Cancelled from Artifacts.')).toBeInTheDocument()
    expect(props.setOutput).not.toHaveBeenCalled()
  })

  it('a resumed job that timed out shows Timed out, as a normal run does', async () => {
    pending('rt', 'job-t')
    stubGenerationFetch({ catalog: CATALOG_BOTH, jobs: [jobSnapshot({ job_id: 'job-t', status: 'TIMED_OUT', error: { kind: 'timeout', message: 'Kie did not finish within 30 minutes.' } })] })
    const props = blockProps('rt')
    mount(T2V, props)
    await waitFor(() => expect(props.setExecutionStatus).toHaveBeenLastCalledWith('error', 'Kie did not finish within 30 minutes.'))
    const panel = within(await screen.findByTestId('run-status'))
    expect(panel.getByText('The generation timed out')).toBeInTheDocument()
    expect(panel.getByText('Kie did not finish within 30 minutes.')).toBeInTheDocument()
  })

  it('a resumed job that failed, or finished without an output, shows the failure', async () => {
    pending('rf', 'job-f')
    stubGenerationFetch({ catalog: CATALOG_BOTH, jobs: [jobSnapshot({ job_id: 'job-f', status: 'COMPLETED', outputs: [] })] })
    const props = blockProps('rf')
    mount(T2V, props)
    await waitFor(() => expect(props.setExecutionStatus).toHaveBeenLastCalledWith('error', 'The job finished without a video.'))
    expect(within(await screen.findByTestId('run-status')).getByText('The generation did not finish')).toBeInTheDocument()
  })

  it('a normal run of a job cancelled elsewhere shows Cancelled and fails the block with the job text', async () => {
    stubGenerationFetch({ catalog: CATALOG_BOTH, jobs: [jobSnapshot({ status: 'CANCELLED' })] })
    const props = blockProps('nc')
    mount(T2V, props)
    fireEvent.change(await screen.findByLabelText('Generation Prompt'), { target: { value: 'x' } })
    let error: unknown
    await act(async () => { error = await latestExecute(props)({}, new AbortController().signal).catch((e) => e) })
    expect((error as Error).message).toBe('The generation was cancelled.')
    expect(within(screen.getByTestId('run-status')).getByText('The generation was cancelled')).toBeInTheDocument()
  })

  it('a normal run that timed out shows Timed out', async () => {
    stubGenerationFetch({ catalog: CATALOG_BOTH, jobs: [jobSnapshot({ status: 'TIMED_OUT', error: { kind: 'timeout', message: 'Too slow.' } })] })
    const props = blockProps('nt')
    mount(T2V, props)
    fireEvent.change(await screen.findByLabelText('Generation Prompt'), { target: { value: 'x' } })
    await act(async () => { await latestExecute(props)({}, new AbortController().signal).catch(() => undefined) })
    expect(within(screen.getByTestId('run-status')).getByText('The generation timed out')).toBeInTheDocument()
  })
})

describe('GenerationBlockShell between runs', () => {
  const WARNING = { code: 'unverified_behaviour', severity: 'warning', field: 'settings.real_people', message: 'Kie may reject real people.' }
  const PROMPT_ERROR = { code: 'prompt_required', severity: 'error', field: 'prompt', message: 'Seedance 2 on Kie needs a prompt for Text to Video.' }

  it("the next run does not show the previous run's warnings", async () => {
    let call = 0
    stubGenerationFetch({
      catalog: CATALOG_BOTH,
      validate: () => (++call === 1 ? { body: { ok: true, issues: [WARNING] } } : { body: { ok: false, issues: [PROMPT_ERROR] } }),
      jobs: [jobSnapshot({ status: 'COMPLETED', outputs: [{ kind: 'video', url: 'https://cdn/o.mp4' }] })],
    })
    const props = blockProps('w1')
    mount(T2V, props)
    fireEvent.change(await screen.findByLabelText('Generation Prompt'), { target: { value: 'x' } })
    await act(async () => { await latestExecute(props)({}, new AbortController().signal) })
    // The first run's warning stays visible after it completes.
    expect(within(screen.getByTestId('run-status')).getByText(WARNING.message)).toBeInTheDocument()

    await act(async () => { await latestExecute(props)({}, new AbortController().signal).catch(() => undefined) })
    const status = within(screen.getByTestId('run-status'))
    expect(status.queryByText(WARNING.message)).toBeNull()
    expect(status.getByText(PROMPT_ERROR.message)).toBeInTheDocument()
  })

  it("a run refused before it is submitted does not keep showing the previous run's error", async () => {
    stubGenerationFetch({ catalog: CATALOG_BOTH, jobs: [jobSnapshot({ status: 'FAILED', error: { kind: 'content_rejected', message: 'Kie rejected the prompt.' } })] })
    const props = { ...blockProps('w2'), hasUpstreamProducer: vi.fn(() => true) }
    seed('w2', { use_upstream_prompt: true })
    mount(T2V, props)
    await screen.findByText('Uses the prompt from the upstream block')
    await act(async () => { await latestExecute(props)({ text: 'a cat' }, new AbortController().signal).catch(() => undefined) })
    expect(within(screen.getByTestId('run-status')).getByText('Kie rejected the prompt.')).toBeInTheDocument()

    let error: unknown
    await act(async () => { error = await latestExecute(props)({ text: '  ' }, new AbortController().signal).catch((e) => e) })
    expect((error as Error).message).toMatch(/^The prompt from the upstream block is empty\./)
    expect(screen.queryByTestId('run-status')).toBeNull()
  })
})

describe('GenerationBlockShell model switching', () => {
  const upstreamImages = (n: number) => ({ image: Array.from({ length: n }, (_, i) => ({ kind: 'image-ref', local: `/outputs/img-${i}.png` })) })

  it('flags too many upstream references after a switch and clears it on switching back', async () => {
    const user = userEvent.setup()
    stubGenerationFetch({ catalog: CATALOG_BOTH })
    seed('m1', { provider: 'kie', model: 'seedance-2.5', prompt: 'p' })
    mount(OMNI, blockProps('m1', upstreamImages(10)))
    await screen.findByRole('combobox', { name: 'Model' })
    expect(screen.queryByTestId('upstream-summary')).toBeNull()
    expect(screen.queryByText(/accepts at most/)).toBeNull()

    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    await user.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Seedance 2') && !/Seedance 2(\.5| Fast| Mini)/.test(o.textContent ?? ''))!)
    expect(screen.getByText('Seedance 2 on Kie accepts at most 9 images; remove 1.')).toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    await user.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Seedance 2.5'))!)
    expect(screen.queryByText(/accepts at most/)).toBeNull()
  })

  it('resets settings the new provider cannot use with a visible notice', async () => {
    const user = userEvent.setup()
    stubGenerationFetch({ catalog: CATALOG_BOTH })
    seed('m3', { provider: 'kie', model: 'seedance-2', params: { duration: null, resolution: '4k', aspect_ratio: null, settings: {} } })
    mount(T2V, blockProps('m3'))
    await user.click(await screen.findByRole('combobox', { name: 'Provider' }))
    await user.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('PiAPI'))!)
    expect(screen.getByText('Resolution 4k is not available for Seedance 2 on PiAPI; reset to 480p.')).toBeInTheDocument()
    expect(JSON.parse(sessionStorage.getItem('block_m3_params')!).resolution).toBeNull()
  })

  it('a model switch keeps a resolution that only differs in letter case, stored in the new spelling, with no notice', async () => {
    const user = userEvent.setup()
    stubGenerationFetch({ catalog: CATALOG_BOTH })
    // Kling on Kie writes "720p"; Wan 3.0 Prime writes "720P".
    seed('m7', { provider: 'kie', model: 'kling-4.0', prompt: 'p', params: { duration: null, resolution: '720p', aspect_ratio: null, settings: {} } })
    mount(OMNI, blockProps('m7'))
    await user.click(await screen.findByRole('combobox', { name: 'Model' }))
    await user.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Wan 3.0 Prime'))!)
    expect(screen.queryByText(/is not available for/)).toBeNull()
    expect(JSON.parse(sessionStorage.getItem('block_m7_params')!).resolution).toBe('720P')
  })

  it('a reset notice goes away once the user picks a value for that setting', async () => {
    const user = userEvent.setup()
    stubGenerationFetch({ catalog: CATALOG_BOTH })
    seed('m8', { provider: 'kie', model: 'seedance-2', params: { duration: null, resolution: '4k', aspect_ratio: null, settings: {} } })
    mount(T2V, blockProps('m8'))
    await user.click(await screen.findByRole('combobox', { name: 'Provider' }))
    await user.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('PiAPI'))!)
    expect(screen.getByText(/Resolution 4k is not available/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Resolution/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: '720p' }))
    expect(screen.queryByText(/Resolution 4k is not available/)).toBeNull()
  })

  it('switching provider keeps a model the new provider does not offer, and says so (behaviour pinned)', async () => {
    const user = userEvent.setup()
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH })
    seed('m6', { provider: 'kie', model: 'wan-3.0', prompt: 'p' })
    const props = blockProps('m6')
    mount(T2V, props)
    await user.click(await screen.findByRole('combobox', { name: 'Provider' }))
    await user.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('PiAPI'))!)
    expect(JSON.parse(sessionStorage.getItem('block_m6_provider')!)).toBe('piapi')
    expect(JSON.parse(sessionStorage.getItem('block_m6_model')!)).toBe('wan-3.0')
    expect(await screen.findByText('Wan 3.0 is not available on PiAPI')).toBeInTheDocument()
    await expect(latestExecute(props)({}, new AbortController().signal)).rejects.toThrow(/PiAPI/)
    expect(harness.requests('/api/generation/validate')).toHaveLength(0)
  })

  it('does not write the resolved selection back to storage', async () => {
    stubGenerationFetch({ catalog: CATALOG_BOTH })
    mount(T2V, blockProps('m7'))
    expect(await screen.findByRole('combobox', { name: 'Model' })).toHaveTextContent('Seedance 2')
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(sessionStorage.getItem('block_m7_provider')).toBe('null')
    expect(sessionStorage.getItem('block_m7_model')).toBe('null')
  })

  it('says "needs at least 1 image" in the singular', async () => {
    stubGenerationFetch({ catalog: CATALOG_BOTH })
    seed('m5', { provider: 'kie', model: 'seedream-5-pro' })
    mount({ mode: 'image_to_image', output: 'image', referenceKinds: ['image'] }, blockProps('m5'))
    const hint = await screen.findByTestId('reference-hint')
    expect(hint).toHaveTextContent('Seedream 5 Pro on Kie needs at least 1 image.')
    expect(hint.textContent).not.toMatch(/1 images|1 reference\b.*1 image/)
  })
})
