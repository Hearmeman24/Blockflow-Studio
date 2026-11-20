/**
 * Character Swap: a generation block with a default prompt the user can edit,
 * five models, one driving video and one image. Its two loaders arrive with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { SWRConfig } from 'swr'

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/api', () => ({
  saveRun: vi.fn(() => Promise.resolve({ ok: true })),
  fetchFlow: vi.fn(),
  fetchFlows: vi.fn(() => Promise.resolve({ ok: true, flows: [] })),
  saveFlowToDisk: vi.fn(),
}))

import '@/components/pipeline/custom_blocks/_register'
import { BlockCard } from '@/components/pipeline/block-card'
import { CATALOG_BOTH, CATALOG_KIE, CATALOG_PIAPI } from '@/lib/byok/__fixtures__'
import { modelAvailability } from '@/lib/byok/catalog'
import type { ProviderCatalog } from '@/lib/byok/types'
import { BlockLayoutProvider } from '@/lib/pipeline/block-layout-context'
import { exportFlow, importFlow } from '@/lib/pipeline/flow-io'
import { PipelineProvider, usePipeline } from '@/lib/pipeline/pipeline-context'
import { getBlockDef, type BlockDef } from '@/lib/pipeline/registry'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { walkBlocks } from '@/lib/pipeline/tree-utils'
import { blockProps, jobSnapshot, latestExecute, renderGenerationBlock, stubGenerationFetch } from '@/test-utils/byok-harness'

const MODELS = ['wan-3.0', 'wan-3.0-prime', 'seedance-2.5', 'seedance-2', 'kling-4.0']
const NAMES = ['Wan 3.0', 'Wan 3.0 Prime', 'Seedance 2.5', 'Seedance 2', 'Kling 4.0']
const VIDEO = { kind: 'video-ref', local: '/outputs/drive.mp4' }
const IMAGE = { kind: 'image-ref', local: '/outputs/face.png' }
const BOTH = { video: [VIDEO], image: [IMAGE] }

function def(): BlockDef {
  const found = getBlockDef('characterSwap')
  if (!found) throw new Error('characterSwap is not registered')
  return found
}

function seed(blockId: string, values: Record<string, unknown>) {
  for (const [k, v] of Object.entries(values)) sessionStorage.setItem(`block_${blockId}_${k}`, JSON.stringify(v))
}

const optionName = (o: HTMLElement) => {
  const copy = within(o).getByTestId('model-option-name').cloneNode(true) as HTMLElement
  copy.querySelectorAll('.sr-only').forEach((el) => el.remove())
  return copy.textContent
}

async function mount(blockId: string, inputs: Record<string, unknown> = BOTH, catalog: ProviderCatalog = CATALOG_BOTH) {
  const harness = stubGenerationFetch({
    catalog,
    jobs: [jobSnapshot({ status: 'COMPLETED', outputs: [{ kind: 'video', url: 'https://cdn/out.mp4' }] })],
  })
  const props = blockProps(blockId, inputs)
  const view = renderGenerationBlock(def().component, props)
  await screen.findByRole('combobox', { name: 'Model' })
  return { harness, props, view }
}

async function run(props: ReturnType<typeof blockProps>, inputs: Record<string, unknown>, signal = new AbortController().signal) {
  let error: unknown
  await act(async () => {
    error = await latestExecute(props)(inputs, signal).then(() => undefined, (e) => e)
  })
  return error as Error | undefined
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})
afterEach(() => vi.unstubAllGlobals())

describe('Character Swap definition', () => {
  it('is a video generation block fed by a video and an image, with no prompt input', () => {
    const d = def()
    expect(d).toMatchObject({ label: 'Character Swap', role: 'video', size: 'lg', canStart: true })
    expect(d.inputs.map((p) => [p.name, p.kind, p.required])).toEqual([['video', 'video', false], ['image', 'image', false]])
    expect(d.outputs.map((p) => p.name)).toEqual(['video'])
    expect(d.starterPrereqs).toEqual(['videoLoader', 'uploadImageToTmpfiles'])
    expect(d.configKeys).toEqual(['provider', 'model', 'prompt', 'params'])
  })

  it('declares its usage notes through the shared info primitive', () => {
    expect(def().info).toEqual([
      'Put the driving video in the Video Loader.',
      'Put an image of the person to swap in, in the Image Loader.',
      'Wan 3.0 and Seedance 2.5 give the best quality.',
      'Wan 3.0 Prime is the faster Wan 3.0 and costs more per second.',
      "Seedance 2 and Kling 4.0 are alternatives; the cost chip shows each model's price.",
      'The prompt is written for the selected model; you can edit it.',
    ])
  })
})

describe('Character Swap models', () => {
  it.each([
    ['both keys, Kie selected', CATALOG_BOTH, 'kie'],
    ['both keys, PiAPI selected', CATALOG_BOTH, 'piapi'],
    ['Kie key only', CATALOG_KIE, 'kie'],
    ['PiAPI key only', CATALOG_PIAPI, 'piapi'],
    ['PiAPI key only, Kie selected', CATALOG_PIAPI, 'kie'],
  ])('lists exactly the five models, each one available as the catalog says (%s)', async (_, catalog, provider) => {
    const user = userEvent.setup()
    seed('m1', { provider })
    await mount('m1', BOTH, catalog)
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    const options = screen.getAllByRole('option')
    expect(options.map(optionName)).toEqual(NAMES)
    options.forEach((option, i) => {
      const { available, reason } = modelAvailability(catalog, MODELS[i], provider, 'omni_reference_to_video')
      expect(option.getAttribute('aria-disabled') === 'true', NAMES[i]).toBe(!available)
      if (reason) expect(option).toHaveTextContent(reason)
    })
  })

  it('Wan 3.0 cannot be chosen on PiAPI, and the reason is shown', async () => {
    const user = userEvent.setup()
    seed('m2', { provider: 'piapi' })
    await mount('m2')
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    const wan = screen.getAllByRole('option').find((o) => optionName(o) === 'Wan 3.0')!
    expect(wan).toHaveAttribute('aria-disabled', 'true')
    expect(wan).toHaveTextContent('Not offered by PiAPI')
  })

  it('a saved model outside the four is replaced by an allowed one', async () => {
    seed('m3', { provider: 'kie', model: 'seedance-2-fast' })
    const { props } = await mount('m3')
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('Wan 3.0')
    expect(await run(props, BOTH)).toBeUndefined()
  })
})

const PLAIN = 'Replace the person from Video1 with the person from Image1'
const AT = 'Replace the person from @video1 with the person from @image1'
const AT_UNDERSCORE = 'Replace the person from @video_1 with the person from @image_1'
const RESET = 'Reset to default'
const NEEDS_PROMPT = 'Character Swap needs a prompt. Write one, or reset it to the default.'
// "(optional)" for Wan 3.0, whose prompt the ledger marks optional.
const promptBox = () => screen.getByRole('textbox', { name: /^Generation Prompt/ }) as HTMLTextAreaElement
/** The coloured mentions of the prompt's highlight layer, as [text, kind]. */
const coloured = () => Array.from(screen.getByTestId('mention-highlight').querySelectorAll('[data-mention-kind]'))
  .map((el) => [el.textContent, el.getAttribute('data-mention-kind')])

