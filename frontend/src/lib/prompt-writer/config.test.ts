import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IMAGE_SYSTEM_PROMPT,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_VIDEO_SYSTEM_PROMPT,
  normalizeWriterSettings,
} from './config'

describe('normalizeWriterSettings', () => {
  it.each([null, undefined, 'text', 42, [], true])('turns %s into the defaults', (raw) => {
    expect(normalizeWriterSettings(raw)).toEqual({
      provider: null,
      models: {},
      mode: 'video',
      video_system_prompt: DEFAULT_VIDEO_SYSTEM_PROMPT,
      image_system_prompt: DEFAULT_IMAGE_SYSTEM_PROMPT,
      temperature: DEFAULT_TEMPERATURE,
      max_tokens: DEFAULT_MAX_TOKENS,
      keep_result: false,
    })
  })

  it('maps a pre-fork OpenRouter config forward', () => {
    expect(normalizeWriterSettings({
      mode: 'video',
      system_prompt: 'legacy active prompt',
      image_system_prompt: '',
      model: ' x-ai/grok-4.1-fast ',
      temperature: '0.8',
      max_tokens: 100000,
      reasoning_effort: 'high',
    })).toEqual({
      provider: 'openrouter',
      models: { openrouter: 'x-ai/grok-4.1-fast' },
      mode: 'video',
      video_system_prompt: 'legacy active prompt',
      image_system_prompt: DEFAULT_IMAGE_SYSTEM_PROMPT,
      temperature: 0.8,
      max_tokens: 100000,
      keep_result: false,
    })
  })

  it('uses the legacy active prompt only for the mode it belonged to', () => {
    const s = normalizeWriterSettings({ mode: 'image', system_prompt: 'image style' })
    expect(s.image_system_prompt).toBe('image style')
    expect(s.video_system_prompt).toBe(DEFAULT_VIDEO_SYSTEM_PROMPT)
  })

  it('keeps per-provider models and drops unknown providers and blank models', () => {
    const s = normalizeWriterSettings({ provider: 'lmstudio', models: { lmstudio: 'gemma', ollama: '  ', bogus: 'x' } })
    expect(s.provider).toBe('lmstudio')
    expect(s.models).toEqual({ lmstudio: 'gemma' })
  })

  it('clamps numbers and ignores non-numbers', () => {
    expect(normalizeWriterSettings({ temperature: 9, max_tokens: 0 })).toMatchObject({ temperature: 2, max_tokens: 1 })
    expect(normalizeWriterSettings({ temperature: 'hot', max_tokens: 12.7 })).toMatchObject({
      temperature: DEFAULT_TEMPERATURE, max_tokens: 12,
    })
    expect(normalizeWriterSettings({ max_tokens: 10_000_000 }).max_tokens).toBe(200_000)
  })

  it('keeps unicode prompts untouched', () => {
    expect(normalizeWriterSettings({ video_system_prompt: 'Stil: filmisch ✓ 映画' }).video_system_prompt).toBe('Stil: filmisch ✓ 映画')
  })
})
