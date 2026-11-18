import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'
import userEvent from '@testing-library/user-event'
import '@/components/pipeline/custom_blocks/_register'
import { getBlockPickerGroups } from '@/components/pipeline/block-picker-groups'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'
import { exportFlow, importFlow } from '@/lib/pipeline/flow-io'
import { getBlockDef, getStarterTypes, type BlockDef } from '@/lib/pipeline/registry'
import { blockProps, jobSnapshot, latestExecute, renderGenerationBlock, stubGenerationFetch } from '@/test-utils/byok-harness'

const GENERATION_TYPES = ['textToVideo', 'imageToVideo', 'textToImage', 'imageToImage', 'omniReferenceToVideo'] as const

function def(type: string): BlockDef {
  const found = getBlockDef(type)
  if (!found) throw new Error(`${type} is not registered`)
  return found
}

function seed(blockId: string, values: Record<string, unknown>) {
  for (const [k, v] of Object.entries(values)) sessionStorage.setItem(`block_${blockId}_${k}`, JSON.stringify(v))
}

const ref = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id, kind, role: 'reference', local: `/outputs/${id}`, label: id, status: 'ready', ...extra,
})

async function submitOnce(type: string, blockId: string, freshInputs: Record<string, unknown> = {}) {
  const output = def(type).outputs[0].name as 'image' | 'video'
  const harness = stubGenerationFetch({
    catalog: CATALOG_BOTH,
    jobs: [jobSnapshot({ status: 'COMPLETED', outputs: [{ kind: output, url: `https://cdn/out.${output === 'image' ? 'png' : 'mp4'}` }] })],
  })
  const props = blockProps(blockId)
  renderGenerationBlock(def(type).component, props)
  await screen.findByRole('combobox', { name: 'Model' })
  await act(async () => {
    await latestExecute(props)(freshInputs, new AbortController().signal)
  })
  const [validated] = harness.requests('/api/generation/validate')
  const [submitted] = harness.requests('/api/generation/submit')
  expect(submitted).toEqual({ ...(validated as object), source: 'pipeline', client_request_id: expect.stringMatching(/^blk-/) })
  return { submitted, props }
}