async function chooseModel(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('combobox', { name: 'Model' }))
  await user.click(screen.getAllByRole('option').find((o) => optionName(o) === name)!)
}

describe('Character Swap prompt', () => {
  it('is an editable prompt box filled with the default, with the reference badges and the prompt library', async () => {
    seed('f1', { provider: 'kie', model: 'wan-3.0' })
    await mount('f1')
    expect(promptBox()).toHaveValue(PLAIN)
    expect(promptBox()).not.toHaveAttribute('readonly')
    const badges = screen.getByRole('group', { name: 'Insert a reference' })
    expect(within(badges).getAllByRole('button').map((b) => b.textContent)).toEqual(['Image 1', 'Video 1'])
    expect(screen.getByRole('button', { name: 'Saved generation prompts' })).toBeInTheDocument()
    expect(coloured()).toEqual([['Video1', 'video'], ['Image1', 'image']])
    // The default needs no way back.
    expect(screen.queryByRole('button', { name: RESET })).toBeNull()
    expect(screen.queryByTestId('fixed-prompt')).toBeNull()
  })

  it('a fresh block shows the reference names of the selected provider and model', async () => {
    seed('f2', { provider: 'piapi', model: 'seedance-2' })
    await mount('f2')
    await waitFor(() => expect(promptBox()).toHaveValue(AT))
    expect(coloured()).toEqual([['@video1', 'video'], ['@image1', 'image']])
  })

  it('while it is the default, it follows a model or provider change', async () => {
    const user = userEvent.setup()
    seed('f6', { provider: 'kie', model: 'wan-3.0' })
    const { harness, props } = await mount('f6')
    await chooseModel(user, 'Kling 4.0')
    await waitFor(() => expect(promptBox()).toHaveValue(AT_UNDERSCORE))
    expect(JSON.parse(sessionStorage.getItem('block_f6_prompt')!)).toBe(AT_UNDERSCORE)
    await user.click(screen.getByRole('combobox', { name: 'Provider' }))
    await user.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('PiAPI'))!)
    await chooseModel(user, 'Seedance 2')
    await waitFor(() => expect(promptBox()).toHaveValue(AT))
    expect(screen.queryByRole('button', { name: RESET })).toBeNull()
    expect(await run(props, BOTH)).toBeUndefined()
    const [submitted] = harness.requests('/api/generation/submit') as Array<{ params: { prompt: string } }>
    expect(submitted.params.prompt).toBe(AT)
  })

  it('an edited prompt is kept as written through a model change, and is what the block sends', async () => {
    const user = userEvent.setup()
    seed('f7', { provider: 'kie', model: 'wan-3.0' })
    const { harness, props } = await mount('f7')
    const box = promptBox()
    box.focus()
    box.setSelectionRange(PLAIN.length, PLAIN.length)
    await user.keyboard(', keep the lighting')
    const edited = `${PLAIN}, keep the lighting`
    expect(box).toHaveValue(edited)
    await chooseModel(user, 'Kling 4.0')
    expect(promptBox()).toHaveValue(edited)
    // Video1 and Image1 are not Kling's names, so they are no longer coloured.
    expect(coloured()).toEqual([])
    expect(await run(props, BOTH)).toBeUndefined()
    const [submitted] = harness.requests('/api/generation/submit') as Array<{ params: { prompt: string } }>
    expect(submitted.params.prompt).toBe(edited)
  })

  it('Reset to default brings back the default for the selected model', async () => {
    const user = userEvent.setup()
    seed('f8', { provider: 'kie', model: 'kling-4.0', prompt: 'swap @video_1 for @image_1 please' })
    await mount('f8')
    expect(promptBox()).toHaveValue('swap @video_1 for @image_1 please')
    expect(coloured()).toEqual([['@video_1', 'video'], ['@image_1', 'image']])
    await user.click(screen.getByRole('button', { name: RESET }))
    expect(promptBox()).toHaveValue(AT_UNDERSCORE)
    expect(screen.queryByRole('button', { name: RESET })).toBeNull()
    // Back to the default: it follows the model again.
    await chooseModel(user, 'Wan 3.0')
    await waitFor(() => expect(promptBox()).toHaveValue(PLAIN))
  })

  it('inserting a reference from a badge edits the prompt like in the other blocks', async () => {
    const user = userEvent.setup()
    seed('f9', { provider: 'kie', model: 'wan-3.0' })
    await mount('f9')
    const box = promptBox()
    box.focus()
    box.setSelectionRange(0, PLAIN.length)
    await user.click(screen.getByRole('button', { name: 'Insert reference to Image 1' }))
    expect(box).toHaveValue('Image1')
    expect(box).toHaveFocus()
    expect(coloured()).toEqual([['Image1', 'image']])
    expect(screen.getByRole('button', { name: RESET })).toBeInTheDocument()
  })

  it('an emptied prompt stays empty while typing; the run stops before anything is sent', async () => {
    const user = userEvent.setup()
    seed('f10', { provider: 'kie', model: 'kling-4.0' })
    const { harness, props } = await mount('f10')
    await user.clear(promptBox())
    expect(promptBox()).toHaveValue('')
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(promptBox()).toHaveValue('')
    expect(JSON.parse(sessionStorage.getItem('block_f10_prompt')!)).toBe('')
    expect(screen.getByRole('button', { name: RESET })).toBeInTheDocument()

    const error = await run(props, BOTH)
    expect(error?.message).toBe(NEEDS_PROMPT)
    expect(harness.requests('/api/generation/validate')).toEqual([])
    expect(harness.requests('/api/generation/submit')).toEqual([])
    expect(promptBox()).toHaveValue('')
  })

  it.each(['wan-3.0', 'wan-3.0-prime'])('needs a prompt even where the ledger marks it optional (%s): the label does not say optional', async (model) => {
    seed(`f12-${model}`, { provider: 'kie', model })
    await mount(`f12-${model}`)
    expect(screen.getByRole('textbox', { name: 'Generation Prompt' })).toHaveValue(PLAIN)
    expect(screen.queryByRole('textbox', { name: 'Generation Prompt (optional)' })).toBeNull()
    expect(screen.queryByText(NEEDS_PROMPT)).toBeNull()
  })

  it.each([
    ['An empty', ''],
    ['A whitespace-only', ' \n\t '],
  ])('%s prompt on Wan 3.0 blocks the run before anything is sent, says so, and Reset makes it ready again', async (_, text) => {
    const user = userEvent.setup()
    seed('f13', { provider: 'kie', model: 'wan-3.0' })
    const { harness, props } = await mount('f13')
    fireEvent.change(promptBox(), { target: { value: text } })
    // Shown before any run, with the block's other blocking issues.
    const panel = (await screen.findByText('Fix before running')).closest('[role]') ?? document.body
    expect(within(panel as HTMLElement).getByText(NEEDS_PROMPT)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: RESET })).toBeVisible()

    expect((await run(props, BOTH))?.message).toBe(NEEDS_PROMPT)
    expect(harness.requests('/api/generation/validate')).toEqual([])
    expect(harness.requests('/api/generation/submit')).toEqual([])
    expect(props.setOutput).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: RESET }))
    expect(promptBox()).toHaveValue(PLAIN)
    await waitFor(() => expect(screen.queryByText(NEEDS_PROMPT)).toBeNull())
    expect(screen.queryByText('Fix before running')).toBeNull()
    expect(await run(props, BOTH)).toBeUndefined()
    const [submitted] = harness.requests('/api/generation/submit') as Array<{ params: { prompt: string } }>
    expect(submitted.params.prompt).toBe(PLAIN)
  })

  it('PiAPI does not run Kling 4.0 here: the option says why, and a saved choice stops the run before anything is sent', async () => {
    const user = userEvent.setup()
    const { reason } = modelAvailability(CATALOG_BOTH, 'kling-4.0', 'piapi', 'omni_reference_to_video')
    expect(reason).toMatch(/PiAPI/)
    seed('f5', { provider: 'piapi', model: 'kling-4.0' })
    const { harness, props } = await mount('f5')
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    const kling = screen.getAllByRole('option').find((o) => optionName(o) === 'Kling 4.0')!
    expect(kling).toHaveAttribute('aria-disabled', 'true')
    expect(kling).toHaveTextContent(reason!)
    await user.keyboard('{Escape}')
    expect((await run(props, BOTH))?.message).toBe(reason)
    expect(harness.requests('/api/generation/validate')).toEqual([])
    expect(harness.requests('/api/generation/submit')).toEqual([])
  })

  it.each([
    ['kie', 'wan-3.0', 'Replace the person from Video1 with the person from Image1'],
    ['kie', 'seedance-2.5', 'Replace the person from Video1 with the person from Image1'],
    ['piapi', 'seedance-2.5', 'Replace the person from @video1 with the person from @image1'],
    ['kie', 'seedance-2', 'Replace the person from Video1 with the person from Image1'],
    ['piapi', 'seedance-2', 'Replace the person from @video1 with the person from @image1'],
    ['kie', 'kling-4.0', 'Replace the person from @video_1 with the person from @image_1'],
  ])('%s %s: the request carries the default prompt, the video and the image', async (provider, model, prompt) => {
    seed('f3', { provider, model })
    const { harness, props } = await mount('f3')
    expect(await run(props, BOTH)).toBeUndefined()
    const [validated] = harness.requests('/api/generation/validate')
    const [submitted] = harness.requests('/api/generation/submit')
    expect(validated).toEqual({
      provider, model, mode: 'omni_reference_to_video',
      params: { prompt, settings: {} },
      references: [
        { kind: 'video', role: 'reference', local: '/outputs/drive.mp4' },
        { kind: 'image', role: 'reference', local: '/outputs/face.png' },
      ],
    })
    expect(submitted).toEqual({ ...(validated as object), source: 'pipeline', client_request_id: expect.stringMatching(/^blk-/) })
    expect(props.setOutput).toHaveBeenCalledWith('video', expect.objectContaining({ kind: 'video-ref', url: 'https://cdn/out.mp4' }))
  })

  it('ignores text from upstream: no switch, and it sends its own prompt', async () => {
    seed('f4', { provider: 'kie', model: 'wan-3.0', prompt: 'something else', use_upstream_prompt: true })
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH, jobs: [jobSnapshot({ status: 'COMPLETED', outputs: [{ kind: 'video', url: 'https://cdn/o.mp4' }] })] })
    const props = { ...blockProps('f4', { ...BOTH, text: 'a prompt from upstream' }), hasUpstreamProducer: vi.fn(() => true) }
    renderGenerationBlock(def().component, props)
    await screen.findByRole('combobox', { name: 'Model' })
    expect(screen.queryByTestId('upstream-prompt-source')).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Use the upstream prompt' })).toBeNull()
    expect(promptBox()).toHaveValue('something else')
    expect(await run(props, { ...BOTH, text: 'a prompt from upstream' })).toBeUndefined()
    const [submitted] = harness.requests('/api/generation/submit') as Array<{ params: { prompt: string } }>
    expect(submitted.params.prompt).toBe('something else')
  })

  it('ignores upstream text with the default prompt too', async () => {
    seed('f11', { provider: 'kie', model: 'wan-3.0', use_upstream_prompt: true })
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH, jobs: [jobSnapshot({ status: 'COMPLETED', outputs: [{ kind: 'video', url: 'https://cdn/o.mp4' }] })] })
    const props = { ...blockProps('f11', { ...BOTH, text: 'a prompt from upstream' }), hasUpstreamProducer: vi.fn(() => true) }
    renderGenerationBlock(def().component, props)
    await screen.findByRole('combobox', { name: 'Model' })
    expect(await run(props, { ...BOTH, text: 'a prompt from upstream' })).toBeUndefined()
    const [submitted] = harness.requests('/api/generation/submit') as Array<{ params: { prompt: string } }>
    expect(submitted.params.prompt).toBe(PLAIN)
  })
})

