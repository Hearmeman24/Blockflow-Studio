/**
 * Cost in the generation block: a pre-run estimate chip at the end of the
 * settings row (for the exact request a run would submit) and the provider's
 * actual charge next to the run status once a job finishes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@/components/pipeline/custom_blocks/_register'
import { CATALOG_BOTH, CATALOG_NONE } from '@/lib/byok/__fixtures__'
import { getBlockDef } from '@/lib/pipeline/registry'
import { blockProps, jobSnapshot, latestExecute, renderGenerationBlock, stubGenerationFetch } from '@/test-utils/byok-harness'

const ESTIMATE = { amount: 205, unit: 'credits', usd_equivalent: 1.03, basis: '5 s × 41 credits/s', source: 'kie pricing', as_of: '2026-11-15', confidence: 'listed' }

function seed(blockId: string, values: Record<string, unknown>) {
  for (const [k, v] of Object.entries(values)) sessionStorage.setItem(`block_${blockId}_${k}`, JSON.stringify(v))
}

beforeEach(() => sessionStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('cost estimate chip', () => {
  it('asks for the estimate of the request a run would submit (without the prompt), and shows the chip at the end of the settings row', async () => {
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH, estimate: () => ({ body: { ok: true, estimate: ESTIMATE } }) })
    seed('c1', { provider: 'kie', model: 'kling-4.0', prompt: 'slow push in', params: { duration: 5, resolution: null, aspect_ratio: null, settings: {} } })
    const props = blockProps('c1', { image: [{ kind: 'image-ref', local: '/outputs/a.png' }, { kind: 'image-ref', local: '/outputs/b.png' }] })
    renderGenerationBlock(getBlockDef('imageToVideo')!.component, props)
    const chip = await screen.findByTestId('cost-estimate-chip', {}, { timeout: 2000 })
    const row = screen.getByRole('toolbar', { name: 'Settings' })
    expect(row.lastElementChild).toContainElement(chip)
    expect(chip).toHaveTextContent('≈')

    const [estimateBody] = harness.requests('/api/generation/estimate')
    // Run once (the stub job has no output, which does not matter here) to capture the validated request.
    await act(async () => { await latestExecute(props)(props.inputs, new AbortController().signal).catch(() => undefined) })
    const [validated] = harness.requests('/api/generation/validate') as Array<{ params: Record<string, unknown> }>
    // The same request, minus the prompt (it never changes the price).
    const { prompt, ...paramsWithoutPrompt } = validated.params
    expect(prompt).toBe('slow push in')
    expect(estimateBody).toEqual({ ...validated, params: paramsWithoutPrompt })
    expect(estimateBody).toMatchObject({
      provider: 'kie', model: 'kling-4.0', mode: 'image_to_video',
      references: [
        { kind: 'image', role: 'first_frame', local: '/outputs/a.png' },
        { kind: 'image', role: 'last_frame', local: '/outputs/b.png' },
      ],
    })
  })

  it('makes no estimate call without a configured key or with an unavailable model', async () => {
    const none = stubGenerationFetch({ catalog: CATALOG_NONE, estimate: () => ({ body: { ok: true, estimate: ESTIMATE } }) })
    renderGenerationBlock(getBlockDef('textToVideo')!.component, blockProps('c2'))
    await screen.findAllByRole('combobox', { name: 'Model' })
    await new Promise((r) => setTimeout(r, 600))
    expect(none.requests('/api/generation/estimate')).toHaveLength(0)

    sessionStorage.clear()
    const unavailable = stubGenerationFetch({ catalog: CATALOG_BOTH, estimate: () => ({ body: { ok: true, estimate: ESTIMATE } }) })
    seed('c3', { provider: 'piapi', model: 'wan-3.0' })
    renderGenerationBlock(getBlockDef('textToVideo')!.component, blockProps('c3'))
    await new Promise((r) => setTimeout(r, 600))
    expect(unavailable.requests('/api/generation/estimate')).toHaveLength(0)
    expect(screen.queryByTestId('cost-estimate-chip')).toBeNull()
  })

  it('removes the chip when the estimate becomes null', async () => {
    const user = userEvent.setup()
    let priced = true
    stubGenerationFetch({ catalog: CATALOG_BOTH, estimate: () => ({ body: { ok: true, estimate: priced ? ESTIMATE : null } }) })
    seed('c4', { provider: 'kie', model: 'seedance-2', prompt: 'a' })
    renderGenerationBlock(getBlockDef('textToVideo')!.component, blockProps('c4'))
    await screen.findByTestId('cost-estimate-chip', {}, { timeout: 2000 })
    priced = false
    await user.click(screen.getByRole('button', { name: 'Resolution: 720p' }))
    await user.click(await screen.findByRole('menuitemradio', { name: '1080p' }))
    await waitFor(() => expect(screen.queryByTestId('cost-estimate-chip')).toBeNull(), { timeout: 2000 })
  })

  it('opens its tooltip on hover and does not leave it open after a click', async () => {
    const user = userEvent.setup()
    stubGenerationFetch({ catalog: CATALOG_BOTH, estimate: () => ({ body: { ok: true, estimate: ESTIMATE } }) })
    seed('c5', { provider: 'kie', model: 'seedance-2', prompt: 'a' })
    renderGenerationBlock(getBlockDef('textToVideo')!.component, blockProps('c5'))
    const chip = await screen.findByTestId('cost-estimate-chip', {}, { timeout: 2000 })
    await user.hover(chip)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('5 s × 41 credits/s')
    await user.click(chip)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

const UNAVAILABLE = {
  code: 'priced_per_token',
  message: 'Kie prices this model per token, so the cost depends on the output and cannot be estimated up front. The actual charge will be shown after the run.',
}

describe('no-estimate chip', () => {
  it('shows a muted "No estimate" chip with the reason when the price is unknown', async () => {
    const user = userEvent.setup()
    stubGenerationFetch({ catalog: CATALOG_BOTH, estimate: () => ({ body: { ok: true, estimate: null, unavailable: UNAVAILABLE } }) })
    seed('u1', { provider: 'kie', model: 'seedance-2', prompt: 'a' })
    renderGenerationBlock(getBlockDef('textToVideo')!.component, blockProps('u1'))
    const chip = await screen.findByTestId('cost-unavailable-chip', {}, { timeout: 2000 })
    expect(chip).toHaveTextContent('No estimate')
    expect(chip.querySelector('svg')).not.toBeNull()
    expect(chip).toHaveAccessibleName(/No cost estimate/)
    expect(screen.queryByTestId('cost-estimate-chip')).toBeNull()
    const row = screen.getByRole('toolbar', { name: 'Settings' })
    expect(row.lastElementChild).toContainElement(chip)
    await user.hover(chip)
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Kie prices this model per token')
    expect(tip).toHaveTextContent('The actual cost is shown in the output viewer after the run.')
    expect(tip).not.toHaveTextContent('The actual charge will be shown after the run.')
  })

  it('does not flash "No estimate" while the first estimate loads', async () => {
    let release: (() => void) | null = null
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH, estimate: () => ({ body: { ok: true, estimate: ESTIMATE } }) })
    const original = harness.fetchMock.getMockImplementation()!
    harness.fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/api/generation/estimate') await new Promise<void>((resolve) => { release = resolve })
      return original(input, init)
    })
    seed('u2', { provider: 'kie', model: 'seedance-2', prompt: 'a' })
    renderGenerationBlock(getBlockDef('textToVideo')!.component, blockProps('u2'))
    await waitFor(() => expect(release).not.toBeNull(), { timeout: 2000 })
    expect(screen.queryByTestId('cost-unavailable-chip')).toBeNull()
    expect(screen.queryByTestId('cost-estimate-chip')).toBeNull()
    act(() => release!())
    expect(await screen.findByTestId('cost-estimate-chip')).toHaveTextContent('205')
  })

  it('keeps the previous estimate while loading, then switches to "No estimate"', async () => {
    const user = userEvent.setup()
    let priced = true
    let release: (() => void) | null = null
    const harness = stubGenerationFetch({
      catalog: CATALOG_BOTH,
      estimate: () => ({ body: priced ? { ok: true, estimate: ESTIMATE } : { ok: true, estimate: null, unavailable: UNAVAILABLE } }),
    })
    seed('u3', { provider: 'kie', model: 'seedance-2', prompt: 'a' })
    renderGenerationBlock(getBlockDef('textToVideo')!.component, blockProps('u3'))
    await screen.findByTestId('cost-estimate-chip', {}, { timeout: 2000 })
    const original = harness.fetchMock.getMockImplementation()!
    harness.fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/api/generation/estimate') {
        await new Promise<void>((resolve) => { release = resolve })
        priced = false
      }
      return original(input, init)
    })
    await user.click(screen.getByRole('button', { name: 'Resolution: 720p' }))
    await user.click(await screen.findByRole('menuitemradio', { name: '1080p' }))
    await waitFor(() => expect(release).not.toBeNull(), { timeout: 2000 })
    expect(screen.getByTestId('cost-estimate-chip')).toHaveTextContent('205')
    expect(screen.queryByTestId('cost-unavailable-chip')).toBeNull()
    act(() => release!())
    expect(await screen.findByTestId('cost-unavailable-chip')).toBeInTheDocument()
    expect(screen.queryByTestId('cost-estimate-chip')).toBeNull()
  })

  it('shows no chip at all when the provider is not configured', async () => {
    stubGenerationFetch({ catalog: CATALOG_NONE, estimate: () => ({ body: { ok: true, estimate: null, unavailable: UNAVAILABLE } }) })
    renderGenerationBlock(getBlockDef('textToVideo')!.component, blockProps('u4'))
    await screen.findAllByRole('combobox', { name: 'Model' })
    await new Promise((r) => setTimeout(r, 600))
    expect(screen.queryByTestId('cost-unavailable-chip')).toBeNull()
    expect(screen.queryByTestId('cost-estimate-chip')).toBeNull()
  })
})

describe('estimate stability', () => {
  it('does not re-request while typing the prompt and the chip stays mounted throughout', async () => {
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH, estimate: () => ({ body: { ok: true, estimate: ESTIMATE } }) })
    seed('s1', { provider: 'kie', model: 'seedance-2', prompt: 'a' })
    renderGenerationBlock(getBlockDef('textToVideo')!.component, blockProps('s1'))
    const chip = await screen.findByTestId('cost-estimate-chip', {}, { timeout: 2000 })
    const before = harness.requests('/api/generation/estimate').length
    expect(harness.requests('/api/generation/estimate')[0]).not.toHaveProperty('params.prompt')
    const prompt = screen.getByLabelText('Generation Prompt')
    for (const text of ['a c', 'a ca', 'a cat', 'a cat on a roof']) {
      fireEvent.change(prompt, { target: { value: text } })
      expect(screen.getByTestId('cost-estimate-chip')).toBe(chip)
    }
    await new Promise((r) => setTimeout(r, 600))
    expect(harness.requests('/api/generation/estimate')).toHaveLength(before)
    expect(screen.getByTestId('cost-estimate-chip')).toBe(chip)
  })

  it('keeps the previous value visible while a new estimate loads', async () => {
    const user = userEvent.setup()
    let release: (() => void) | null = null
    let amount = 205
    stubGenerationFetch({ catalog: CATALOG_BOTH, estimate: () => ({ body: { ok: true, estimate: { ...ESTIMATE, amount } } }) })
    seed('s2', { provider: 'kie', model: 'seedance-2', prompt: 'a' })
    renderGenerationBlock(getBlockDef('textToVideo')!.component, blockProps('s2'))
    expect(await screen.findByTestId('cost-estimate-chip', {}, { timeout: 2000 })).toHaveTextContent('205')
    // Hold the next estimate response.
    const fetchMock = vi.mocked(fetch)
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/api/generation/estimate') {
        await new Promise<void>((resolve) => { release = resolve })
        amount = 410
      }
      return original(input, init)
    })
    await user.click(screen.getByRole('button', { name: 'Resolution: 720p' }))
    await user.click(await screen.findByRole('menuitemradio', { name: '1080p' }))
    await waitFor(() => expect(release).not.toBeNull(), { timeout: 2000 })
    expect(screen.getByTestId('cost-estimate-chip')).toHaveTextContent('205')
    act(() => release!())
    await waitFor(() => expect(screen.getByTestId('cost-estimate-chip')).toHaveTextContent('410'))
  })
})

describe('estimate after the block was not estimable', () => {
  it("never shows the previous model's price while the new model's estimate loads", async () => {
    const user = userEvent.setup()
    let release: (() => void) | null = null
    let hold = false
    const harness = stubGenerationFetch({
      catalog: CATALOG_BOTH,
      estimate: (body) => ({ body: { ok: true, estimate: { ...ESTIMATE, amount: (body as { model: string }).model === 'wan-3.0' ? 111 : 999 } } }),
    })
    const original = harness.fetchMock.getMockImplementation()!
    harness.fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/api/generation/estimate' && hold) await new Promise<void>((resolve) => { release = resolve })
      return original(input, init)
    })
    seed('e1', { provider: 'kie', model: 'wan-3.0', prompt: 'a' })
    renderGenerationBlock(getBlockDef('textToVideo')!.component, blockProps('e1'))
    expect(await screen.findByTestId('cost-estimate-chip', {}, { timeout: 2000 })).toHaveTextContent('111')

    // PiAPI does not offer Wan 3.0: no estimate, no chip.
    await user.click(screen.getByRole('combobox', { name: 'Provider' }))
    await user.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('PiAPI'))!)
    await waitFor(() => expect(screen.queryByTestId('cost-estimate-chip')).toBeNull())

    // A model PiAPI offers: while its estimate loads, Wan 3.0's price must not come back.
    hold = true
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    await user.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Seedance 2') && !/Seedance 2(\.5| Fast| Mini)/.test(o.textContent ?? ''))!)
    await waitFor(() => expect(release).not.toBeNull(), { timeout: 2000 })
    expect(screen.queryByTestId('cost-estimate-chip')).toBeNull()
    act(() => release!())
    expect(await screen.findByTestId('cost-estimate-chip')).toHaveTextContent('999')
  })
})

describe('actual cost is not shown in the generation block', () => {
  it('renders no job cost after a job with a cost finishes, and puts it on the output ref', async () => {
    stubGenerationFetch({
      catalog: CATALOG_BOTH,
      jobs: [jobSnapshot({ job_id: 'job-9', provider: 'kie', model: 'seedance-2', status: 'COMPLETED', outputs: [{ kind: 'video', url: 'https://cdn/o.mp4' }], cost: { amount: 210, unit: 'credits', usd_equivalent: 1.05 } })],
    })
    seed('j1', { provider: 'kie', model: 'seedance-2', prompt: 'a' })
    const props = blockProps('j1')
    renderGenerationBlock(getBlockDef('textToVideo')!.component, props)
    await screen.findAllByRole('combobox', { name: 'Model' })
    await act(async () => { await latestExecute(props)({}, new AbortController().signal) })
    expect(screen.queryByTestId('job-cost-badge')).toBeNull()
    expect(props.setOutput).toHaveBeenLastCalledWith('video', expect.objectContaining({
      local: 'https://cdn/o.mp4',
      meta: { job_id: 'job-9', provider: 'kie', model: 'seedance-2', cost: { amount: 210, unit: 'credits', usd_equivalent: 1.05 } },
    }))
  })

  // The price check is computed with the cost, so it arrives late together with it.
  const LATE_CHECK = {
    expected: { amount: 10, unit: 'credits' }, actual: { amount: 12, unit: 'credits' }, source: 'bundled',
    differs: true, checked_at: '2026-11-15T10:00:00Z', report_url: null,
  }
  it('updates the output ref when the provider reports the cost after the job finished', async () => {
    const done = jobSnapshot({ job_id: 'job-10', provider: 'kie', model: 'seedance-2', status: 'COMPLETED', outputs: [{ kind: 'video', url: 'https://cdn/o.mp4' }], cost: null })
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH, jobs: [done] })
    seed('j2', { provider: 'kie', model: 'seedance-2', prompt: 'a' })
    const props = blockProps('j2')
    renderGenerationBlock(getBlockDef('textToVideo')!.component, props, )
    await screen.findAllByRole('combobox', { name: 'Model' })
    await act(async () => { await latestExecute(props)({}, new AbortController().signal) })
    expect(props.setOutput).toHaveBeenLastCalledWith('video', expect.objectContaining({ meta: expect.objectContaining({ cost: null }) }))
    // The job store now has the late charge.
    harness.fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/api/jobs/job-10') {
        return new Response(JSON.stringify({ ok: true, job: { ...done, cost: { amount: 12, unit: 'credits', usd_equivalent: null }, price_check: LATE_CHECK } }))
      }
      return new Response(JSON.stringify({ ok: true }))
    })
    await waitFor(() => expect(props.setOutput).toHaveBeenLastCalledWith('video', expect.objectContaining({
      meta: expect.objectContaining({ cost: { amount: 12, unit: 'credits', usd_equivalent: null }, price_check: LATE_CHECK }),
    })), { timeout: 3000 })
  })
})
