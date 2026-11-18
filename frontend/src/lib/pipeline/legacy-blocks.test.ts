import { describe, it, expect } from 'vitest'
import {
  LEGACY_BLOCKS,
  UNKNOWN_BLOCK_REASON,
  describeUnsupportedBlock,
  extractRecoverableText,
  findRunBlockingUnsupportedBlocks,
  formatUnsupportedRunMessage,
  MAX_RECOVERABLE_ENTRIES,
} from './legacy-blocks'
import type { PipelineBlock } from './types'

const REMOVED_TYPES = [
  'comfyGen',
  'loraTrain',
  'upscale',
  'imageUpscale',
  'nanoBanana2',
  'datasetCreate',
  'datasetCaption',
  'civitaiShare',
  'i2vPromptWriter',
  'multimodalPromptWriter',
  'elevenLabsTts',
  'seedance',
  'gptImagePiapi',
  'loraSelector',
  'generation',
  'wan22ImageToVideo',
  'klingOmni',
]

describe('LEGACY_BLOCKS', () => {
  it('describes every block type the BYOK fork removed', () => {
    expect(Object.keys(LEGACY_BLOCKS).sort()).toEqual([...REMOVED_TYPES].sort())
  })

  it.each(REMOVED_TYPES)('%s has a human label and a one-line reason', (type) => {
    const info = LEGACY_BLOCKS[type]
    expect(info.label.trim().length).toBeGreaterThan(0)
    expect(info.label).not.toBe(type)
    expect(info.reason).toMatch(/\.$/)
    expect(info.reason).not.toContain('\n')
  })

  it('no longer lists the Prompt Writer, which is back; its I2V and multimodal variants stay removed', () => {
    expect(Object.prototype.hasOwnProperty.call(LEGACY_BLOCKS, 'promptWriter')).toBe(false)
    expect(LEGACY_BLOCKS.i2vPromptWriter.reason).toBe('The I2V and multimodal prompt writers were removed in this version.')
    expect(LEGACY_BLOCKS.multimodalPromptWriter.reason).toBe(LEGACY_BLOCKS.i2vPromptWriter.reason)
  })

  it('maps comfyGen to the ComfyUI label and reason', () => {
    expect(describeUnsupportedBlock('comfyGen')).toEqual({
      label: 'ComfyUI Gen',
      reason: 'ComfyUI generation was removed in this version.',
      known: true,
    })
  })
})

describe('describeUnsupportedBlock', () => {
  it('returns a generic message for types it has never heard of', () => {
    expect(describeUnsupportedBlock('someonesPrivateBlock')).toEqual({
      label: 'someonesPrivateBlock',
      reason: UNKNOWN_BLOCK_REASON,
      known: false,
    })
  })

  it('does not treat Object.prototype keys as legacy types', () => {
    expect(describeUnsupportedBlock('constructor').known).toBe(false)
    expect(describeUnsupportedBlock('__proto__').known).toBe(false)
  })

  it('falls back to a placeholder label for an empty type', () => {
    expect(describeUnsupportedBlock('').label).toBe('Unknown block')
  })
})

describe('extractRecoverableText', () => {
  it('returns prompt-like string values in a stable key order', () => {
    expect(
      extractRecoverableText({
        model: 'x',
        negative_prompt: 'blurry',
        prompt: 'a red fox',
        text: 'hello',
      }),
    ).toEqual([
      { key: 'prompt', label: 'Prompt', text: 'a red fox' },
      { key: 'negative_prompt', label: 'Negative prompt', text: 'blurry' },
      { key: 'text', label: 'Text', text: 'hello' },
    ])
  })

  it('expands string arrays (prompt lists) into numbered entries and skips non-strings', () => {
    expect(extractRecoverableText({ prompts: ['one', 2, null, 'three', ''] })).toEqual([
      { key: 'prompts.0', label: 'Prompts 1', text: 'one' },
      { key: 'prompts.3', label: 'Prompts 4', text: 'three' },
    ])
  })

  it.each([
    ['null config', null],
    ['undefined config', undefined],
    ['array config', ['prompt']],
    ['string config', 'prompt'],
    ['number config', 4],
  ])('returns nothing for %s', (_name, config) => {
    expect(extractRecoverableText(config)).toEqual([])
  })

  it('ignores non-string, nested and whitespace-only prompt values', () => {
    expect(
      extractRecoverableText({
        prompt: { nested: 'no' },
        text: 42,
        negative_prompt: '   ',
        user_prompt: null,
        system_prompt: true,
      }),
    ).toEqual([])
  })

  it('keeps huge text intact (display truncation is the card’s job)', () => {
    const huge = 'x'.repeat(200_000)
    expect(extractRecoverableText({ prompt: huge })[0].text).toHaveLength(200_000)
  })

  it('caps the number of entries', () => {
    const prompts = Array.from({ length: 500 }, (_, i) => `p${i}`)
    expect(extractRecoverableText({ prompts })).toHaveLength(MAX_RECOVERABLE_ENTRIES)
  })

  it('preserves Unicode text', () => {
    expect(extractRecoverableText({ prompt: 'ünïcødé ✓ 日本語' })[0].text).toBe('ünïcødé ✓ 日本語')
  })
})

describe('findRunBlockingUnsupportedBlocks', () => {
  const registered = new Set(['ok'])
  const isRegistered = (type: string) => registered.has(type)

  it('finds enabled unregistered blocks across trunk and branches', () => {
    const blocks: PipelineBlock[] = [
      { id: 'a', type: 'ok' },
      { id: 'b', type: 'comfyGen', label: 'My Gen' },
      {
        id: 'c',
        type: 'ok',
        branches: [[{ id: 'd', type: 'mysteryBlock' }]],
      },
    ]
    expect(findRunBlockingUnsupportedBlocks(blocks, isRegistered)).toEqual([
      { id: 'b', type: 'comfyGen', label: 'My Gen' },
      { id: 'd', type: 'mysteryBlock', label: 'mysteryBlock' },
    ])
  })

  it('ignores disabled unsupported blocks and anything under a disabled block', () => {
    const blocks: PipelineBlock[] = [
      { id: 'a', type: 'comfyGen', disabled: true },
      { id: 'b', type: 'ok', disabled: true, branches: [[{ id: 'c', type: 'loraTrain' }]] },
      { id: 'd', type: 'ok' },
    ]
    expect(findRunBlockingUnsupportedBlocks(blocks, isRegistered)).toEqual([])
  })

  it('uses the legacy label when the block has no custom label', () => {
    expect(findRunBlockingUnsupportedBlocks([{ id: 'x', type: 'loraTrain' }], isRegistered)).toEqual([
      { id: 'x', type: 'loraTrain', label: 'LoRA Train' },
    ])
  })
})

describe('formatUnsupportedRunMessage', () => {
  it('names a single block and says to remove or disable it', () => {
    expect(formatUnsupportedRunMessage([{ id: 'x', type: 'comfyGen', label: 'ComfyUI Gen' }])).toBe(
      'Pipeline not started: "ComfyUI Gen" is no longer supported. Remove or disable it, then run again.',
    )
  })

  it('names every block when there are several', () => {
    expect(
      formatUnsupportedRunMessage([
        { id: 'x', type: 'comfyGen', label: 'ComfyUI Gen' },
        { id: 'y', type: 'loraTrain', label: 'LoRA Train' },
      ]),
    ).toBe(
      'Pipeline not started: 2 blocks are no longer supported ("ComfyUI Gen", "LoRA Train"). Remove or disable them, then run again.',
    )
  })
})