describe('Character Swap prompt saved before it was editable', () => {
  it('the old fixed text of another model loads as the default and follows the selected model', async () => {
    // A flow saved on Kie, its model since switched to PiAPI Seedance 2 in the file.
    seed('o1', { provider: 'piapi', model: 'seedance-2', prompt: PLAIN })
    const { harness, props } = await mount('o1')
    await waitFor(() => expect(promptBox()).toHaveValue(AT))
    expect(screen.queryByRole('button', { name: RESET })).toBeNull()
    expect(await run(props, BOTH)).toBeUndefined()
    const [submitted] = harness.requests('/api/generation/submit') as Array<{ params: { prompt: string } }>
    expect(submitted.params.prompt).toBe(AT)
  })

  it('a saved run or flow holding the old text for its own model loads unchanged, as the default', async () => {
    const user = userEvent.setup()
    seed('o2', { provider: 'kie', model: 'kling-4.0', prompt: AT_UNDERSCORE })
    await mount('o2')
    expect(promptBox()).toHaveValue(AT_UNDERSCORE)
    expect(screen.queryByRole('button', { name: RESET })).toBeNull()
    await chooseModel(user, 'Wan 3.0')
    await waitFor(() => expect(promptBox()).toHaveValue(PLAIN))
  })
})

describe('Character Swap needs one video and one image', () => {
  async function refused(id: string, inputs: Record<string, unknown>) {
    seed(id, { provider: 'kie', model: 'wan-3.0' })
    const { harness, props } = await mount(id, inputs)
    const error = await run(props, inputs)
    expect(harness.requests('/api/generation/validate')).toEqual([])
    expect(harness.requests('/api/generation/submit')).toEqual([])
    expect(props.setOutput).not.toHaveBeenCalled()
    return error
  }

  it('no video: the run stops with a readable error and nothing is sent', async () => {
    const error = await refused('n1', { image: [IMAGE] })
    expect(error?.message).toBe('Character Swap needs one video and has none.')
  })

  it('no image: the run stops with a readable error and nothing is sent', async () => {
    const error = await refused('n2', { video: [VIDEO] })
    expect(error?.message).toBe('Character Swap needs one image and has none.')
  })

  it('nothing connected: the first missing kind is named', async () => {
    expect((await refused('n3', {}))?.message).toMatch(/^Character Swap needs one video and has none\./)
  })

  it('two images or two videos: the run stops, because the prompt names only the first', async () => {
    const twoImages = await refused('n4', { video: [VIDEO], image: [IMAGE, { kind: 'image-ref', local: '/outputs/other.png' }] })
    expect(twoImages?.message).toMatch(/^Character Swap uses one image, but 2 are connected\./)
    const twoVideos = await refused('n5', { video: [VIDEO, { kind: 'video-ref', local: '/outputs/b.mp4' }], image: [IMAGE] })
    expect(twoVideos?.message).toMatch(/^Character Swap uses one video, but 2 are connected\./)
  })

  it('a video that was never saved stops the run and says where to fix it', async () => {
    const unsaved = { video: [{ kind: 'video-ref', local: 'blob:unsaved', label: 'drive.mp4' }], image: [IMAGE] }
    const error = await refused('n6', unsaved)
    expect(error?.message).toBe(
      'drive.mp4: The upstream file has not been saved yet. Run the upstream block or re-add the file. Fix it in the loader block.',
    )
  })

  it('before a run the missing items are a neutral hint, and an error after one', async () => {
    seed('n7', { provider: 'kie', model: 'wan-3.0' })
    const { props } = await mount('n7', {})
    expect(screen.getByTestId('reference-hint')).toHaveTextContent('Character Swap needs one video and has none.')
    expect(screen.getByTestId('reference-hint')).toHaveTextContent('Character Swap needs one image and has none.')
    expect(screen.queryByText('Fix before running')).toBeNull()
    await run(props, {})
    expect(await screen.findByText('Fix before running')).toBeInTheDocument()
  })

  it('shows no issue once one video and one image arrive', async () => {
    seed('n8', { provider: 'kie', model: 'wan-3.0' })
    await mount('n8')
    expect(screen.queryByTestId('reference-hint')).toBeNull()
    expect(screen.queryByText('Fix before running')).toBeNull()
  })
})

