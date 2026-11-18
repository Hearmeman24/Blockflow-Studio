/**
 * Generation parameters (duration, resolution, aspect ratio, settings) as a
 * block stores them, and how they map onto a ModeSpec. A stored `null` means
 * "use the ledger default", which the backend fills in, so only values the
 * user chose are sent.
 */
import type { GenerationParams, ModeSpec, SettingSpec, SettingValue } from './types'

export interface ParamState {
  duration: number | null
  resolution: string | null
  aspect_ratio: string | null
  settings: Record<string, SettingValue>
}

export const EMPTY_PARAMS: ParamState = Object.freeze({
  duration: null,
  resolution: null,
  aspect_ratio: null,
  settings: Object.freeze({}) as Record<string, SettingValue>,
}) as ParamState

/** A value that was reset because the newly selected model cannot use it. */
export interface ParamChange {
  field: string
  label: string
  from: SettingValue
  to: SettingValue
  message: string
}

export function defaultParams(spec: ModeSpec): ParamState {
  const settings: Record<string, SettingValue> = {}
  for (const s of spec.settings) settings[s.key] = s.default
  return {
    duration: spec.duration?.default ?? null,
    resolution: spec.resolutions?.default ?? null,
    aspect_ratio: spec.aspect_ratios?.default ?? null,
    settings,
  }
}

/** `field` is `duration`, `resolution`, `aspect_ratio` or `settings.<key>`. */
export function displayValue(spec: ModeSpec, params: ParamState, field: string): SettingValue {
  const defaults = defaultParams(spec)
  if (field.startsWith('settings.')) {
    const key = field.slice('settings.'.length)
    return params.settings[key] ?? defaults.settings[key] ?? null
  }
  const key = field as 'duration' | 'resolution' | 'aspect_ratio'
  return params[key] ?? defaults[key]
}

export function isValidDuration(spec: ModeSpec, value: unknown): boolean {
  const d = spec.duration
  if (!d) return false
  if (typeof value !== 'number' || !Number.isInteger(value)) return false
  return (value >= d.min_s && value <= d.max_s) || (d.auto_value !== null && value === d.auto_value)
}

export function isValidSetting(setting: SettingSpec, value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (setting.type === 'bool') return typeof value === 'boolean'
  if (setting.type === 'int') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return false
    if (setting.minimum !== null && value < setting.minimum) return false
    if (setting.maximum !== null && value > setting.maximum) return false
    return true
  }
  return typeof value !== 'boolean' && setting.choices.includes(value as string | number)
}

function show(value: SettingValue): string {
  if (value === null) return 'the provider default'
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  return String(value)
}

/**
 * Check stored values against a newly selected spec. Values the spec cannot
 * use are reset to its default, and each reset is returned so the UI can show
 * it; nothing changes silently. Values for fields the spec does not have are
 * kept (they are not sent) so switching back restores them. Pure.
 */
export function reconcileParams(
  spec: ModeSpec,
  params: ParamState,
  where: string,
): { params: ParamState; changes: ParamChange[] } {
  const defaults = defaultParams(spec)
  const changes: ParamChange[] = []
  const next: ParamState = { ...params, settings: { ...params.settings } }
  const reset = (field: string, label: string, from: SettingValue, to: SettingValue) => {
    changes.push({
      field,
      label,
      from,
      to,
      message: `${label} ${show(from)} is not available for ${where}; reset to ${show(to)}.`,
    })
  }

  if (spec.duration && params.duration !== null && !isValidDuration(spec, params.duration)) {
    reset('duration', 'Duration', params.duration, defaults.duration)
    next.duration = null
  }
  if (spec.resolutions && params.resolution !== null && !spec.resolutions.values.includes(params.resolution)) {
    reset('resolution', 'Resolution', params.resolution, defaults.resolution)
    next.resolution = null
  }
  if (spec.aspect_ratios && params.aspect_ratio !== null && !spec.aspect_ratios.values.includes(params.aspect_ratio)) {
    reset('aspect_ratio', 'Aspect ratio', params.aspect_ratio, defaults.aspect_ratio)
    next.aspect_ratio = null
  }
  for (const setting of spec.settings) {
    const value = params.settings[setting.key]
    if (value === undefined || value === null || isValidSetting(setting, value)) continue
    reset(`settings.${setting.key}`, setting.label, value, setting.default)
    next.settings[setting.key] = null
  }
  return changes.length > 0 ? { params: next, changes } : { params, changes }
}

/** The `params` object for validate/submit: only fields the spec has, without empty values. */
export function buildRequestParams(spec: ModeSpec, params: ParamState, prompt: string): GenerationParams {
  const out: GenerationParams = { settings: {} }
  if (spec.prompt.requirement !== 'none' && prompt.trim()) out.prompt = prompt
  if (spec.duration && params.duration !== null) out.duration = params.duration
  if (spec.resolutions && params.resolution !== null) out.resolution = params.resolution
  if (spec.aspect_ratios && params.aspect_ratio !== null) out.aspect_ratio = params.aspect_ratio
  for (const setting of spec.settings) {
    const value = params.settings[setting.key]
    if (value !== undefined && value !== null) out.settings[setting.key] = value
  }
  return out
}
