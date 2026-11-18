/** Wire types for `/api/blocks/prompt_writer/*` (custom_blocks/prompt_writer/backend.block.py). */
import type { RequestReference } from '@/lib/byok/types'

export const WRITER_PROVIDER_IDS = ['openrouter', 'ollama', 'lmstudio'] as const
export type WriterProviderId = typeof WRITER_PROVIDER_IDS[number]

/** Inputs a model may take besides text, in this order everywhere. */
export const WRITER_MEDIA_KINDS = ['image', 'video', 'audio'] as const
export type WriterMediaKind = typeof WRITER_MEDIA_KINDS[number]

export interface WriterModel {
  id: string
  name: string
  /** Input kinds the model takes besides text. Local models take images at most. */
  accepts: WriterMediaKind[]
}

export interface WriterProviderStatus {
  id: WriterProviderId
  label: string
  kind: 'hosted' | 'local'
  /** Only an available provider can be selected. */
  available: boolean
  /** Why it is unavailable, e.g. "Ollama is not running at http://localhost:11434". */
  reason: string | null
  models: WriterModel[]
  /** Set when an available provider's model list could not be loaded; the block asks for a model ID. */
  models_error: string | null
  base_url: string | null
}

export const WRITER_ERROR_KINDS = [
  'validation',
  'unavailable',
  'auth',
  'insufficient_credits',
  'rate_limited',
  'model_not_found',
  'timeout',
  'network',
  'provider_failure',
  'malformed_response',
] as const
export type WriterErrorKind = typeof WRITER_ERROR_KINDS[number]

export interface WriterGenerateRequest {
  provider: WriterProviderId
  model: string
  input: string
  system_prompt: string
  /** OpenRouter only: Ollama and LM Studio use their own sampling settings. */
  temperature?: number
  max_tokens?: number
  /** Upstream files sent with the prompt, in the shape the pipeline passes references (`local` is `/outputs/...`). */
  media?: RequestReference[]
}

export type WriterGenerateResult =
  | { ok: true; text: string }
  | { ok: false; kind: WriterErrorKind; message: string }

export function isWriterProviderId(value: unknown): value is WriterProviderId {
  return typeof value === 'string' && (WRITER_PROVIDER_IDS as readonly string[]).includes(value)
}

export function isWriterMediaKind(value: unknown): value is WriterMediaKind {
  return typeof value === 'string' && (WRITER_MEDIA_KINDS as readonly string[]).includes(value)
}