describe('Character Swap cancellation and failures', () => {
  it('stops with an AbortError and cancels the job when the pipeline aborts', async () => {
    seed('c1', { provider: 'kie', model: 'wan-3.0' })
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH, jobs: [jobSnapshot({ status: 'RUNNING' })] })
    const props = blockProps('c1', BOTH)
    renderGenerationBlock(def().component, props)
    await screen.findByRole('combobox', { name: 'Model' })
    const controller = new AbortController()
    let settled: unknown
    const pending = latestExecute(props)(BOTH, controller.signal).catch((e) => { settled = e })
    await waitFor(() => expect(props.setStatusMessage).toHaveBeenCalledWith('Running…'))
    await act(async () => {
      controller.abort()
      await pending
    })
    expect((settled as DOMException).name).toBe('AbortError')
    expect(props.setOutput).not.toHaveBeenCalled()
    await waitFor(() => expect(harness.fetchMock.mock.calls.some(([u]) => String(u) === '/api/jobs/job-1/cancel')).toBe(true))
  })

  it('reports the provider error and sets no output when the job fails', async () => {
    seed('c2', { provider: 'kie', model: 'wan-3.0' })
    stubGenerationFetch({
      catalog: CATALOG_BOTH,
      jobs: [jobSnapshot({ status: 'FAILED', error: { kind: 'content_policy', message: 'Kie rejected the references.' } })],
    })
    const props = blockProps('c2', BOTH)
    renderGenerationBlock(def().component, props)
    await screen.findByRole('combobox', { name: 'Model' })
    expect((await run(props, BOTH))?.message).toBe('Kie rejected the references.')
    expect(props.setOutput).not.toHaveBeenCalled()
  })

  it('does not run without a provider key', async () => {
    const { props, harness } = await mount('c3', BOTH, { ...CATALOG_BOTH, providers: Object.fromEntries(Object.entries(CATALOG_BOTH.providers).map(([id, p]) => [id, { ...p, configured: false }])) } as ProviderCatalog)
    expect((await run(props, BOTH))?.message).toMatch(/API key/)
    expect(harness.requests('/api/generation/submit')).toEqual([])
  })
})

