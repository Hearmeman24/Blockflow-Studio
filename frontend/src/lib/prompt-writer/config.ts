/**
 * Prompt Writer block settings, saved under the `local_settings` config key.
 *
 * Saved flows from before the BYOK fork stored the same key with the shape
 * `{mode, system_prompt, video_system_prompt, image_system_prompt, model,
 * temperature, max_tokens, reasoning_effort}` and only knew OpenRouter.
 * `normalizeWriterSettings` maps that shape forward: `model` becomes the
 * OpenRouter model, an empty system prompt falls back to the preset, and
 * `reasoning_effort` is dropped (not every provider supports it).
 */
import { isWriterProviderId, type WriterProviderId } from './types'

export type WriterMode = 'video' | 'image'

export interface WriterSettings {
  provider: WriterProviderId | null
  /** The model chosen for each provider, so switching back keeps it. */
  models: Partial<Record<WriterProviderId, string>>
  mode: WriterMode
  video_system_prompt: string
  image_system_prompt: string
  temperature: number
  max_tokens: number
  /** Reuse the (edited) result on the next run instead of calling the model. */
  keep_result: boolean
}

/** `send_media`: which upstream media kinds go to the model (lib/prompt-writer/media.ts). */
export const WRITER_CONFIG_KEYS = ['local_settings', 'user_prompt', 'output', 'send_media'] as const

export const TEMPERATURE_RANGE = { min: 0, max: 2 } as const
export const MAX_TOKENS_RANGE = { min: 1, max: 200_000 } as const
export const DEFAULT_TEMPERATURE = 0.6
export const DEFAULT_MAX_TOKENS = 4096

export const DEFAULT_VIDEO_SYSTEM_PROMPT = `You are an expert cinematic prompt engineer for AI video generation. Turn the user's short idea into one continuous 5–10 second shot.

1. Stylistic translation: translate any director, era or movement the user names into concrete cinematic mechanics: lens choice, lighting, colour grading, camera behaviour and atmosphere. Embody the style through visual execution, not by name alone.
2. One continuous shot: a single uninterrupted take in one location and timeframe. No cuts, montage, time jumps or scene changes. The camera may move but stays physically continuous.
3. Controlled progression: an opening beat that sets mood and framing, a middle beat that builds, and a final beat (a shift, a reveal or a held stillness).
4. Movement: at most 4–6 distinct physical actions paced across the whole shot, at least one interacting with the environment (fabric, furniture, light, smoke, water).
5. Grounded physicality: describe micro-textures, how materials behave, how light falls and realistic body physics.
6. Keep the user's subject, wording and intent. Do not add text overlays, logos or captions unless asked.

Output: one dense paragraph of 800–1200 characters. Plain text only, no headings, labels or metadata.`

export const DEFAULT_IMAGE_SYSTEM_PROMPT = `You are writing a concise visual description for AI image generation.

Your task is to describe a single static image portraying one clear scene. The user defines cinematic style, era, movement, or director reference, and you must translate that reference into practical, observable visual characteristics.

Interpret style through concrete production details only:
- camera position and height
- lens type and distortion
- framing and composition
- lighting direction, intensity, and color
- image texture (grain, noise, digital artifacts)
- environmental layout

Do not use poetic language, symbolism, metaphor, or emotional interpretation. Describe only what can be seen in one still frame.

Static image rules:
- No action sequence.
- No temporal progression.
- No references to cuts, transitions, or real-time duration.
- Focus on posture, composition, materials, and visible details in a frozen moment.

Technical rules:
- No references to sound, music, silence, or dialogue.
- No internal thoughts.
- No metadata, labels, or formatting.

Write one paragraph only.
Plain text.`

export const MODE_LABELS: Record<WriterMode, string> = { video: 'Video prompt', image: 'Image prompt' }

export const DEFAULT_WRITER_SETTINGS: WriterSettings = Object.freeze({
  provider: null,
  models: {},
  mode: 'video',
  video_system_prompt: DEFAULT_VIDEO_SYSTEM_PROMPT,
  image_system_prompt: DEFAULT_IMAGE_SYSTEM_PROMPT,
  temperature: DEFAULT_TEMPERATURE,
  max_tokens: DEFAULT_MAX_TOKENS,
  keep_result: false,
}) as WriterSettings

export function defaultSystemPrompt(mode: WriterMode): string {
  return mode === 'image' ? DEFAULT_IMAGE_SYSTEM_PROMPT : DEFAULT_VIDEO_SYSTEM_PROMPT
}

export function activeSystemPrompt(settings: WriterSettings): string {
  return settings.mode === 'image' ? settings.image_system_prompt : settings.video_system_prompt
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function clampNumber(value: unknown, min: number, max: number, fallback: number, whole = false): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  const v = whole ? Math.trunc(n) : n
  return Math.min(max, Math.max(min, v))
}

/** Any saved `local_settings` value (current, pre-fork, partial or garbage) to valid settings. */
export function normalizeWriterSettings(raw: unknown): WriterSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_WRITER_SETTINGS, models: {} }
  const r = raw as Record<string, unknown>
  const models: Partial<Record<WriterProviderId, string>> = {}
  if (r.models && typeof r.models === 'object' && !Array.isArray(r.models)) {
    for (const [id, model] of Object.entries(r.models as Record<string, unknown>)) {
      const m = text(model)
      if (isWriterProviderId(id) && m) models[id] = m.trim()
    }
  }
  // Pre-fork configs: a single OpenRouter `model`.
  const legacyModel = text(r.model)
  if (legacyModel && !models.openrouter) models.openrouter = legacyModel.trim()
  const provider = isWriterProviderId(r.provider) ? r.provider : legacyModel ? 'openrouter' : null
  const mode: WriterMode = r.mode === 'image' ? 'image' : 'video'
  // Pre-fork `system_prompt` mirrored the prompt of the active mode.
  const legacyActive = text(r.system_prompt)
  return {
    provider,
    models,
    mode,
    video_system_prompt: text(r.video_system_prompt) ?? (mode === 'video' ? legacyActive : null) ?? DEFAULT_VIDEO_SYSTEM_PROMPT,
    image_system_prompt: text(r.image_system_prompt) ?? (mode === 'image' ? legacyActive : null) ?? DEFAULT_IMAGE_SYSTEM_PROMPT,
    temperature: clampNumber(r.temperature, TEMPERATURE_RANGE.min, TEMPERATURE_RANGE.max, DEFAULT_TEMPERATURE),
    max_tokens: clampNumber(r.max_tokens, MAX_TOKENS_RANGE.min, MAX_TOKENS_RANGE.max, DEFAULT_MAX_TOKENS, true),
    keep_result: r.keep_result === true,
  }
}
