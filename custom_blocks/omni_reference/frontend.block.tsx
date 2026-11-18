'use client'

import { GENERATION_CONFIG_KEYS, GenerationBlockShell } from '@/components/byok/generation-block-shell'
import { GENERATION_BLOCK_CONFIGS } from '@/lib/byok/generation-blocks'
import {
  PORT_AUDIO,
  PORT_IMAGE,
  PORT_TEXT,
  PORT_VIDEO,
  type BlockComponentProps,
  type BlockDef,
} from '@/lib/pipeline/registry'

const CONFIG = GENERATION_BLOCK_CONFIGS.omniReferenceToVideo

function OmniReferenceBlock(props: BlockComponentProps) {
  return <GenerationBlockShell {...props} config={CONFIG} />
}

export const blockDef: BlockDef = {
  type: 'omniReferenceToVideo',
  label: 'Omni Reference to Video',
  description: 'Generate a video guided by reference videos, images and audio.',
  size: 'huge',
  role: 'video',
  canStart: true,
  suggestedUpstream: ['omniReferenceLoader', 'loadCharacter'],
  suggestedDownstream: ['videoViewer'],
  inputs: [
    { name: 'text', kind: PORT_TEXT, required: false },
    { name: 'image', kind: PORT_IMAGE, required: false },
    { name: 'video', kind: PORT_VIDEO, required: false },
    { name: 'audio', kind: PORT_AUDIO, required: false },
  ],
  outputs: [{ name: 'video', kind: PORT_VIDEO }],
  // Spawned directly upstream when this block is added; references live in the loader.
  starterPrereqs: ['omniReferenceLoader'],
  configKeys: [...GENERATION_CONFIG_KEYS],
  component: OmniReferenceBlock,
}
