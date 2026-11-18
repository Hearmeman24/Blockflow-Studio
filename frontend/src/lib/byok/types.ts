/**
 * Types for `GET /api/providers/catalog`, mirroring
 * `backend.byok.ledger.catalog_payload` and the dataclasses in
 * `backend/byok/spec.py`. The fixtures in `__fixtures__/` are generated from
 * the ledger and `tests/test_byok_catalog_fixture.py` fails when they drift,
 * so these types are checked against real payloads by the frontend tests.
 *
 * Nothing here names a model, a limit or a provider rule: every value comes
 * from the payload.
 */

export type ProviderId = string
export type ModelId = string

export type GenerationMode =
  | 'text_to_video'
  | 'image_to_video'
  | 'omni_reference_to_video'
  | 'text_to_image'
  | 'image_to_image'

/** `audio` is any sound (a voice sample, music, ambience); the prompt says how the model uses it. */
export type MediaKind = 'image' | 'video' | 'audio'
export const MEDIA_KINDS: readonly MediaKind[] = ['image', 'video', 'audio']

export type ReferenceRole = 'reference' | 'first_frame' | 'last_frame'
export const REFERENCE_ROLES: readonly ReferenceRole[] = ['first_frame', 'last_frame', 'reference']

export type PromptRequirement = 'required' | 'optional' | 'none'
export type SettingType = 'bool' | 'int' | 'enum'
export type SettingCategory = 'general' | 'content' | 'variant'
export type SettingValue = string | number | boolean | null

export interface ProviderModelIds {
  model: string
  task_type: string | null
  version: string | null
}

export interface PromptSpec {
  requirement: PromptRequirement
  max_length: number | null
  min_length: number | null
}

export interface MediaLimit {
  kind: MediaKind
  max_count: number
  min_count: number
  formats: string[]
  max_size_bytes: number | null
  min_duration_s: number | null
  max_duration_s: number | null
  max_total_duration_s: number | null
  min_total_duration_s: number | null
  min_side_px: number | null
  max_side_px: number | null
  min_aspect: number | null
  max_aspect: number | null
}

export interface FrameSpec {
  first_frame_required: boolean
  last_frame_allowed: boolean
}

export interface ChoiceSpec {
  values: string[]
  /** `null` means the field is omitted from the provider request unless set. */
  default: string | null
}

export interface DurationSpec {
  min_s: number
  max_s: number
  default: number
  /** Provider sentinel that lets the model choose (Kie uses -1). */
  auto_value: number | null
}

export interface SettingSpec {
  key: string
  type: SettingType
  label: string
  default: SettingValue
  choices: Array<string | number | boolean>
  minimum: number | null
  maximum: number | null
  description: string
  category: SettingCategory
}

/** How the prompt refers to references (`{n}` = position within the kind). */
export interface MentionSpec {
  image: string
  video: string
  audio: string
  first_frame: string | null
  last_frame: string | null
  /** False when the provider documents no syntax and the plain form is used. */
  documented: boolean
}

export interface ModeSpec {
  mode: GenerationMode
  supported: boolean
  ids: ProviderModelIds | null
  prompt: PromptSpec
  media: MediaLimit[]
  frames: FrameSpec | null
  max_total_references: number | null
  min_total_references: number
  mixed_media_allowed: boolean
  audio_only_allowed: boolean
  duration: DurationSpec | null
  resolutions: ChoiceSpec | null
  aspect_ratios: ChoiceSpec | null
  settings: SettingSpec[]
  rules: string[]
  variant_key: string | null
  /** `[variant value, spec]` pairs, e.g. GPT Image tiers. */
  variants: Array<[string, ModeSpec]>
  unavailable_reason: string | null
  notes: string[]
  /** Prompt mention syntax; set for modes that take references. */
  mentions?: MentionSpec | null
  /** Present on top-level mode entries of a provider status (not on variants). */
  available?: boolean
}

export interface ProviderStatus {
  offered: boolean
  configured: boolean
  available: boolean
  unavailable_reason: string | null
  modes: Partial<Record<GenerationMode, ModeSpec>>
}

export interface CatalogModel {
  id: ModelId
  name: string
  output: 'video' | 'image'
  nsfw: boolean
  description: string
  available: boolean
  providers: Record<ProviderId, ProviderStatus>
}

export interface CatalogProvider {
  id: ProviderId
  name: string
  configured: boolean
}

export interface ProviderCatalog {
  providers: Record<ProviderId, CatalogProvider>
  modes: Array<{ id: GenerationMode; name: string }>
  media_kinds: MediaKind[]
  models: CatalogModel[]
  unsupported_features: Array<{ id: string; label: string }>
  unverified: Array<{ provider: string; model: string; field: string; detail: string }>
}

// ---- Requests and issues (POST /api/generation/validate|submit) ----

export type IssueSeverity = 'error' | 'warning'

export interface GenerationIssue {
  code: string
  severity: IssueSeverity
  field: string
  message: string
  limit?: unknown
  actual?: unknown
}

/** One reference as sent to the backend. `local` is an `/outputs/...` path. */
export interface RequestReference {
  kind: MediaKind
  url?: string
  local?: string
  role?: ReferenceRole
  duration_s?: number
  size_bytes?: number
  width?: number
  height?: number
  format?: string
}

export interface GenerationParams {
  prompt?: string
  duration?: number
  resolution?: string
  aspect_ratio?: string
  settings: Record<string, SettingValue>
}

export interface GenerationRequest {
  provider: ProviderId
  model: ModelId
  mode: GenerationMode
  params: GenerationParams
  references: RequestReference[]
}

export interface SubmitRequest extends GenerationRequest {
  source: 'pipeline'
  client_request_id: string
}