beforeEach(() => sessionStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('generation block definitions', () => {
  it.each([
    ['textToVideo', 'Text to Video', 'lg', ['text'], 'video'],
    ['imageToVideo', 'Image to Video', 'lg', ['text', 'image'], 'video'],
    ['textToImage', 'Text to Image', 'lg', ['text'], 'image'],
    ['imageToImage', 'Image to Image', 'lg', ['text', 'image'], 'image'],
    ['omniReferenceToVideo', 'Omni Reference to Video', 'huge', ['text', 'image', 'video', 'audio'], 'video'],
  ])('%s has the agreed ports and config keys', (type, label, size, inputs, output) => {
    const d = def(type)
    expect(d.label).toBe(label)
    expect(d.size).toBe(size)
    expect(d.inputs.map((p) => p.name)).toEqual(inputs)
    expect(d.inputs.every((p) => p.required === false)).toBe(true)
    expect(d.outputs.map((p) => p.name)).toEqual([output])
    expect(d.configKeys).toEqual(['provider', 'model', 'prompt', 'use_upstream_prompt', 'params'])
  })

  it('lists all five blocks in the block picker, grouped by output', () => {
    const groups = getBlockPickerGroups(getStarterTypes())
    const byGroup = Object.fromEntries(groups.map((g) => [g.key, g.items.map((i) => i.def.type)]))
    expect(byGroup.video).toEqual(expect.arrayContaining(['textToVideo', 'imageToVideo', 'omniReferenceToVideo']))
    expect(byGroup.image).toEqual(expect.arrayContaining(['textToImage', 'imageToImage']))
    const starter = getBlockPickerGroups(getStarterTypes(), { kind: 'starter' })
    expect(starter[0].items.map((i) => i.def.type)).toEqual(expect.arrayContaining([...GENERATION_TYPES]))
  })
})

describe('submit payload per mode', () => {
  it('Text to Video', async () => {
    seed('p1', { prompt: 'a cat surfing' })
    const { submitted, props } = await submitOnce('textToVideo', 'p1')
    expect(submitted).toEqual({
      provider: 'kie', model: 'seedance-2', mode: 'text_to_video',
      params: { prompt: 'a cat surfing', settings: {} },
      references: [], source: 'pipeline', client_request_id: expect.any(String),
    })
    expect(props.setOutput).toHaveBeenCalledWith('video', expect.objectContaining({ kind: 'video-ref', local: 'https://cdn/out.mp4', url: 'https://cdn/out.mp4' }))
  })

  it('Image to Video takes its frames from upstream: first image first frame, second last frame', async () => {
    seed('p2', { provider: 'kie', model: 'kling-4.0', prompt: 'slow push in' })
    const { submitted } = await submitOnce('imageToVideo', 'p2', {
      image: [
        { kind: 'image-ref', local: '/outputs/first.png', url: 'https://tmp/first.png' },
        { kind: 'image-ref', local: '/outputs/last.png' },
      ],
    })
    expect(submitted).toMatchObject({
      provider: 'kie', model: 'kling-4.0', mode: 'image_to_video',
      params: { prompt: 'slow push in', settings: {} },
      references: [
        { kind: 'image', role: 'first_frame', local: '/outputs/first.png', url: 'https://tmp/first.png' },
        { kind: 'image', role: 'last_frame', local: '/outputs/last.png' },
      ],
    })
  })

  it('Text to Image uses the upstream prompt when chosen', async () => {
    seed('p3', { use_upstream_prompt: true, prompt: 'local', params: { duration: null, resolution: null, aspect_ratio: '3:2', settings: {} } })
    const { submitted } = await submitOnce('textToImage', 'p3', { text: 'from upstream' })
    expect(submitted).toMatchObject({
      provider: 'kie', model: 'seedream-5-pro', mode: 'text_to_image',
      params: { prompt: 'from upstream', aspect_ratio: '3:2', settings: {} },
      references: [],
    })
  })

  it('Image to Image keeps the upstream order and settings', async () => {
    seed('p4', {
      prompt: 'make it night',
      params: { duration: null, resolution: null, aspect_ratio: null, settings: { nsfw_checker: true } },
    })
    const { submitted } = await submitOnce('imageToImage', 'p4', {
      image: [{ kind: 'image-ref', local: '/outputs/b.png' }, { kind: 'image-ref', local: '/outputs/a.png' }],
    })
    expect(submitted).toMatchObject({
      model: 'seedream-5-pro', mode: 'image_to_image',
      params: { prompt: 'make it night', settings: { nsfw_checker: true } },
      references: [
        { kind: 'image', role: 'reference', local: '/outputs/b.png' },
        { kind: 'image', role: 'reference', local: '/outputs/a.png' },
      ],
    })
  })

  it('Omni Reference sends every upstream kind, in port order', async () => {
    seed('p5', {
      provider: 'piapi', model: 'seedance-2', prompt: 'dance',
      params: { duration: 8, resolution: null, aspect_ratio: null, settings: { real_people: true } },
    })
    const { submitted } = await submitOnce('omniReferenceToVideo', 'p5', {
      video: '/outputs/up.mp4',
      image: [{ kind: 'image-ref', local: '/outputs/a.png' }],
      audio: [{ kind: 'audio-ref', local: '/outputs/b.mp3', duration_s: 4 }],
    })
    expect(submitted).toMatchObject({
      provider: 'piapi', model: 'seedance-2', mode: 'omni_reference_to_video',
      params: { prompt: 'dance', duration: 8, settings: { real_people: true } },
      references: [
        { kind: 'video', role: 'reference', local: '/outputs/up.mp4' },
        { kind: 'image', role: 'reference', local: '/outputs/a.png' },
        { kind: 'audio', role: 'reference', local: '/outputs/b.mp3', duration_s: 4 },
      ],
    })
  })

  it('Omni Reference on Kling 4.0 (Kie) sends sound as audio, with no name', async () => {
    seed('p6', { provider: 'kie', model: 'kling-4.0', prompt: 'The woman says the line in @sound_1' })
    const { submitted } = await submitOnce('omniReferenceToVideo', 'p6', {
      image: { kind: 'image-ref', local: '/outputs/a.png' },
      audio: [{ kind: 'audio-ref', local: '/outputs/n.mp3', label: 'n.mp3', character: 'Mia' }],
      // A value left on a retired port is not read.
      voice: [{ kind: 'voice-ref', local: '/outputs/old.mp3', name: 'Old' }],
    })
    expect((submitted as { references: unknown[] }).references).toEqual([
      { kind: 'image', role: 'reference', local: '/outputs/a.png' },
      { kind: 'audio', role: 'reference', local: '/outputs/n.mp3' },
    ])
  })
})

describe('references come only from upstream', () => {
  it('has no add, drop or upload control and no summary prose; badges show what arrives', async () => {
    stubGenerationFetch({ catalog: CATALOG_BOTH })
    seed('o1', { provider: 'kie', model: 'kling-4.0' })
    renderGenerationBlock(def('omniReferenceToVideo').component, blockProps('o1', {
      image: [{ kind: 'image-ref', local: '/outputs/a.png' }, { kind: 'image-ref', local: '/outputs/b.png' }],
      audio: [{ kind: 'audio-ref', local: '/outputs/n.mp3', character: 'Mia' }],
    }))
    await screen.findByRole('combobox', { name: 'Model' })
    expect(screen.queryByTestId('reference-drop-zone')).toBeNull()
    expect(screen.queryByTestId('loader-drop-zone')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Add (images|videos)/ })).toBeNull()
    expect(screen.queryByTestId('upstream-summary')).toBeNull()
    expect(within(screen.getByRole('group', { name: 'Insert a reference' })).getAllByRole('button').map((b) => b.textContent))
      .toEqual(['Image 1', 'Image 2', 'Mia · Audio 1'])
  })

  it('an audio badge inserts the catalog mention for the selected model (Kling 4.0 on Kie: @sound_1)', async () => {
    stubGenerationFetch({ catalog: CATALOG_BOTH })
    seed('o2', { provider: 'kie', model: 'kling-4.0' })
    renderGenerationBlock(def('omniReferenceToVideo').component, blockProps('o2', {
      image: [{ kind: 'image-ref', local: '/outputs/a.png' }],
      audio: [{ kind: 'audio-ref', local: '/outputs/n.mp3' }],
    }))
    await screen.findByRole('combobox', { name: 'Model' })
    fireEvent.click(within(screen.getByRole('group', { name: 'Insert a reference' })).getByRole('button', { name: /Audio 1/ }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: /Prompt/ })).toHaveValue('@sound_1'))
  })

  it('keeps references saved by an older version and offers to move them into a loader', async () => {
    stubGenerationFetch({ catalog: CATALOG_BOTH })
    seed('legacy', { references: [ref('old.png', 'image')] })
    const props = blockProps('legacy')
    renderGenerationBlock(def('imageToImage').component, props)
    await screen.findByRole('combobox', { name: 'Model' })
    // A non-blocking warning, published to the header badge with its fix.
    await waitFor(() => expect(props.setHeaderWarnings).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: 'legacy-references',
        message: expect.stringMatching(/^1 reference was saved in this block by an older version/),
        action: expect.objectContaining({ label: 'Move to a loader' }),
      }),
    ]))
    // Not dropped: the saved value is untouched until the user moves it.
    expect(JSON.parse(sessionStorage.getItem('block_legacy_references')!)).toHaveLength(1)
  })
})

