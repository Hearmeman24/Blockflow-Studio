/**
 * The Load Character block: picker states, default selection, send order,
 * outputs, limits from the downstream generation block, deleted characters
 * and files, run blockers and execute. The characters API module is mocked;
 * every other request goes through the generation fetch harness with the
 * real catalog fixtures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { SWRConfig } from 'swr'

const toastMock = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))
vi.mock('@/lib/api', () => ({
  saveRun: vi.fn(() => Promise.resolve({ ok: true })),
  fetchFlow: vi.fn(),
  fetchFlows: vi.fn(() => Promise.resolve({ ok: true, flows: [] })),
  saveFlowToDisk: vi.fn(),
}))
vi.mock('@/lib/characters/api', async (orig) => {
  const real = await orig<typeof import('@/lib/characters/api')>()
  return { ...real, listCharacters: vi.fn() }
})

import '@/components/pipeline/custom_blocks/_register'
import { BlockCard } from '@/components/pipeline/block-card'
import { blockDef } from '@/components/pipeline/custom_blocks/generated/load_character'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'
import { listCharacters } from '@/lib/characters/api'
import type { Character, CharacterMedia, CharacterMediaKind } from '@/lib/characters/types'
import { BlockLayoutProvider } from '@/lib/pipeline/block-layout-context'
import { exportFlow, importFlow } from '@/lib/pipeline/flow-io'
import { PipelineProvider, usePipeline } from '@/lib/pipeline/pipeline-context'
import { getRunBlockers } from '@/lib/pipeline/run-blockers'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { notifySessionKey } from '@/lib/use-session-state'
import { blockProps, latestExecute, renderGenerationBlock, stubGenerationFetch, type TestBlockProps } from '@/test-utils/byok-harness'

// ---- fixtures ----
const EXT: Record<CharacterMediaKind, string> = { image: 'png', video: 'mp4', audio: 'mp3' }
function media(cid: string, id: string, kind: CharacterMediaKind, position: number, label = `${id}.${EXT[kind]}`): CharacterMedia {
  return { id, kind, label, local: `/outputs/characters/${cid}/${id}.${EXT[kind]}`, size_bytes: 10, width: null, height: null, duration_s: null, position, created_at: '' }
}
function character(id: string, name: string, over: Partial<Character> = {}): Character {
  return { id, name, description: '', created_at: '', updated_at: '', default_face_id: null, default_audio_id: null, media: [], ...over }
}
const MIA = character('c1', 'Mia Rose', {
  media: [
    media('c1', 'i1', 'image', 0, 'visage ✨.png'), media('c1', 'i2', 'image', 1), media('c1', 'i3', 'image', 2),
    media('c1', 'm1', 'video', 0), media('c1', 'a1', 'audio', 0), media('c1', 'a2', 'audio', 1), media('c1', 'a3', 'audio', 2, 'Mia 李 line.mp3'),
  ],
  default_face_id: 'i2',
  default_audio_id: 'a2',
})
const ZOE = character('c2', 'Zoë', { media: [media('c2', 'z1', 'image', 0)], default_face_id: 'z1' })
const EMPTY = character('c3', 'Nobody')
const BRUCE = character('c4', '李小龙', { media: [media('c4', 'b1', 'audio', 0)], default_audio_id: 'b1' })
const TRANSPARENCY = 'Sent as audio. Your prompt says how to use it.'

let statusFor: (local: string) => string = () => 'ok'
beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  toastMock.error.mockReset()
  statusFor = () => 'ok'
  vi.mocked(listCharacters).mockReset().mockResolvedValue([MIA, ZOE, EMPTY, BRUCE])
  stubGenerationFetch({
    catalog: CATALOG_BOTH,
    checkReferences: (body) => ({
      body: { ok: true, results: body.references.map((r, index) => ({ index, status: statusFor(r.local ?? ''), detail: '' })) },
    }),
  })
})
afterEach(() => vi.unstubAllGlobals())

function seed(blockId: string, values: Record<string, unknown>) {
  for (const [k, v] of Object.entries(values)) sessionStorage.setItem(`block_${blockId}_${k}`, JSON.stringify(v))
}

function lastOutput(props: TestBlockProps, port: string): unknown {
  const calls = props.setOutput.mock.calls.filter(([p]) => p === port)
  return calls.length ? calls[calls.length - 1][1] : 'never set'
}

const tile = (name: string) => screen.getAllByTestId('character-tile').find((li) => li.getAttribute('title') === name)!
const order = (name: string) => within(tile(name)).queryByTestId('tile-order')?.textContent ?? null

function renderAlone(blockId = 'lc1') {
  const props = blockProps(blockId)
  renderGenerationBlock(blockDef.component, props)
  return props
}

async function choose(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('combobox', { name: 'Character' }))
  await user.click(screen.getAllByRole('option').find((o) => o.textContent?.includes(name))!)
}

// ---- the block definition ----
describe('blockDef', () => {
  it('is a huge, startable loader with three reference ports and three config keys', () => {
    expect(blockDef).toMatchObject({
      type: 'loadCharacter',
      label: 'Load Character',
      size: 'huge',
      canStart: true,
      inputs: [],
      suggestedDownstream: ['imageToVideo', 'imageToImage', 'omniReferenceToVideo'],
      configKeys: ['character_id', 'selection', 'snapshot'],
      satisfiesPrereqs: ['uploadImageToTmpfiles', 'omniReferenceLoader', 'videoLoader'],
    })
    expect(blockDef.outputs.map((o) => [o.name, o.kind])).toEqual([['image', 'image'], ['video', 'video'], ['audio', 'audio']])
    expect(blockDef.description).not.toMatch(/voice/i)
  })
})

// ---- picker states ----
describe('character picker', () => {
  it('shows a skeleton while loading', () => {
    vi.mocked(listCharacters).mockReturnValue(new Promise(() => {}))
    renderAlone()
    expect(screen.getByTestId('character-picker-loading')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('shows the error with Retry, and recovers', async () => {
    vi.mocked(listCharacters).mockRejectedValueOnce(new Error('Could not load characters (HTTP 500).'))
    renderAlone()
    expect(await screen.findByText('Could not load characters (HTTP 500).')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('combobox', { name: 'Character' })).toBeInTheDocument()
  })

  it('with no characters, says so and links to the creation wizard', async () => {
    vi.mocked(listCharacters).mockResolvedValue([])
    renderAlone()
    expect(await screen.findByText('No characters yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add character' })).toHaveAttribute('href', '/characters?new=1')
  })

  it('lists the characters and links to the chosen one', async () => {
    const user = userEvent.setup()
    renderAlone()
    await user.click(await screen.findByRole('combobox', { name: 'Character' }))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Mia Rose', 'Zoë', 'Nobody', '李小龙'])
    await user.click(screen.getAllByRole('option')[0])
    expect(screen.getByRole('link', { name: 'Edit character' })).toHaveAttribute('href', '/characters?id=c1')
  })
})

// ---- selection and output ----
describe('selection and output', () => {
  it('pre-selects the default face and the default audio clip and emits them on their ports, with the character', async () => {
    const user = userEvent.setup()
    const props = renderAlone()
    await choose(user, 'Mia Rose')
    expect(screen.getByRole('button', { name: 'i2.png', pressed: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'visage ✨.png', pressed: false })).toBeInTheDocument()
    expect(within(tile('i2.png')).getByTestId('default-face')).toBeInTheDocument()
    expect(order('i2.png')).toBe('1')
    expect(lastOutput(props, 'image')).toEqual([{ kind: 'image-ref', local: '/outputs/characters/c1/i2.png', label: 'i2.png', size_bytes: 10, character: 'Mia Rose' }])
    expect(lastOutput(props, 'audio')).toEqual([
      { kind: 'audio-ref', local: '/outputs/characters/c1/a2.mp3', label: 'a2.mp3', size_bytes: 10, character: 'Mia Rose' },
    ])
    expect(order('a2.mp3')).toBe('1')
    expect(lastOutput(props, 'video')).toBeUndefined()
    expect(props.setOutput.mock.calls.some(([port]) => port === 'voice')).toBe(false)
    expect(screen.queryByText(/Sent as "/)).toBeNull()
  })

  it('has Images, Videos and Audio sections; under Audio, one muted line says how sound is sent', async () => {
    const user = userEvent.setup()
    renderAlone()
    await choose(user, 'Mia Rose')
    const block = screen.getByTestId('load-character')
    expect(within(block).getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Images', 'Videos', 'Audio'])
    const line = within(screen.getByRole('region', { name: 'Audio' })).getByText(TRANSPARENCY)
    expect(line.tagName).toBe('P')
    expect(line.className).toContain('text-2xs')
    expect(line.className).toContain('text-muted-foreground')
    expect(screen.getAllByText(TRANSPARENCY)).toHaveLength(1)
    expect(within(block).queryByText(/voice/i)).toBeNull()
  })

  it('appends clicked files to the send order and removes them on a second click', async () => {
    const user = userEvent.setup()
    const props = renderAlone()
    await choose(user, 'Mia Rose')
    await user.click(screen.getByRole('button', { name: 'visage ✨.png' }))
    await user.click(screen.getByRole('button', { name: 'm1.mp4' }))
    expect((lastOutput(props, 'image') as Array<{ label: string }>).map((r) => r.label)).toEqual(['i2.png', 'visage ✨.png'])
    expect([order('i2.png'), order('visage ✨.png'), order('i3.png')]).toEqual(['1', '2', null])
    await user.click(screen.getByRole('button', { name: 'i2.png' }))
    expect((lastOutput(props, 'image') as Array<{ label: string }>).map((r) => r.label)).toEqual(['visage ✨.png'])
    expect(order('visage ✨.png')).toBe('1')
    expect(lastOutput(props, 'video')).toEqual([expect.objectContaining({ kind: 'video-ref', label: 'm1.mp4' })])
  })

  it('audio is multi-select in click order with order badges, like images', async () => {
    const user = userEvent.setup()
    const props = renderAlone()
    await choose(user, 'Mia Rose')
    await user.click(screen.getByRole('button', { name: 'Mia 李 line.mp3' }))
    await user.click(screen.getByRole('button', { name: 'a1.mp3' }))
    expect((lastOutput(props, 'audio') as Array<{ label: string }>).map((r) => r.label)).toEqual(['a2.mp3', 'Mia 李 line.mp3', 'a1.mp3'])
    expect([order('a2.mp3'), order('Mia 李 line.mp3'), order('a1.mp3')]).toEqual(['1', '2', '3'])
    await user.click(screen.getByRole('button', { name: 'a2.mp3' }))
    expect((lastOutput(props, 'audio') as Array<{ label: string }>).map((r) => r.label)).toEqual(['Mia 李 line.mp3', 'a1.mp3'])
    expect([order('a2.mp3'), order('Mia 李 line.mp3')]).toEqual([null, '1'])
    await user.click(screen.getByRole('button', { name: 'Mia 李 line.mp3' }))
    await user.click(screen.getByRole('button', { name: 'a1.mp3' }))
    expect(lastOutput(props, 'audio')).toBeUndefined()
  })

  it('audio clips are sound tiles: a play button beside (not inside) the selection toggle', async () => {
    const user = userEvent.setup()
    renderAlone()
    await choose(user, 'Mia Rose')
    const audio = screen.getByRole('region', { name: 'Audio' })
    const toggle = within(audio).getByRole('button', { name: 'a2.mp3', pressed: true })
    const play = within(audio).getByRole('button', { name: 'Play a2.mp3' })
    expect(toggle.contains(play)).toBe(false)
    expect(play.contains(toggle)).toBe(false)
    expect(within(tile('a2.mp3')).getByTestId('waveform')).toBeInTheDocument()
    expect(within(tile('a2.mp3')).getByText('a2')).toHaveAttribute('title', 'a2.mp3')
  })

  it('switching character resets the selection to the new defaults', async () => {
    const user = userEvent.setup()
    const props = renderAlone()
    await choose(user, 'Mia Rose')
    await user.click(screen.getByRole('button', { name: 'i3.png' }))
    await choose(user, 'Zoë')
    expect(lastOutput(props, 'image')).toEqual([expect.objectContaining({ label: 'z1.png', character: 'Zoë' })])
    expect(lastOutput(props, 'audio')).toBeUndefined()
  })

  it('a saved selection is kept on remount, not reset to the defaults', async () => {
    seed('lc2', { character_id: 'c1', selection: { image: ['i3', 'i1'], video: [], audio: [] } })
    const props = renderAlone('lc2')
    await waitFor(() => expect(order('i3.png')).toBe('1'))
    expect(order('visage ✨.png')).toBe('2')
    expect(order('i2.png')).toBeNull()
    expect((lastOutput(props, 'image') as Array<{ label: string }>).map((r) => r.label)).toEqual(['i3.png', 'visage ✨.png'])
    expect(lastOutput(props, 'audio')).toBeUndefined()
    // The snapshot is refreshed from the live character.
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('block_lc2_snapshot')!)).toMatchObject({ name: 'Mia Rose', items: { i3: { label: 'i3.png' } } }))
  })

  it('malformed saved config reads back as nothing chosen', async () => {
    seed('lc3', { character_id: 42, selection: 'junk', snapshot: [1, 2] })
    const props = renderAlone('lc3')
    expect(await screen.findByRole('combobox', { name: 'Character' })).toBeInTheDocument()
    expect(screen.queryAllByTestId('character-tile')).toEqual([])
    expect(lastOutput(props, 'image')).toBeUndefined()
  })

  it('a Unicode name is kept on the refs; no speaker name is derived from it', async () => {
    const user = userEvent.setup()
    const props = renderAlone()
    await choose(user, '李小龙')
    expect(lastOutput(props, 'audio')).toEqual([{ kind: 'audio-ref', local: '/outputs/characters/c4/b1.mp3', label: 'b1.mp3', size_bytes: 10, character: '李小龙' }])
    expect(screen.getByText(TRANSPARENCY)).toBeInTheDocument()
  })

  it('an open tab saved by an older version: its voice is folded into Audio, after the audio', async () => {
    seed('lc9', {
      character_id: 'c1',
      selection: { image: ['i2'], video: [], audio: ['a1'], voice: 'a3' },
      snapshot: { name: 'Mia Rose', items: { a3: { kind: 'voice', label: 'Mia 李 line.mp3', local: '/outputs/characters/c1/a3.mp3' } } },
    })
    const props = renderAlone('lc9')
    await waitFor(() => expect((lastOutput(props, 'audio') as Array<{ label: string }>).map((r) => r.label)).toEqual(['a1.mp3', 'Mia 李 line.mp3']))
    expect([order('a1.mp3'), order('Mia 李 line.mp3')]).toEqual(['1', '2'])
    expect(props.setOutput.mock.calls.some(([port]) => port === 'voice')).toBe(false)
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('block_lc9_snapshot')!).items.a3.kind).toBe('audio'))
    // The session state is rewritten too, so a flow exported from this tab has no voice.
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('block_lc9_selection')!)).toEqual({ image: ['i2'], video: [], audio: ['a1', 'a3'] }))
  })

  it('an open tab whose character list cannot load still has its voice selection and snapshot rewritten as audio', async () => {
    vi.mocked(listCharacters).mockReturnValue(new Promise(() => {}))
    seed('lc10', {
      character_id: 'c1',
      selection: { image: [], video: [], audio: [], voice: 'a3' },
      snapshot: { name: 'Mia Rose', items: { a3: { kind: 'voice', label: 'Mia 李 line.mp3', local: '/outputs/characters/c1/a3.mp3' } } },
    })
    renderAlone('lc10')
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('block_lc10_selection')!)).toEqual({ image: [], video: [], audio: ['a3'] }))
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('block_lc10_snapshot')!)).toEqual({
      name: 'Mia Rose', items: { a3: { kind: 'audio', label: 'Mia 李 line.mp3', local: '/outputs/characters/c1/a3.mp3' } },
    }))
  })

  it('a character with no files says so, with the edit link', async () => {
    const user = userEvent.setup()
    renderAlone()
    await choose(user, 'Nobody')
    expect(screen.getByText('This character has no files yet.')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Edit character' })[0]).toHaveAttribute('href', '/characters?id=c3')
    expect(screen.queryByRole('region', { name: 'Images' })).not.toBeInTheDocument()
  })

  it('only renders the sections the character has files for', async () => {
    const user = userEvent.setup()
    renderAlone()
    await choose(user, 'Zoë')
    expect(screen.getByRole('region', { name: 'Images' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Videos' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Audio' })).not.toBeInTheDocument()
    expect(screen.queryByText(TRANSPARENCY)).toBeNull()
  })
})

// ---- execute ----
describe('execute', () => {
  it('refuses without a character, and with nothing selected', async () => {
    const user = userEvent.setup()
    const props = renderAlone()
    await screen.findByRole('combobox', { name: 'Character' })
    await expect(latestExecute(props)({}, new AbortController().signal)).rejects.toThrow('Choose a character before running this block.')
    await choose(user, 'Nobody')
    await expect(latestExecute(props)({}, new AbortController().signal)).rejects.toThrow('Select at least one reference before running this block.')
  })

  it('reports what is ready', async () => {
    const user = userEvent.setup()
    const props = renderAlone()
    await choose(user, 'Mia Rose')
    await user.click(screen.getByRole('button', { name: 'visage ✨.png' }))
    await act(async () => { await latestExecute(props)({}, new AbortController().signal) })
    expect(props.setStatusMessage).toHaveBeenLastCalledWith('2 images, 1 audio clip ready')
  })
})

// ---- in a pipeline ----
const captured: { api: ReturnType<typeof usePipeline> | null } = { api: null }
function Canvas() {
  const api = usePipeline()
  useEffect(() => {
    captured.api = api
  })
  return (
    <>
      {api.pipeline.blocks.map((block, i) => <BlockCard key={block.id} block={block} displayNumber={String(i + 1)} />)}
    </>
  )
}

let tab = 0
function renderFlow(blocks: unknown[]) {
  const flowJson = JSON.stringify({ name: 'lc', version: 1, schema_version: 5, created_at: '', blocks })
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PipelineTabsProvider>
        <PipelineProvider tabId={`lc-${++tab}`} flowJson={flowJson}>
          <BlockLayoutProvider>
            <Canvas />
          </BlockLayoutProvider>
        </PipelineProvider>
      </PipelineTabsProvider>
    </SWRConfig>,
  )
}
const ids = () => captured.api!.pipeline.blocks.map((b) => b.id)
const sel = (over: Partial<{ image: string[]; video: string[]; audio: string[] }>) => ({ image: [], video: [], audio: [], ...over })

function setModel(blockId: string, model: string) {
  act(() => {
    sessionStorage.setItem(`block_${blockId}_model`, JSON.stringify(model))
    notifySessionKey(`block_${blockId}_model`)
  })
}

describe('limits from the downstream generation block', () => {
  it('over the count: flags the extra, offers Remove extras (deselect) and blocks the run with the loader message', async () => {
    renderFlow([
      { type: 'loadCharacter', config: { character_id: 'c1', selection: sel({ image: ['i1', 'i3'] }) } },
      { type: 'imageToVideo', config: { provider: 'kie', model: 'kling-4.0-flash', prompt: 'smile' } },
    ])
    expect(await screen.findByText('2 images, but Image to Video · Kling 4.0 Flash takes up to 1. Nothing was removed.')).toBeInTheDocument()
    expect(tile('i3.png')).toHaveAttribute('data-flag', 'over_limit')
    expect(within(tile('i3.png')).getByTestId('item-status')).toHaveTextContent('Over limit')
    expect(within(screen.getByRole('region', { name: 'Images' })).getByTestId('loader-footer')).toHaveTextContent('2 of 1 · Kling 4.0 Flash')
    expect(getRunBlockers(ids()[0])).toEqual(['holds 2 images; Image to Video · Kling 4.0 Flash takes up to 1'])

    let result: { hadError: boolean } | undefined
    await act(async () => { result = await captured.api!.runPipeline() })
    expect(result?.hadError).toBe(true)
    expect(toastMock.error).toHaveBeenCalledWith(
      'Pipeline not started: "Load Character" holds 2 images; Image to Video · Kling 4.0 Flash takes up to 1. Fix it, then run again.',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove extras' }))
    await waitFor(() => expect(order('i3.png')).toBeNull())
    expect(order('visage ✨.png')).toBe('1')
    expect(getRunBlockers(ids()[0])).toEqual([])
    expect(captured.api!.getInputsForBlock(ids()[1]).image).toEqual([expect.objectContaining({ label: 'visage ✨.png' })])
  })

  it('shows First frame and Last frame roles in Image to Video', async () => {
    renderFlow([
      { type: 'loadCharacter', config: { character_id: 'c1', selection: sel({ image: ['i3', 'i1'] }) } },
      { type: 'imageToVideo', config: { provider: 'kie', model: 'kling-4.0', prompt: 'smile' } },
    ])
    await waitFor(() => expect(within(tile('i3.png')).getByTestId('tile-role')).toHaveTextContent('First frame'))
    expect(within(tile('visage ✨.png')).getByTestId('tile-role')).toHaveTextContent('Last frame')
    expect(within(tile('i2.png')).queryByTestId('tile-role')).not.toBeInTheDocument()
  })

  it('a kind the model does not take is not sent and does not block; it follows the model live', async () => {
    renderFlow([
      { type: 'loadCharacter', config: { character_id: 'c1', selection: sel({ image: ['i2'], audio: ['a1', 'a2'] }) } },
      { type: 'omniReferenceToVideo', config: { provider: 'kie', model: 'kling-4.0-flash', prompt: 'talk' } },
    ])
    expect(await screen.findByText('Not supported by Kling 4.0 Flash · not sent')).toBeInTheDocument()
    const [lc, gen] = ids()
    expect(within(screen.getByRole('region', { name: 'Audio' })).queryByText(TRANSPARENCY)).toBeNull()
    expect(captured.api!.getInputsForBlock(gen).audio).toBeUndefined()
    expect(captured.api!.getInputsForBlock(gen).image).toEqual([expect.objectContaining({ label: 'i2.png' })])
    expect(getRunBlockers(lc)).toEqual([])
    // The selection is kept: switching to a model that takes audio sends it, in order.
    setModel(gen, 'kling-4.0')
    await waitFor(() => expect(captured.api!.getInputsForBlock(gen).audio).toEqual([
      expect.objectContaining({ kind: 'audio-ref', label: 'a1.mp3', character: 'Mia Rose' }),
      expect.objectContaining({ kind: 'audio-ref', label: 'a2.mp3', character: 'Mia Rose' }),
    ]))
    expect(screen.queryByText(/· not sent/)).toBeNull()
    expect(screen.getByText(TRANSPARENCY)).toBeInTheDocument()
    expect(getRunBlockers(lc)).toEqual([])
    // Each clip's badge says whose it is (the inserted mention per model is covered with the generation block).
    expect(await screen.findByRole('button', { name: 'Insert reference to Mia Rose · Audio 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Insert reference to Mia Rose · Audio 2' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Insert reference to Mia Rose · Image 1' })).toBeInTheDocument()
  })

  it('adding a generation block after it adds no loader in between', async () => {
    renderFlow([{ type: 'loadCharacter', config: { character_id: 'c1' } }])
    await screen.findByRole('combobox', { name: 'Character' })
    act(() => { captured.api!.addBlock('omniReferenceToVideo') })
    expect(captured.api!.pipeline.blocks.map((b) => b.type)).toEqual(['loadCharacter', 'omniReferenceToVideo'])
  })

  it('two Load Character blocks feeding one block in "all" mode send both, in order, with both badges', async () => {
    renderFlow([
      { type: 'loadCharacter', config: { character_id: 'c1', selection: sel({ image: ['i2'] }) } },
      { type: 'loadCharacter', config: { character_id: 'c2', selection: sel({ image: ['z1'] }) } },
      { type: 'omniReferenceToVideo', source_modes: { image: 'all' }, config: { provider: 'kie', model: 'kling-4.0', prompt: 'two people' } },
    ])
    // "all" mode passes one value per source, in pipeline order.
    const images = () => [captured.api!.getInputsForBlock(ids()[2]).image].flat(2) as Array<{ label: string; character: string }>
    await waitFor(() => expect(images()).toHaveLength(2))
    expect(images().map((r) => [r.label, r.character]))
      .toEqual([['i2.png', 'Mia Rose'], ['z1.png', 'Zoë']])
    expect(await screen.findByRole('button', { name: 'Insert reference to Mia Rose · Image 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Insert reference to Zoë · Image 2' })).toBeInTheDocument()
  })
})

describe('deleted characters and files', () => {
  const snapshot = {
    name: 'Old Mia',
    items: { g1: { kind: 'image', label: 'old face.png', local: '/outputs/characters/gone/g1.png' } },
  }

  it('a deleted character: says so, keeps the picker, shows the files from the snapshot as broken, and blocks the run', async () => {
    statusFor = (local) => (local.includes('/gone/') ? 'missing_local' : 'ok')
    renderFlow([{ type: 'loadCharacter', config: { character_id: 'gone', selection: sel({ image: ['g1'] }), snapshot } }])
    expect(await screen.findByText('"Old Mia" was deleted.')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Character' })).toBeInTheDocument()
    await waitFor(() => expect(within(tile('old face.png')).getByTestId('item-status')).toHaveTextContent('File not found'))
    expect(getRunBlockers(ids()[0])).toEqual([
      'uses the deleted character "Old Mia"',
      'has a broken reference: old face.png (File not found)',
    ])
  })

  it('while the list loads, or when it failed, the character is not treated as deleted', async () => {
    vi.mocked(listCharacters).mockReturnValue(new Promise(() => {}))
    renderFlow([{ type: 'loadCharacter', config: { character_id: 'gone', selection: sel({ image: ['g1'] }), snapshot } }])
    expect(await screen.findByTestId('character-picker-loading')).toBeInTheDocument()
    expect(tile('old face.png')).toBeInTheDocument()
    expect(screen.queryByText('"Old Mia" was deleted.')).not.toBeInTheDocument()
    await waitFor(() => expect(within(tile('old face.png')).queryByTestId('item-status')).toBeNull())
    expect(getRunBlockers(ids()[0])).toEqual([])
  })

  it('a failed list shows the error and Retry and blocks nothing by itself', async () => {
    vi.mocked(listCharacters).mockRejectedValue(new Error('Could not load characters (HTTP 502).'))
    renderFlow([{ type: 'loadCharacter', config: { character_id: 'gone', selection: sel({ image: ['g1'] }), snapshot } }])
    expect(await screen.findByText('Could not load characters (HTTP 502).')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText('"Old Mia" was deleted.')).not.toBeInTheDocument()
    expect(tile('old face.png')).toBeInTheDocument()
    expect(getRunBlockers(ids()[0])).toEqual([])
  })

  it('a selected file the character no longer has: shown from the snapshot, broken, removable', async () => {
    statusFor = (local) => (local.endsWith('/gone.png') ? 'missing_local' : 'ok')
    renderFlow([{
      type: 'loadCharacter',
      config: {
        character_id: 'c1',
        selection: sel({ image: ['i2', 'x9'] }),
        snapshot: { name: 'Mia Rose', items: { x9: { kind: 'image', label: 'gone.png', local: '/outputs/characters/c1/gone.png' } } },
      },
    }])
    await waitFor(() => expect(within(tile('gone.png')).getByTestId('item-status')).toHaveTextContent('File not found'))
    expect(order('gone.png')).toBe('2')
    expect(screen.getByText(/1 file could not be found\. Remove it here/)).toBeInTheDocument()
    expect(getRunBlockers(ids()[0])).toEqual(['has a broken reference: gone.png (File not found)'])
    fireEvent.click(screen.getByRole('button', { name: 'Remove gone.png' }))
    await waitFor(() => expect(screen.queryByTitle('gone.png')).not.toBeInTheDocument())
    expect(getRunBlockers(ids()[0])).toEqual([])
  })
})

describe('saved flows', () => {
  it('export and import keep the three config keys', async () => {
    const user = userEvent.setup()
    renderFlow([{ type: 'loadCharacter' }])
    await choose(user, 'Mia Rose')
    await user.click(screen.getByRole('button', { name: 'i3.png' }))
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem(`block_${ids()[0]}_snapshot`)!).items).toHaveProperty('i3'))
    const saved = exportFlow(captured.api!.pipeline, 'f')
    const config = saved.blocks[0].config!
    expect(Object.keys(config).sort()).toEqual(['character_id', 'selection', 'snapshot'])
    expect(config.selection).toEqual({ image: ['i2', 'i3'], video: [], audio: ['a2'] })
    sessionStorage.clear()
    const imported = importFlow(JSON.stringify(saved))
    const id = imported.blocks[0].id
    expect(imported.blocks[0].type).toBe('loadCharacter')
    for (const key of ['character_id', 'selection', 'snapshot']) {
      expect(JSON.parse(sessionStorage.getItem(`block_${id}_${key}`)!)).toEqual(config[key])
    }
  })

  it('a schema-5 flow with a voice selection opens with it appended to the audio', async () => {
    renderFlow([{
      type: 'loadCharacter',
      config: {
        character_id: 'c1',
        selection: { image: ['i2'], video: [], audio: ['a1'], voice: 'a3' },
        snapshot: { name: 'Mia Rose', items: { a3: { kind: 'voice', label: 'Mia 李 line.mp3', local: '/outputs/characters/c1/a3.mp3' } } },
      },
    }])
    await waitFor(() => expect([order('a1.mp3'), order('Mia 李 line.mp3')]).toEqual(['1', '2']))
    expect(JSON.parse(sessionStorage.getItem(`block_${ids()[0]}_selection`)!)).toEqual({ image: ['i2'], video: [], audio: ['a1', 'a3'] })
  })
})
