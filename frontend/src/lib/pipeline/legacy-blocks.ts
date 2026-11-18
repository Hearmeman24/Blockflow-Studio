import { getNodeType } from './registry'
import type { PipelineBlock } from './types'

/**
 * Block types that existed in earlier BlockFlow releases and were removed by
 * the BYOK fork. Flows that still contain them load as unsupported blocks; this
 * table supplies the human label and the one-line reason the card shows.
 *
 * Keys are the exact `type` strings older releases wrote into saved flows.
 */
export interface LegacyBlockInfo {
  label: string
  reason: string
}

const REPLACED_BY_GENERATION = 'was replaced by the generation blocks in this version.'
const PROMPT_WRITERS_REMOVED = 'The I2V and multimodal prompt writers were removed in this version.'

export const LEGACY_BLOCKS: Readonly<Record<string, LegacyBlockInfo>> = Object.freeze({
  comfyGen: { label: 'ComfyUI Gen', reason: 'ComfyUI generation was removed in this version.' },
  generation: { label: 'Wan 2.2 Text-To-Video', reason: 'ComfyUI generation was removed in this version.' },
  wan22ImageToVideo: { label: 'Wan 2.2 Image-To-Video', reason: 'ComfyUI generation was removed in this version.' },
  loraSelector: { label: 'LoRA Selector', reason: 'LoRA selection for ComfyUI was removed in this version.' },
  loraTrain: { label: 'LoRA Train', reason: 'LoRA training on RunPod was removed in this version.' },
  datasetCreate: { label: 'Dataset Create', reason: 'Dataset creation on RunPod was removed in this version.' },
  datasetCaption: { label: 'Dataset Caption', reason: 'Dataset captioning was removed in this version.' },
  nanoBanana2: { label: 'Nano Banana 2 (RunPod)', reason: 'RunPod generation was removed in this version.' },
  upscale: { label: 'Video Upscale (Topaz)', reason: 'Topaz video upscaling was removed in this version.' },
  imageUpscale: { label: 'Image Upscale (Topaz)', reason: 'Topaz image upscaling was removed in this version.' },
  civitaiShare: { label: 'CivitAI Share', reason: 'CivitAI publishing was removed in this version.' },
  i2vPromptWriter: { label: 'I2V Prompt Writer', reason: PROMPT_WRITERS_REMOVED },
  multimodalPromptWriter: { label: 'Multimodal Prompt Writer', reason: PROMPT_WRITERS_REMOVED },
  elevenLabsTts: { label: 'ElevenLabs TTS', reason: 'ElevenLabs text-to-speech was removed in this version.' },
  seedance: { label: 'Seedance 2 (PiAPI)', reason: `The legacy Seedance block ${REPLACED_BY_GENERATION}` },
  gptImagePiapi: { label: 'GPT Image (PiAPI)', reason: `The legacy GPT Image block ${REPLACED_BY_GENERATION}` },
  klingOmni: { label: 'Kling Omni (PiAPI)', reason: `The legacy Kling Omni block ${REPLACED_BY_GENERATION}` },
})

export const UNKNOWN_BLOCK_REASON = 'This block type is not available in this version of BlockFlow.'

export function isBlockTypeRegistered(type: string): boolean {
  return getNodeType(type) !== undefined
}

/** Label and reason for a block type that is not registered. */
export function describeUnsupportedBlock(type: string): LegacyBlockInfo & { known: boolean } {
  const info = Object.prototype.hasOwnProperty.call(LEGACY_BLOCKS, type) ? LEGACY_BLOCKS[type] : undefined
  if (info) return { label: info.label, reason: info.reason, known: true }
  return { label: type || 'Unknown block', reason: UNKNOWN_BLOCK_REASON, known: false }
}

// ---- Run guard ----

export interface UnsupportedRunBlocker {
  id: string
  type: string
  label: string
}

/**
 * Enabled blocks the runner cannot execute. The runner skips a disabled block
 * together with its branches, so nothing under a disabled block blocks a run.
 */
export function findRunBlockingUnsupportedBlocks(
  blocks: PipelineBlock[],
  isRegistered: (type: string) => boolean = isBlockTypeRegistered,
): UnsupportedRunBlocker[] {
  const found: UnsupportedRunBlocker[] = []
  const visit = (chain: PipelineBlock[]) => {
    for (const block of chain) {
      if (block.disabled) continue
      if (!isRegistered(block.type)) {
        found.push({
          id: block.id,
          type: block.type,
          label: block.label || describeUnsupportedBlock(block.type).label,
        })
      }
      for (const branch of block.branches ?? []) visit(branch)
    }
  }
  visit(blocks)
  return found
}

export function formatUnsupportedRunMessage(blockers: UnsupportedRunBlocker[]): string {
  if (blockers.length === 1) {
    return `Pipeline not started: "${blockers[0].label}" is no longer supported. Remove or disable it, then run again.`
  }
  const names = blockers.map((b) => `"${b.label}"`).join(', ')
  return `Pipeline not started: ${blockers.length} blocks are no longer supported (${names}). Remove or disable them, then run again.`
}

// ---- Recoverable text ----

/** Config keys whose string values are worth showing so the user can copy them out. */
const RECOVERABLE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['prompt', 'Prompt'],
  ['positive_prompt', 'Positive prompt'],
  ['negative_prompt', 'Negative prompt'],
  ['user_prompt', 'User prompt'],
  ['system_prompt', 'System prompt'],
  ['text', 'Text'],
  ['caption', 'Caption'],
  ['prompts', 'Prompts'],
  ['extra_user_prompts', 'Extra user prompts'],
]

export const MAX_RECOVERABLE_ENTRIES = 20

export interface RecoverableText {
  key: string
  label: string
  text: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Prompt-like strings from an unsupported block's saved config. Never throws. */
export function extractRecoverableText(config: unknown): RecoverableText[] {
  if (!isPlainObject(config)) return []
  const out: RecoverableText[] = []
  const push = (entry: RecoverableText) => {
    if (out.length < MAX_RECOVERABLE_ENTRIES && entry.text.trim().length > 0) out.push(entry)
  }
  for (const [key, label] of RECOVERABLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) continue
    const value = config[key]
    if (typeof value === 'string') {
      push({ key, label, text: value })
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === 'string') push({ key: `${key}.${index}`, label: `${label} ${index + 1}`, text: item })
      })
    }
  }
  return out
}
