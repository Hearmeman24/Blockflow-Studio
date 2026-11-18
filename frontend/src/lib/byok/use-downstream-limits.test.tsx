import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import '@/components/pipeline/custom_blocks/_register'
import { PipelineProvider, usePipeline } from '@/lib/pipeline/pipeline-context'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { walkBlocks } from '@/lib/pipeline/tree-utils'
import { useSessionState } from '@/lib/use-session-state'
import { stubGenerationFetch } from '@/test-utils/byok-harness'
import { CATALOG_BOTH } from './__fixtures__'
import type { MediaKind } from './types'
import { useDownstreamLimits } from './use-downstream-limits'

let tab = 0

function Probe({ index, kind }: { index: number; kind: MediaKind }) {
  const { pipeline } = usePipeline()
  const ids = [...walkBlocks(pipeline.blocks)].map((b) => b.id)
  const state = useDownstreamLimits(ids[index], kind)
  return (
    <div>
      <p data-testid="consumers">
        {state.consumers.map((c) => `${c.label}:${c.modelName}@${c.providerName}=${c.accepted ? c.maxCount : 'no'}`).join(';')}
      </p>
      <p data-testid="strictest">{state.strictest ? `${state.strictest.label}=${state.strictest.maxCount}` : 'none'}</p>
    </div>
  )
}

/** Stands in for a generation block's own provider/model controls. */
function Selector({ index, field, value }: { index: number; field: 'provider' | 'model'; value: string }) {
  const { pipeline } = usePipeline()
  const id = [...walkBlocks(pipeline.blocks)][index].id
  const [, set] = useSessionState<string | null>(`block_${id}_${field}`, null)
  return <button type="button" onClick={() => set(value)}>{`set ${field} ${value}`}</button>
}

function renderFlow(blocks: unknown[], kind: MediaKind = 'image', extra?: React.ReactNode) {
  const flowJson = JSON.stringify({ name: 't', version: 2, schema_version: 3, created_at: '', blocks })
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PipelineTabsProvider>
        <PipelineProvider tabId={`udl-${++tab}`} flowJson={flowJson}>
          <Probe index={0} kind={kind} />
          {extra}
        </PipelineProvider>
      </PipelineTabsProvider>
    </SWRConfig>,
  )
}

const loader = { type: 'uploadImageToTmpfiles' }
const i2v = (model: string, provider = 'kie', extra: Record<string, unknown> = {}) => ({
  type: 'imageToVideo', config: { provider, model }, ...extra,
})
const consumers = () => screen.getByTestId('consumers').textContent
const strictest = () => screen.getByTestId('strictest').textContent

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  stubGenerationFetch({ catalog: CATALOG_BOTH })
})
afterEach(() => vi.unstubAllGlobals())

describe('useDownstreamLimits', () => {
  it('has no consumer and no limit when nothing downstream takes the kind', async () => {
    renderFlow([loader, { type: 'imageViewer' }])
    await waitFor(() => expect(strictest()).toBe('none'))
    expect(consumers()).toBe('')
  })

  it('closest: reads the nearest generation block that takes this loader', async () => {
    renderFlow([loader, i2v('kling-4.0-flash')])
    await waitFor(() => expect(consumers()).toBe('Image to Video:Kling 4.0 Flash@Kie=1'))
  })

  it('closest: a nearer loader takes over, so the first loader has no consumer', async () => {
    renderFlow([loader, loader, i2v('kling-4.0-flash')])
    await waitFor(() => expect(strictest()).toBe('none'))
  })

  it('all and custom source modes include the loader', async () => {
    renderFlow([
      loader, loader,
      i2v('kling-4.0-flash', 'kie', { label: 'All', source_modes: { image: 'all' } }),
      { type: 'imageToImage', label: 'Custom', config: { provider: 'kie', model: 'seedream-5-pro' }, source_modes: { image: 'custom' }, source_selections: { image: [0] } },
      { type: 'imageToImage', label: 'Not selected', source_modes: { image: 'custom' }, source_selections: { image: [1] } },
    ])
    await waitFor(() => expect(consumers()).toBe('All:Kling 4.0 Flash@Kie=1;Custom:Seedream 5 Pro@Kie=10'))
  })

  it('several consumers across branches: the strictest is named', async () => {
    renderFlow([
      { ...loader, branches: [[i2v('kling-4.0-flash', 'kie', { label: 'Branch I2V' })]] },
      { type: 'omniReferenceToVideo', label: 'Omni', config: { provider: 'kie', model: 'seedance-2' } },
    ])
    await waitFor(() => expect(strictest()).toBe('Branch I2V=1'))
    expect(consumers()).toBe('Branch I2V:Kling 4.0 Flash@Kie=1;Omni:Seedance 2@Kie=9')
  })

  it('reports a model that does not accept the kind as taking none', async () => {
    renderFlow([loader, i2v('seedance-2.5', 'piapi')])
    await waitFor(() => expect(consumers()).toBe('Image to Video:Seedance 2.5@PiAPI=no'))
    expect(strictest()).toBe('Image to Video=0')
  })

  it('updates live when the downstream model changes, without a reload', async () => {
    renderFlow([loader, i2v('seedance-2')], 'image', <Selector index={1} field="model" value="kling-4.0-flash" />)
    await waitFor(() => expect(consumers()).toBe('Image to Video:Seedance 2@Kie=2'))
    act(() => screen.getByRole('button', { name: 'set model kling-4.0-flash' }).click())
    await waitFor(() => expect(consumers()).toBe('Image to Video:Kling 4.0 Flash@Kie=1'))
  })

  it('updates live when the downstream provider changes', async () => {
    renderFlow(
      [{ type: 'videoLoader' }, { type: 'omniReferenceToVideo', config: { provider: 'kie', model: 'kling-4.0' } }],
      'video',
      <Selector index={1} field="provider" value="piapi" />,
    )
    await waitFor(() => expect(consumers()).toBe('Omni Reference to Video:Kling 4.0@Kie=5'))
    act(() => screen.getByRole('button', { name: 'set provider piapi' }).click())
    await waitFor(() => expect(consumers()).toBe('Omni Reference to Video:Kling 4.0@PiAPI=5'))
  })

  it('ignores disabled consumers', async () => {
    renderFlow([loader, i2v('kling-4.0-flash', 'kie', { disabled: true })])
    await waitFor(() => expect(strictest()).toBe('none'))
  })
})
