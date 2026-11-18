/**
 * In-memory stand-in for the settings and provider key-check routes, used as
 * the `fetch` mock in settings and onboarding tests. It mirrors the backend
 * contract: credential responses never include the stored value.
 */
import { vi } from 'vitest'

import type { KeyCheckResult } from '@/lib/settings/client'
import type { ChooseFolderResult, OutputFolderStatus } from '@/lib/settings/output-folder'

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>

export type FakeBackend = {
  fetch: ReturnType<typeof vi.fn<typeof fetch>>
  keys: Map<string, string>
  prefs: Map<string, string>
  /** Override a route ("PUT /api/settings/credentials/kie_api_key"). */
  override: (route: string, handler: Handler) => void
  /** Verdict returned by POST /api/providers/{p}/validate-key. */
  checks: Map<string, KeyCheckResult>
  calls: () => string[]
  /** Output folder state: the folder in use, the picker and the next dialog result. */
  folder: {
    inUse: string
    previous: string[]
    picker: OutputFolderStatus['picker']
    choose: ChooseFolderResult
  }
}

export const DEFAULT_FOLDER = '/Users/ana/Library/Application Support/BlockFlow Studio/output'

const NAMES = ['kie_api_key', 'piapi_api_key', 'openrouter_api_key']

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function status(keys: Map<string, string>, name: string) {
  const value = keys.get(name)
  return {
    name,
    configured: Boolean(value),
    last4: value && value.length >= 12 ? value.slice(-4) : null,
    updated_at: value ? '2026-11-15T10:00:00+00:00' : null,
  }
}

export function createFakeBackend(initial: Record<string, string> = {}): FakeBackend {
  const keys = new Map(Object.entries(initial))
  const prefs = new Map<string, string>()
  const overrides = new Map<string, Handler>()
  const checks = new Map<string, KeyCheckResult>()
  const folder: FakeBackend['folder'] = {
    inUse: DEFAULT_FOLDER,
    previous: [],
    picker: { available: true, reason: null },
    choose: { status: 'cancelled' },
  }

  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.split('?')[0]
    const route = `${method} ${path}`
    const custom = overrides.get(route)
    if (custom) return custom(init)

    if (route === 'GET /api/settings/credentials') {
      return json({ credentials: NAMES.map((n) => status(keys, n)) })
    }
    const cred = path.match(/^\/api\/settings\/credentials\/([^/]+)$/)
    if (cred) {
      const name = decodeURIComponent(cred[1])
      if (!NAMES.includes(name)) return json({ detail: 'Unknown credential name.' }, 404)
      if (method === 'GET') return json(status(keys, name))
      if (method === 'PUT') {
        const value = String(JSON.parse(String(init?.body)).value).trim()
        if (!value) return json({ detail: 'API key is empty.' }, 422)
        keys.set(name, value)
        return json(status(keys, name))
      }
      if (method === 'DELETE') {
        keys.delete(name)
        return new Response(null, { status: 204 })
      }
    }
    if (route === 'GET /api/settings/output-folder') {
      const configured = prefs.get('output_dir') || null
      const body: OutputFolderStatus = {
        in_use: folder.inUse,
        default: DEFAULT_FOLDER,
        configured,
        configured_unavailable: false,
        previous: folder.previous.map((path) => ({ path, available: true })),
        picker: folder.picker,
      }
      return json(body)
    }
    if (route === 'POST /api/settings/output-folder/forget') {
      const path = String(JSON.parse(String(init?.body)).path)
      if (!folder.previous.includes(path)) {
        return json({ detail: 'That folder is not in the list of earlier output folders.' }, 404)
      }
      folder.previous = folder.previous.filter((p) => p !== path)
      return json({ in_use: folder.inUse, default: DEFAULT_FOLDER, configured: prefs.get('output_dir') || null,
        configured_unavailable: false, previous: folder.previous.map((p) => ({ path: p, available: true })),
        picker: folder.picker })
    }
    if (route === 'POST /api/settings/choose-folder') return json(folder.choose)
    if (route === 'PUT /api/settings/app-prefs/output_dir') {
      const value = String(JSON.parse(String(init?.body)).value).trim()
      if (value && !value.startsWith('/') && !/^[A-Za-z]:\\/.test(value) && !value.startsWith('\\\\')) {
        return json({ detail: 'Use a full folder path, such as /Users/you/BlockFlow.' }, 400)
      }
      // Mirrors the backend: the switch is immediate and the old folder is remembered.
      const next = value || DEFAULT_FOLDER
      if (next !== folder.inUse) {
        folder.previous = [folder.inUse, ...folder.previous.filter((p) => p !== folder.inUse && p !== next)]
        folder.inUse = next
      }
      prefs.set('output_dir', value)
      return json({ name: 'output_dir', saved: true })
    }
    const pref = path.match(/^\/api\/settings\/app-prefs\/([^/]+)$/)
    if (pref) {
      const name = decodeURIComponent(pref[1])
      if (method === 'GET') return json({ name, value: prefs.get(name) ?? null })
      if (method === 'PUT') {
        const value = String(JSON.parse(String(init?.body)).value)
        if (name.endsWith('_base_url') && value && !/^https?:\/\/[^\s@?#]+$/.test(value)) {
          return json({ detail: 'The URL must start with http:// or https://.' }, 400)
        }
        prefs.set(name, value.replace(/\/+$/, ''))
        return json({ name, saved: true })
      }
    }
    if (route === 'POST /api/blocks/prompt_writer/check-key') {
      const verdict = checks.get('openrouter') ?? (keys.get('openrouter_api_key')
        ? { ok: true, valid: true, message: 'OpenRouter accepted the key.' }
        : { ok: false, valid: null, message: 'No OpenRouter API key is saved.' })
      return json(verdict)
    }
    const check = path.match(/^\/api\/providers\/([^/]+)\/validate-key$/)
    if (check && method === 'POST') {
      const verdict = checks.get(check[1]) ?? { ok: true, valid: true, message: 'Key accepted.' }
      return json(verdict, verdict.ok ? 200 : 502)
    }
    return json({ detail: `unexpected ${route}` }, 500)
  })

  return {
    fetch: fetchMock,
    keys,
    prefs,
    checks,
    folder,
    override: (route, handler) => overrides.set(route, handler),
    calls: () => fetchMock.mock.calls.map(([input, init]) => `${(init?.method ?? 'GET').toUpperCase()} ${String(input)}`),
  }
}