describe('Character Swap saved with the flow', () => {
  it('round-trips provider, model and settings, and records the prompt it sends', async () => {
    const user = userEvent.setup()
    const { view } = await mount('rt-src')
    await user.click(screen.getByRole('combobox', { name: 'Provider' }))
    await user.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('PiAPI'))!)
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    await user.click(screen.getAllByRole('option').find((o) => optionName(o) === 'Seedance 2')!)

    let config: Record<string, unknown> = {}
    await waitFor(() => {
      config = exportFlow({ id: 'p', blocks: [{ id: 'rt-src', type: 'characterSwap' }] }, 'swap').blocks[0].config as Record<string, unknown>
      expect(config.prompt).toBe('Replace the person from @video1 with the person from @image1')
    })
    expect(config.provider).toBe('piapi')
    expect(config.model).toBe('seedance-2')
    expect(config).not.toHaveProperty('use_upstream_prompt')
    expect(config).not.toHaveProperty('references')
    view.unmount()

    sessionStorage.clear()
    const flow = exportFlow({ id: 'p', blocks: [{ id: 'rt-src', type: 'characterSwap' }] }, 'swap')
    flow.blocks[0].config = config
    const pipeline = importFlow(JSON.stringify(flow))
    expect(pipeline.blocks.map((b) => b.type)).toEqual(['characterSwap'])
    const { props } = await mount(pipeline.blocks[0].id)
    expect(screen.getByRole('combobox', { name: 'Provider' })).toHaveTextContent('PiAPI')
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent(/Seedance 2(?!\.5)/)
    expect(await run(props, BOTH)).toBeUndefined()
  })
})

