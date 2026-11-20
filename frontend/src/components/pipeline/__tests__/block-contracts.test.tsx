import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'

const settingsMocks = vi.hoisted(() => ({
  getCredential: vi.fn(),
}))

vi.mock('@/lib/settings/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/settings/client')>()
  return {
    ...actual,
    getCredential: settingsMocks.getCredential,
  }
})

import '@/components/pipeline/custom_blocks/_register'
import { BlockCard } from '@/components/pipeline/block-card'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'
import { BlockLayoutProvider } from '@/lib/pipeline/block-layout-context'
import { BLOCK_ROLES } from '@/lib/pipeline/block-role'
import { PipelineProvider, usePipeline } from '@/lib/pipeline/pipeline-context'
import { stubGenerationFetch } from '@/test-utils/byok-harness'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import {
  listBlockDefs,
  type BlockComponentProps,
  type BlockDef,
} from '@/lib/pipeline/registry'

function jsonResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
}

function mockFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/settings')) {
      return jsonResponse({ ok: true, has_api_key: true, has_env_api_key: true, settings: {} })
    }
    if (url.includes('/prompt-packs')) {
      return jsonResponse({ ok: true, packs: [], prompts: [] })
    }
    if (url.includes('/file-metadata')) {
      return jsonResponse({ ok: false, error: 'not found' })
    }
    return jsonResponse({ ok: true })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function contractInputs(): Record<string, unknown> {
  return {
    image: [
      { kind: 'image-ref', local: '/outputs/contract/image.png', url: 'https://tmpfiles.test/image.png' },
    ],
    video: [
      { kind: 'video-ref', local: '/outputs/contract/video.mp4', url: 'https://tmpfiles.test/video.mp4' },
    ],
    audio: ['/outputs/contract/audio.mp3'],
    text: 'contract prompt',
    metadata: { job_ids: ['job-contract'] },
  }
}

function renderContractBlock(def: BlockDef) {
  const props: BlockComponentProps = {
    blockId: `contract-${def.type}`,
    inputs: contractInputs(),
    setOutput: vi.fn(),
    registerExecute: vi.fn(),
    setStatusMessage: vi.fn(),
    setExecutionStatus: vi.fn(),
    setOutputHint: vi.fn(),
    setHeaderActions: vi.fn(),
    hasUpstreamProducer: vi.fn(() => true),
  }
  const Component = def.component
  const result = render(
    <PipelineTabsProvider>
      <PipelineProvider tabId={`contract-${def.type}`}>
        <Component {...props} />
      </PipelineProvider>
    </PipelineTabsProvider>,
  )
  return { ...result, props }
}

describe('custom block contracts', () => {
  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
    settingsMocks.getCredential.mockResolvedValue({ value: 'mock-secret' })
    mockFetch()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    vi.restoreAllMocks()
  })

  it('registers exactly the blocks the BYOK fork keeps, the five generation blocks, Character Swap, the Omni loader, Load Character and the Prompt Writer', () => {
    expect(listBlockDefs().map((def) => def.type).sort()).toEqual([
      'audioViewer', 'characterSwap', 'hitl', 'imageInspector', 'imageToImage', 'imageToVideo', 'imageViewer', 'loadCharacter',
      'omniReferenceLoader', 'omniReferenceToVideo', 'promptFromTxt', 'promptWriter', 'textToImage', 'textToVideo',
      'uploadImageToTmpfiles', 'videoFx', 'videoLoader', 'videoStitcher', 'videoViewer',
    ])
  })

  it('the Prompt Writer saves its own result with a run; no other block writes its settings while running', () => {
    // A saved run keeps a block's settings as they were when the block started,
    // except the keys the block lists here (see lib/pipeline/run-snapshot.ts).
    const declared = Object.fromEntries(
      listBlockDefs().filter((def) => def.resultConfigKeys?.length).map((def) => [def.type, def.resultConfigKeys]),
    )
    expect(declared).toEqual({ promptWriter: ['output'] })
    for (const def of listBlockDefs()) {
      for (const key of def.resultConfigKeys ?? []) expect(def.configKeys, def.type).toContain(key)
    }
  })

  it('persists every generation setting through configKeys; references live in the loaders', () => {
    for (const type of ['textToVideo', 'imageToVideo', 'textToImage', 'imageToImage', 'omniReferenceToVideo']) {
      const def = listBlockDefs().find((d) => d.type === type)
      expect(def?.configKeys, type).toEqual(['provider', 'model', 'prompt', 'use_upstream_prompt', 'params'])
    }
    expect(listBlockDefs().find((d) => d.type === 'omniReferenceLoader')?.configKeys)
      .toEqual(['video_items', 'image_items', 'audio_items'])
  })

  it('sound is one port kind, audio: no block declares a voice port', () => {
    const ports = (type: string, side: 'inputs' | 'outputs') =>
      listBlockDefs().find((d) => d.type === type)?.[side].map((p) => [p.name, p.kind])
    expect(ports('omniReferenceLoader', 'outputs')).toEqual([['video', 'video'], ['image', 'image'], ['audio', 'audio']])
    expect(ports('loadCharacter', 'outputs')).toEqual([['image', 'image'], ['video', 'video'], ['audio', 'audio']])
    expect(ports('omniReferenceToVideo', 'inputs')).toEqual([['text', 'text'], ['image', 'image'], ['video', 'video'], ['audio', 'audio']])
    for (const def of listBlockDefs()) {
      for (const port of [...def.inputs, ...def.outputs]) expect(port.kind, `${def.type}.${port.name}`).not.toBe('voice')
    }
  })

  it('registers every generated custom block with unique metadata', () => {
    const defs = listBlockDefs()
    expect(defs.length).toBeGreaterThanOrEqual(10)
    expect(new Set(defs.map((def) => def.type)).size).toBe(defs.length)
    for (const def of defs) {
      expect(def.type).toMatch(/^[A-Za-z0-9_]+$/)
      expect(def.label.trim()).not.toBe('')
      expect(def.description.trim()).not.toBe('')
      expect(['sm', 'md', 'lg', 'huge']).toContain(def.size)
      expect(Array.isArray(def.inputs)).toBe(true)
      expect(Array.isArray(def.outputs)).toBe(true)
      expect(typeof def.component).toBe('function')
    }
  })

  it('keeps forwards and iterator declarations tied to declared ports', () => {
    for (const def of listBlockDefs()) {
      const inputNames = new Set(def.inputs.map((port) => port.name))
      const outputNames = new Set(def.outputs.map((port) => port.name))
      for (const forward of def.forwards ?? []) {
        expect(inputNames.has(forward.fromInput), `${def.type} forwards from missing input`).toBe(true)
        expect(outputNames.has(forward.toOutput), `${def.type} forwards to missing output`).toBe(true)
      }
      if (def.iteratorOutput) {
        expect(outputNames.has(def.iteratorOutput), `${def.type} iteratorOutput missing`).toBe(true)
      }
    }
  })

  it.each(listBlockDefs().map((def) => [def.type, def] as const))(
    'mounts %s with mocked pipeline props',
    async (_type, def) => {
      const { props } = renderContractBlock(def)
      await waitFor(() => {
        expect(props.setStatusMessage).toBeDefined()
      })
    },
  )

  it.each(listBlockDefs().map((def) => [def.type, def] as const))(
    '%s declares a block role',
    (_type, def) => {
      expect(BLOCK_ROLES).toContain(def.role)
    },
  )

  it.each(listBlockDefs().map((def) => [def.type, def] as const))(
    'registers an execute callback for %s unless it is declarative-only',
    async (_type, def) => {
      const declarativeOnly = def.type === 'audioViewer'
      const { props } = renderContractBlock(def)
      if (declarativeOnly) {
        expect(props.registerExecute).not.toHaveBeenCalled()
        return
      }
      await waitFor(() => {
        expect(props.registerExecute).toHaveBeenCalledWith(expect.any(Function))
      })
    },
  )
})

