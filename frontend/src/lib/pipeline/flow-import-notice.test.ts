import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'

const toastMock = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

import {
  mergeImportReports,
  notifyFlowImport,
  notifyFlowImportFailure,
  summarizeFlowImport,
} from './flow-import-notice'
import type { FlowImportReport } from './flow-migrations'

const base: FlowImportReport = { from_version: 1, to_version: 6, unsupported: [], warnings: [] }
const gen = { type: 'comfyGen', label: 'ComfyUI Gen', reason: 'r' }
const train = { type: 'loraTrain', label: 'LoRA Train', reason: 'r' }

beforeEach(() => {
  toastMock.warning.mockReset()
  toastMock.error.mockReset()
})

describe('summarizeFlowImport', () => {
  it('returns null for a clean import', () => {
    expect(summarizeFlowImport(base, 'flow')).toBeNull()
  })

  it('counts unsupported blocks and names them', () => {
    expect(summarizeFlowImport({ ...base, unsupported: [gen, train] }, 'flow')).toEqual({
      title: '2 blocks in this flow are no longer supported',
      description: 'ComfyUI Gen, LoRA Train. Remove or disable them before running.',
    })
  })

  it('uses singular wording and the subject noun', () => {
    expect(summarizeFlowImport({ ...base, unsupported: [gen] }, 'run')?.title).toBe(
      '1 block in this run is no longer supported',
    )
    expect(summarizeFlowImport({ ...base, unsupported: [gen] }, 'workspace')?.description).toBe(
      'ComfyUI Gen. Remove or disable it before running.',
    )
  })

  it('summarises warnings when every block is supported', () => {
    expect(summarizeFlowImport({ ...base, warnings: ['a.', 'b.'] }, 'flow')).toEqual({
      title: 'This flow was opened with 2 fixes',
      description: 'a. b.',
    })
  })

  it('mentions repairs alongside unsupported blocks', () => {
    expect(summarizeFlowImport({ ...base, unsupported: [gen], warnings: ['a.'] }, 'flow')?.description).toBe(
      'ComfyUI Gen. Remove or disable it before running. 1 problem in the file was fixed.',
    )
  })

  it('limits how many names and warnings it lists', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...gen, label: `B${i}` }))
    const summary = summarizeFlowImport({ ...base, unsupported: many }, 'flow')!
    expect(summary.description).toBe('B0, B1, B2, B3, B4 and 3 more. Remove or disable them before running.')
    const warnings = Array.from({ length: 6 }, (_, i) => `w${i}.`)
    expect(summarizeFlowImport({ ...base, warnings }, 'flow')!.description).toBe('w0. w1. w2. and 3 more.')
  })
})

describe('notifyFlowImport', () => {
  it('shows one warning toast for a report that needs attention', () => {
    notifyFlowImport({ ...base, unsupported: [gen, train] }, 'flow')
    expect(toastMock.warning).toHaveBeenCalledTimes(1)
    expect(toastMock.warning).toHaveBeenCalledWith('2 blocks in this flow are no longer supported', {
      description: 'ComfyUI Gen, LoRA Train. Remove or disable them before running.',
    })
  })

  it('shows nothing for a clean import', () => {
    notifyFlowImport(base, 'flow')
    expect(toastMock.warning).not.toHaveBeenCalled()
  })

  it('reports failures as an error toast', () => {
    notifyFlowImportFailure('This flow was saved by a newer version of BlockFlow.')
    expect(toastMock.error).toHaveBeenCalledWith('Could not open the flow', {
      description: 'This flow was saved by a newer version of BlockFlow.',
    })
  })
})