describe('Character Swap edited prompt saved with the flow', () => {
  const EDITED = 'Put the person from Image1 into Video1, keep the background'

  it('reloads with the edit, which a model change then leaves alone', async () => {
    const user = userEvent.setup()
    const { view } = await mount('rt-edit')
    fireEvent.change(promptBox(), { target: { value: EDITED } })
    let config: Record<string, unknown> = {}
    await waitFor(() => {
      config = exportFlow({ id: 'p', blocks: [{ id: 'rt-edit', type: 'characterSwap' }] }, 'swap').blocks[0].config as Record<string, unknown>
      expect(config.prompt).toBe(EDITED)
    })
    view.unmount()

    sessionStorage.clear()
    const flow = exportFlow({ id: 'p', blocks: [{ id: 'rt-edit', type: 'characterSwap' }] }, 'swap')
    flow.blocks[0].config = config
    const pipeline = importFlow(JSON.stringify(flow))
    const { harness, props } = await mount(pipeline.blocks[0].id)
    expect(promptBox()).toHaveValue(EDITED)
    expect(screen.getByRole('button', { name: RESET })).toBeInTheDocument()
    await chooseModel(user, 'Kling 4.0')
    expect(promptBox()).toHaveValue(EDITED)
    expect(await run(props, BOTH)).toBeUndefined()
    const [submitted] = harness.requests('/api/generation/submit') as Array<{ params: { prompt: string } }>
    expect(submitted.params.prompt).toBe(EDITED)
  })
})