/**
 * One spacing rule inside blocks: the block body (block-card.tsx) makes the
 * block's root a flex column with the standard gap. A block must not set its
 * own vertical gap on its root (`space-y-*`, `gap-*`) or push its top-level
 * items apart with ad-hoc margins (`mt-*`, `mb-*`, `my-*`; `mt-auto` for the
 * footer is fine). Checked through the real BlockCard, at mount and settled.
 */
describe('block spacing contract', () => {
  function Canvas() {
    const { pipeline } = usePipeline()
    return <>{pipeline.blocks.map((b, i) => <BlockCard key={b.id} block={b} displayNumber={String(i + 1)} />)}</>
  }

  let tab = 0
  function renderInCard(type: string) {
    const flowJson = JSON.stringify({ name: 'f', version: 1, schema_version: 6, created_at: '', blocks: [{ type }] })
    return render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <PipelineTabsProvider>
          <PipelineProvider tabId={`spacing-${++tab}`} flowJson={flowJson}>
            <BlockLayoutProvider><Canvas /></BlockLayoutProvider>
          </PipelineProvider>
        </PipelineTabsProvider>
      </SWRConfig>,
    )
  }

  const classList = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
  /** Utility names without variant prefixes such as `@xs:`. */
  const utilities = (el: Element) => classList(el).map((c) => c.split(':').pop()!)
  const OWN_GAP = /^(space-y-|gap-|gap-y-)/
  const AD_HOC_MARGIN = /^-?(mt|mb|my)-(?!auto$)/

  function violations(container: HTMLElement): string[] {
    const body = container.querySelector('[data-slot="block-body"]')
    if (!body) return ['no block body']
    const found: string[] = []
    for (const root of Array.from(body.children)) {
      for (const u of utilities(root)) if (OWN_GAP.test(u)) found.push(`root sets ${u}`)
      for (const child of Array.from(root.children)) {
        for (const u of utilities(child)) if (AD_HOC_MARGIN.test(u)) found.push(`top-level item sets ${u}`)
      }
    }
    return found
  }

  beforeEach(() => {
    stubGenerationFetch({ catalog: CATALOG_BOTH })
  })

  it('the block body owns the standard gap: the root is a flex column with gap-3', () => {
    const { container } = renderInCard('videoStitcher')
    const body = container.querySelector('[data-slot="block-body"]')!
    expect(classList(body)).toEqual(expect.arrayContaining(['*:flex', '*:flex-col', '*:gap-3', '*:min-w-0', '*:flex-1']))
  })

  it.each(listBlockDefs().map((def) => [def.type] as const))(
    '%s does not set its own top-level vertical gap',
    async (type) => {
      const { container } = renderInCard(type)
      expect(violations(container), 'at mount').toEqual([])
      await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
      expect(violations(container), 'settled').toEqual([])
    },
  )
})