describe('mergeImportReports', () => {
  it('concatenates unsupported blocks and warnings, keeping the oldest from_version', () => {
    expect(
      mergeImportReports([
        { ...base, from_version: 2, unsupported: [gen], warnings: ['x'] },
        { ...base, from_version: 1, unsupported: [train] },
      ]),
    ).toEqual({ from_version: 1, to_version: 6, unsupported: [gen, train], warnings: ['x'] })
  })

  it('returns an empty current-version report for no inputs', () => {
    expect(mergeImportReports([])).toEqual({ from_version: 6, to_version: 6, unsupported: [], warnings: [] })
  })
})

describe('broken references in the import report', () => {
  const loaderFlow = (locals: string[]) => ({
    name: 'f', version: 1 as const, schema_version: 4, created_at: '',
    blocks: [
      { type: 'uploadImageToTmpfiles', config: { items: locals.map((l, i) => ({ id: `i${i}`, label: l, local: `/outputs/${l}`, status: 'ready' })) } },
      { type: 'omniReferenceToVideo', config: { references: [
        { id: 'v', kind: 'voice', role: 'reference', name: 'Ava', local: '/outputs/voice.mp3', status: 'ready' },
        { id: 'a', kind: 'audio', role: 'reference', local: '/outputs/song.mp3', status: 'ready' },
      ] } },
    ],
  })
  let fetchMock: ReturnType<typeof vi.fn>
  const missing = new Set(['/outputs/a.png', '/outputs/voice.mp3', '/outputs/song.mp3'])
  beforeEach(() => {
    fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const refs = JSON.parse(String(init.body)).references as Array<{ local?: string }>
      return new Response(JSON.stringify({ ok: true, results: refs.map((r, index) => ({ index, status: missing.has(r.local ?? '') ? 'missing_local' : 'ok', detail: '' })) }))
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('words the count with and without other findings', () => {
    expect(summarizeFlowImport(base, 'flow', 3)).toEqual({
      title: '3 references in this flow could not be found',
      description: 'They are marked on their blocks. Replace or remove them before running.',
    })
    expect(summarizeFlowImport(base, 'run', 1)?.title).toBe('1 reference in this run could not be found')
    expect(summarizeFlowImport({ ...base, unsupported: [gen] }, 'flow', 3)?.description)
      .toBe('ComfyUI Gen. Remove or disable it before running. 3 references could not be found.')
    expect(summarizeFlowImport({ ...base, warnings: ['a.'] }, 'flow', 1)?.description).toBe('a. 1 reference could not be found.')
  })

  it('checks loader items and generation references (audio, and old voice references as audio), then updates the same toast', async () => {
    await notifyFlowImport({ ...base, unsupported: [gen] }, 'flow', [loaderFlow(['a.png', 'b.png'])])
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(String(init.body)).references).toEqual([
      { kind: 'image', local: '/outputs/a.png' },
      { kind: 'image', local: '/outputs/b.png' },
      { kind: 'audio', local: '/outputs/voice.mp3' },
      { kind: 'audio', local: '/outputs/song.mp3' },
    ])
    expect(toastMock.warning).toHaveBeenCalledTimes(2)
    const [first, second] = toastMock.warning.mock.calls
    expect(first[1].id).toBeTruthy()
    expect(second[1].id).toBe(first[1].id)
    expect(second[1].description).toBe('ComfyUI Gen. Remove or disable it before running. 3 references could not be found.')
  })

  it('shows only the reference toast for an otherwise clean import', async () => {
    await notifyFlowImport(base, 'workspace', [loaderFlow(['a.png'])])
    expect(toastMock.warning).toHaveBeenCalledTimes(1)
    expect(toastMock.warning.mock.calls[0][0]).toBe('3 references in this workspace could not be found')
  })

  it('says nothing more when the check fails or there is nothing to check', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'))
    await notifyFlowImport(base, 'flow', [loaderFlow(['a.png'])])
    expect(toastMock.warning).not.toHaveBeenCalled()
    fetchMock.mockClear()
    await notifyFlowImport(base, 'flow', [{ name: 'e', version: 1, created_at: '', blocks: [{ type: 'imageViewer' }] }])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