describe('reference badges above the prompt', () => {
  const images = [{ kind: 'image-ref', local: '/outputs/a.png' }, { kind: 'image-ref', local: '/outputs/b.png' }, { kind: 'image-ref', local: '/outputs/c.png' }]

  async function renderI2I(id: string, inputs: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    stubGenerationFetch({ catalog: CATALOG_BOTH })
    seed(id, { provider: 'kie', model: 'minimax-h3-image', ...extra })
    const props = blockProps(id, inputs)
    const view = renderGenerationBlock(def('imageToImage').component, props)
    await screen.findByRole('combobox', { name: 'Model' })
    return { props, view }
  }

  it('shows one badge per upstream reference, numbered per kind, and none without references', async () => {
    const { view, props } = await renderI2I('b1', { image: images })
    const group = screen.getByRole('group', { name: 'Insert a reference' })
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Image 1', 'Image 2', 'Image 3'])
    // Reordered upstream: the badges follow.
    const Component = def('imageToImage').component
    const again = (inputs: Record<string, unknown>) => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><Component {...props} inputs={inputs} /></SWRConfig>
    )
    view.rerender(again({ image: images.slice(0, 2) }))
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Insert a reference' })).getAllByRole('button')).toHaveLength(2))
    view.rerender(again({}))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Insert a reference' })).toBeNull())
  })

  it('inserts the model syntax at the caret, replacing a selection, and keeps focus', async () => {
    const user = userEvent.setup()
    await renderI2I('b2', { image: images }, { prompt: 'put the cup on the table' })
    const prompt = screen.getByLabelText('Generation Prompt') as HTMLTextAreaElement
    prompt.focus()
    prompt.setSelectionRange(8, 11) // "cup"
    await user.click(screen.getByRole('button', { name: 'Insert reference to Image 2' }))
    expect(prompt).toHaveValue('put the <Picture 2> on the table')
    expect(prompt).toHaveFocus()
    expect(prompt.selectionStart).toBe(19)
  })

  it('appends when the prompt was never focused, and works from the keyboard', async () => {
    const user = userEvent.setup()
    await renderI2I('b3', { image: images }, { prompt: 'a cat' })
    const badge = screen.getByRole('button', { name: 'Insert reference to Image 1' })
    badge.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByLabelText('Generation Prompt')).toHaveValue('a cat <Picture 1>')
  })

  it('uses the new syntax after a model switch and leaves existing text alone', async () => {
    const user = userEvent.setup()
    await renderI2I('b4', { image: images }, { prompt: 'see <Picture 1>' })
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    await user.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Seedream 5 Pro'))!)
    await user.click(screen.getByRole('button', { name: 'Insert reference to Image 1' }))
    expect(screen.getByLabelText('Generation Prompt')).toHaveValue('see <Picture 1> Image1')
  })

  it('a saved generation prompt replaces the box; badges and counter keep working', async () => {
    const harness = stubGenerationFetch({ catalog: CATALOG_BOTH })
    const base = harness.fetchMock.getMockImplementation()!
    harness.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => (
      String(input) === '/api/prompt-library'
        ? new Response(JSON.stringify({ ok: true, prompts: [
          { id: 'g1', name: 'Night', type: 'generation', content: 'a street at night', created_at: '' },
          { id: 's1', name: 'Terse', type: 'system', content: 'be terse', created_at: '' },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : base(input, init)
    ))
    seed('b5', { provider: 'kie', model: 'minimax-h3-image', prompt: 'my draft' })
    renderGenerationBlock(def('imageToImage').component, blockProps('b5', { image: images }))
    await screen.findByRole('combobox', { name: 'Model' })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Saved generation prompts' }))
    const dialog = await screen.findByRole('dialog', { name: 'Saved generation prompts' })
    expect(within(dialog).queryByRole('button', { name: /^Use Terse/ })).toBeNull()
    await user.click(await within(dialog).findByRole('button', { name: /^Use Night/ }))

    const prompt = screen.getByLabelText('Generation Prompt')
    expect(prompt).toHaveValue('a street at night')
    expect(screen.getByText(/^17 \/ \d+ characters$/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Insert reference to Image 1' }))
    expect(prompt).toHaveValue('a street at night <Picture 1>')
    expect(JSON.parse(sessionStorage.getItem('block_b5_prompt')!)).toBe('a street at night <Picture 1>')
  })

  it('never shows badges on text-only blocks', async () => {
    stubGenerationFetch({ catalog: CATALOG_BOTH })
    renderGenerationBlock(def('textToVideo').component, blockProps('t1', { image: images }))
    await screen.findByRole('combobox', { name: 'Model' })
    expect(screen.queryByRole('group', { name: 'Insert a reference' })).toBeNull()
  })
})

describe('config round-trip', () => {
  it('saves and restores provider, model, prompt and settings through configKeys', async () => {
    const user = userEvent.setup()
    stubGenerationFetch({ catalog: CATALOG_BOTH })
    const src = blockProps('rt-src')
    const first = renderGenerationBlock(def('omniReferenceToVideo').component, src)
    await user.click(await screen.findByRole('combobox', { name: 'Provider' }))
    await user.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('PiAPI'))!)
    fireEvent.change(screen.getByLabelText('Generation Prompt'), { target: { value: 'a dancer, then a jump' } })
    await user.click(screen.getByRole('button', { name: 'Less restriction: off' }))

    const flow = exportFlow({ id: 'p', blocks: [{ id: 'rt-src', type: 'omniReferenceToVideo' }] }, 'roundtrip')
    const config = flow.blocks[0].config as Record<string, unknown>
    expect(config.provider).toBe('piapi')
    expect(config.prompt).toBe('a dancer, then a jump')
    expect((config.params as { settings: Record<string, unknown> }).settings).toEqual({ less_restriction: true })
    expect(config).not.toHaveProperty('references')
    first.unmount()

    sessionStorage.clear()
    const pipeline = importFlow(JSON.stringify(flow))
    const restoredId = pipeline.blocks[0].id
    renderGenerationBlock(def('omniReferenceToVideo').component, blockProps(restoredId))
    expect(await screen.findByRole('combobox', { name: 'Provider' })).toHaveTextContent('PiAPI')
    expect(screen.getByLabelText('Generation Prompt')).toHaveValue('a dancer, then a jump')
    expect(screen.getByRole('button', { name: 'Less restriction: on' })).toHaveAttribute('aria-pressed', 'true')
  })
})
