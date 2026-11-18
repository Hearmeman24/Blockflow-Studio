/**
 * Typed client for the settings backend (`backend/settings_routes.py`) and
 * the provider key check (`POST /api/providers/{provider}/validate-key`).
 *
 * The backend never returns a stored key. Credential calls return a status:
 * whether a key is configured and, for keys of 12+ characters, its last four.
 *
 * Convention:
 *   - GET endpoints that may 404 return `null` instead of throwing
 *   - All other non-2xx responses throw with the server-provided `detail`
 */

import { mutate } from 'swr'
import { ASSET_STORAGE_MODES, type AssetStorageMode } from '@/lib/status'

// kie_api_key and piapi_api_key drive generation. openrouter_api_key is
// optional and only used by the Prompt Writer block.
export const CREDENTIAL_NAMES = ['kie_api_key', 'piapi_api_key', 'openrouter_api_key'] as const
export type CredentialName = typeof CREDENTIAL_NAMES[number]

export type CredentialStatus = {
  name: CredentialName
  configured: boolean
  last4: string | null
  updated_at: string | null
}

export type KeyProvider = 'kie' | 'piapi'

export type KeyCheckResult = {
  /** false when the check itself could not run (provider unreachable, etc.). */
  ok: boolean
  /** true/false is the provider's verdict; null when the check could not run. */
  valid: boolean | null
  message: string
  balance?: number | string
  balance_unit?: string
}

async function _detail(res: Response): Promise<string> {
  try {
    const body = await res.json()
    return typeof body?.detail === 'string' && body.detail ? body.detail : `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

async function _throwIfNonOk(res: Response): Promise<void> {
  if (res.ok) return
  throw new Error(await _detail(res))
}

// === credentials ============================================================

export async function listCredentials(): Promise<CredentialStatus[]> {
  const res = await fetch('/api/settings/credentials', { method: 'GET' })
  await _throwIfNonOk(res)
  const body = await res.json()
  return body.credentials as CredentialStatus[]
}

export async function getCredential(name: CredentialName): Promise<CredentialStatus | null> {
  const res = await fetch(`/api/settings/credentials/${encodeURIComponent(name)}`, { method: 'GET' })
  if (res.status === 404) return null
  await _throwIfNonOk(res)
  return (await res.json()) as CredentialStatus
}

export async function setCredential(name: CredentialName, value: string): Promise<CredentialStatus> {
  const res = await fetch(`/api/settings/credentials/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  })
  await _throwIfNonOk(res)
  return (await res.json()) as CredentialStatus
}

export async function deleteCredential(name: CredentialName): Promise<void> {
  const res = await fetch(`/api/settings/credentials/${encodeURIComponent(name)}`, { method: 'DELETE' })
  await _throwIfNonOk(res)
}

/** `••••` plus the last four characters when the backend provides them. */
export function maskedKey(last4: string | null): string {
  return `••••${last4 ?? ''}`
}

// === provider catalog =======================================================

/** SWR key the generation blocks read provider availability from. */
export const PROVIDER_CATALOG_KEY = '/api/providers/catalog'

/** Revalidate the provider catalog so open blocks see a saved or removed key. */
export function refreshProviderCatalog(): void {
  void mutate(PROVIDER_CATALOG_KEY)
}

// === provider key check =====================================================

export async function validateProviderKey(provider: KeyProvider): Promise<KeyCheckResult> {
  const res = await fetch(`/api/providers/${encodeURIComponent(provider)}/validate-key`, { method: 'POST' })
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error(`HTTP ${res.status}`)
  }
  const verdict = body as Partial<KeyCheckResult> | null
  if (!verdict || typeof verdict.message !== 'string' || typeof verdict.ok !== 'boolean') {
    throw new Error(`HTTP ${res.status}`)
  }
  return verdict as KeyCheckResult
}

// === app-prefs ==============================================================

export async function getAppPref(name: string, defaultValue?: string): Promise<string | null> {
  let url = `/api/settings/app-prefs/${encodeURIComponent(name)}`
  if (defaultValue !== undefined) {
    url += `?default=${encodeURIComponent(defaultValue)}`
  }
  const res = await fetch(url, { method: 'GET' })
  await _throwIfNonOk(res)
  const body = await res.json()
  return body.value as string | null
}

export async function setAppPref(name: string, value: string): Promise<void> {
  const res = await fetch(`/api/settings/app-prefs/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  })
  await _throwIfNonOk(res)
}

export const ASSET_STORAGE_MODE_PREF = 'asset_storage_mode'
// Declared in `@/lib/status`; re-exported for existing imports.
export { ASSET_STORAGE_MODES, type AssetStorageMode }

export function isAssetStorageMode(value: string | null | undefined): value is AssetStorageMode {
  return ASSET_STORAGE_MODES.includes(value as AssetStorageMode)
}

export async function getAssetStorageMode(): Promise<AssetStorageMode> {
  const value = await getAppPref(ASSET_STORAGE_MODE_PREF)
  // Unset or unknown keeps files local, as the backend does.
  return isAssetStorageMode(value) ? value : 'local_only'
}

export async function setAssetStorageMode(value: AssetStorageMode): Promise<void> {
  await setAppPref(ASSET_STORAGE_MODE_PREF, value)
}

/** Store `local_only` when no storage mode has been chosen yet. */
export async function ensureAssetStorageModeDefault(): Promise<void> {
  const value = await getAppPref(ASSET_STORAGE_MODE_PREF)
  if (!isAssetStorageMode(value)) await setAssetStorageMode('local_only')
}

// === local LLM servers (Prompt Writer) ======================================

/** App prefs holding the Ollama / LM Studio base URLs. Empty means the default. */
export const LOCAL_LLM_SERVERS = [
  { id: 'ollama', label: 'Ollama', pref: 'ollama_base_url', defaultUrl: 'http://localhost:11434' },
  { id: 'lmstudio', label: 'LM Studio', pref: 'lmstudio_base_url', defaultUrl: 'http://localhost:1234' },
] as const
export type LocalLlmServer = typeof LOCAL_LLM_SERVERS[number]

// === onboarding =============================================================

export const ONBOARDING_COMPLETED_PREF = 'onboarding_completed'

export async function getOnboardingCompleted(): Promise<boolean> {
  return (await getAppPref(ONBOARDING_COMPLETED_PREF)) === 'true'
}

export async function setOnboardingCompleted(): Promise<void> {
  await setAppPref(ONBOARDING_COMPLETED_PREF, 'true')
}