describe('Character Swap in a pipeline', () => {
  const captured: { api: ReturnType<typeof usePipeline> | null } = { api: null }
  function Canvas() {
    const api = usePipeline()
    useEffect(() => {
      captured.api = api
    })
    return <>{[...walkBlocks(api.pipeline.blocks)].map((block, i) => <BlockCard key={block.id} block={block} displayNumber={String(i + 1)} />)}</>
  }

  let tab = 0
  function renderFlow(blocks: unknown[]) {
    stubGenerationFetch({ catalog: CATALOG_BOTH })
    const flowJson = blocks.length > 0 ? JSON.stringify({ name: 's', version: 1, schema_version: 6, created_at: '', blocks }) : undefined
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <PipelineTabsProvider>
          <PipelineProvider tabId={`swap-${++tab}`} flowJson={flowJson}>
            <BlockLayoutProvider><Canvas /></BlockLayoutProvider>
          </PipelineProvider>
        </PipelineTabsProvider>
      </SWRConfig>,
    )
  }
  const types = () => captured.api!.pipeline.blocks.map((b) => b.type)

  it('arrives with a Video Loader and an Image Loader, both feeding it', async () => {
    renderFlow([])
    let id = ''
    act(() => { id = captured.api!.addBlock('characterSwap') })
    expect(types()).toEqual(['videoLoader', 'uploadImageToTmpfiles', 'characterSwap'])
    const [video, image] = captured.api!.pipeline.blocks
    expect(captured.api!.getPortSources(id, 'video').map((p) => p.blockId)).toEqual([video.id])
    expect(captured.api!.getPortSources(id, 'image').map((p) => p.blockId)).toEqual([image.id])
  })

  it('adds only the loader that is not already directly upstream', async () => {
    renderFlow([{ type: 'uploadImageToTmpfiles' }])
    act(() => { captured.api!.addBlock('characterSwap') })
    expect(types()).toEqual(['uploadImageToTmpfiles', 'videoLoader', 'characterSwap'])
  })

  it('shows the info button in its header, with the usage notes', async () => {
    const user = userEvent.setup()
    renderFlow([{ type: 'characterSwap' }, { type: 'videoViewer' }])
    await user.click(await screen.findByRole('button', { name: 'How to use Character Swap' }))
    const panel = await screen.findByRole('dialog', { name: 'How to use Character Swap' })
    expect(within(panel).getAllByRole('listitem').map((li) => li.textContent)).toEqual(def().info)
  })

  it('warns in the header about each missing loader and adds it in one click', async () => {
    const user = userEvent.setup()
    renderFlow([{ type: 'uploadImageToTmpfiles' }, { type: 'characterSwap' }, { type: 'videoViewer' }])
    const badge = await screen.findByRole('button', { name: '1 warning: No Video Loader before this block' })
    await user.click(badge)
    await user.click(await screen.findByRole('button', { name: 'Add Video Loader' }))
    await waitFor(() => expect(types()).toEqual(['uploadImageToTmpfiles', 'videoLoader', 'characterSwap', 'videoViewer']))
    await waitFor(() => expect(screen.queryByRole('button', { name: /No Video Loader/ })).toBeNull())
  })

  it('warns about both loaders when neither is there, and the body says which loader to add', async () => {
    renderFlow([{ type: 'characterSwap' }, { type: 'videoViewer' }])
    expect(await screen.findByRole('button', { name: '2 warnings: No Video Loader before this block' })).toBeInTheDocument()
    const hint = screen.getByTestId('reference-hint')
    expect(hint).toHaveTextContent('Character Swap needs one video and has none. Add a Video Loader before this block.')
    expect(hint).toHaveTextContent('Character Swap needs one image and has none. Add an Image Loader before this block.')
  })

  it('an empty loader is named as the place to add the missing item', async () => {
    renderFlow([{ type: 'videoLoader' }, { type: 'uploadImageToTmpfiles' }, { type: 'characterSwap' }, { type: 'videoViewer' }])
    await screen.findByRole('button', { name: 'How to use Character Swap' })
    const hint = await screen.findByTestId('reference-hint')
    expect(hint).toHaveTextContent('Character Swap needs one video and has none. Add a video in "Video Loader".')
    expect(hint).toHaveTextContent('Character Swap needs one image and has none. Add an image in "Image Loader".')
    expect(screen.queryByTestId('warning-badge')).toBeNull()
  })

  it('a pipeline run with an empty Image Loader stops at the loader, not at the provider', async () => {
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH })
    renderFlow([])
    // renderFlow stubs fetch again; keep this harness for the assertions.
    vi.stubGlobal('fetch', harness.fetchMock)
    act(() => { captured.api!.addBlock('characterSwap') })
    await screen.findByRole('combobox', { name: 'Model' })
    let result: { hadError: boolean } | undefined
    await act(async () => { result = await captured.api!.runPipeline() })
    expect(result?.hadError).toBe(true)
    expect(harness.requests('/api/generation/submit')).toEqual([])
  })
})
