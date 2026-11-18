import type { JobSnapshot, RunEntry } from './types'

const BASE = '' // Same origin, proxied by Next.js rewrites

export interface FlowEntry {
  name: string
  filename: string
  updated_at: string
  size_bytes: number
}

// ---- Run History ----

export async function saveRun(run: RunEntry) {
  const res = await fetch(`${BASE}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(run),
  })
  return res.json()
}

/** Runs per page on the Artifacts page. */
export const ARTIFACTS_PAGE_SIZE = 25

export async function fetchRuns(
  limit = ARTIFACTS_PAGE_SIZE,
  offset = 0,
  favorited = false,
  /** One kind or a comma list (`image,video`); null for all. */
  mediaKind: string | null = null,
  promptQuery: string = '',
  hidePartial = true,
  /** One source or a comma list (`pipeline,mcp`); null for all. */
  source: string | null = null,
  /** One character id or a comma list; a run matches any of them. null for all. */
  character: string | null = null,
) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  if (favorited) params.set('favorited', 'true')
  if (mediaKind) params.set('media_kind', mediaKind)
  if (promptQuery) params.set('q', promptQuery)
  params.set('hide_partial', hidePartial ? 'true' : 'false')
  if (source) params.set('source', source)
  if (character) params.set('character', character)
  const res = await fetch(`${BASE}/api/runs?${params}`)
  return res.json()
}

/** Jobs submitted through the MCP server (active + recent), newest first. */
export async function fetchMcpJobs(limit = 50): Promise<{ ok: boolean; jobs: JobSnapshot[] }> {
  const params = new URLSearchParams({ source: 'mcp', limit: String(limit) })
  const res = await fetch(`${BASE}/api/jobs?${params}`)
  return res.json()
}

export async function toggleRunFavorite(id: string) {
  const res = await fetch(`${BASE}/api/runs/${encodeURIComponent(id)}/favorite`, { method: 'PATCH' })
  return res.json()
}

export async function fetchRunById(id: string) {
  const res = await fetch(`${BASE}/api/runs/${encodeURIComponent(id)}`)
  return res.json()
}

// ---- Flows (disk-backed, ./flows) ----

export async function fetchFlows() {
  const res = await fetch(`${BASE}/api/flows`)
  return res.json()
}

export async function fetchFlow(name: string) {
  const res = await fetch(`${BASE}/api/flows/${encodeURIComponent(name)}`)
  return res.json()
}

export async function deleteFlow(name: string) {
  const res = await fetch(`${BASE}/api/flows/${encodeURIComponent(name)}`, { method: 'DELETE' })
  return res.json()
}

export async function renameFlow(name: string, newName: string) {
  const res = await fetch(`${BASE}/api/flows/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName }),
  })
  return res.json()
}

export async function saveFlowToDisk(name: string, flow: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/flows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, flow }),
  })
  return res.json()
}
