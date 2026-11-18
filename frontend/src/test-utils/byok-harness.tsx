/**
 * Test harness for the generation blocks: a fetch mock that serves the real
 * catalog fixtures and records every generation request, plus a renderer
 * with a fresh SWR cache. Test-only.
 */
import './ui-sdk-jsdom'
import { vi, type Mock } from 'vitest'
import { render } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { ComponentType } from 'react'
import type { BlockComponentProps } from '@/lib/pipeline/registry'
import type { ProviderCatalog } from '@/lib/byok/types'
import type { JobSnapshot } from '@/lib/types'

export function jobSnapshot(over: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    job_id: 'job-1', source: 'pipeline', provider: 'kie', model: 'm', mode: 'text_to_video',
    status: 'QUEUED', remote_job_id: null, remote_status: null, progress: null, message: null, error: null,
    outputs: [], request: {}, created_at: 0, updated_at: 0, completed_at: null, cancel_requested: false, ...over,
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export interface HarnessRoutes {
  catalog: ProviderCatalog
  validate?: (body: unknown) => { status?: number; body: unknown }
  submit?: (body: unknown) => { status?: number; body: unknown }
  /** Job snapshots returned in order; the last one repeats. */
  jobs?: JobSnapshot[]
  upload?: (endpoint: string, filename: string) => { status?: number; body: unknown }
  /** `POST /api/generation/estimate`; by default no estimate. */
  estimate?: (body: unknown) => { status?: number; body: unknown }
  /** `POST /api/generation/check-references`; by default every reference is `ok`. */
  checkReferences?: (body: { references: Array<{ kind: string; local?: string; url?: string }> }) => { status?: number; body: unknown }
}

export interface Harness {
  fetchMock: Mock
  requests: (url: string) => unknown[]
  setCatalog: (catalog: ProviderCatalog) => void
}

export function stubGenerationFetch(routes: HarnessRoutes): Harness {
  let catalog = routes.catalog
  const jobs = [...(routes.jobs ?? [jobSnapshot({ status: 'COMPLETED' })])]
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    if (url === '/api/providers/catalog') return json(catalog)
    if (url === '/api/generation/validate') {
      const r = routes.validate?.(body) ?? { body: { ok: true, issues: [] } }
      return json(r.body, r.status)
    }
    if (url === '/api/generation/submit') {
      const r = routes.submit?.(body) ?? { body: { ok: true, job: jobSnapshot() } }
      return json(r.body, r.status)
    }
    if (url === '/api/generation/estimate') {
      const r = routes.estimate?.(body) ?? { body: { ok: true, estimate: null } }
      return json(r.body, r.status)
    }
    if (url === '/api/generation/check-references') {
      const r = routes.checkReferences?.(body) ?? {
        body: { ok: true, results: (body?.references ?? []).map((_: unknown, index: number) => ({ index, status: 'ok', detail: '' })) },
      }
      return json(r.body, r.status)
    }
    if (/\/api\/jobs\/[^/]+\/cancel$/.test(url)) return json({ ok: true, job: jobSnapshot({ cancel_requested: true }) })
    if (url.startsWith('/api/jobs/')) return json({ ok: true, job: jobs.length > 1 ? jobs.shift() : jobs[0] })
    if (url.includes('/save-local')) {
      const headers = new Headers(init?.headers)
      const filename = headers.get('X-Filename') ?? 'file'
      const r = routes.upload?.(url, filename) ?? {
        body: url.includes('upload_image') ? { ok: true, image_url: `/outputs/${filename}` } : { ok: true, video_url: `/outputs/${filename}` },
      }
      return json(r.body, r.status)
    }
    return json({ ok: true })
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    fetchMock,
    requests: (target: string) => fetchMock.mock.calls
      .filter(([u]) => String(u) === target)
      .map(([, init]) => (typeof init?.body === 'string' ? JSON.parse(init.body) : undefined)),
    setCatalog: (next) => {
      catalog = next
    },
  }
}

export function blockProps(blockId: string, inputs: Record<string, unknown> = {}) {
  return {
    blockId,
    inputs,
    setOutput: vi.fn(),
    registerExecute: vi.fn(),
    setStatusMessage: vi.fn(),
    setExecutionStatus: vi.fn(),
    setOutputHint: vi.fn(),
    setHeaderActions: vi.fn(),
    setHeaderWarnings: vi.fn(),
    hasUpstreamProducer: vi.fn(() => false),
  } satisfies BlockComponentProps
}

export type TestBlockProps = ReturnType<typeof blockProps>

export function renderGenerationBlock<P extends BlockComponentProps>(Component: ComponentType<P>, props: P) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <Component {...props} />
    </SWRConfig>,
  )
}

/** The execute function most recently registered by the block. */
export function latestExecute(props: TestBlockProps) {
  const calls = props.registerExecute.mock.calls
  if (calls.length === 0) throw new Error('execute was never registered')
  return calls[calls.length - 1][0] as (inputs: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
}
