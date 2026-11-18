'use client'

import { GENERATION_CONFIG_KEYS, GenerationBlockShell } from '@/components/byok/generation-block-shell'
import { GENERATION_BLOCK_CONFIGS } from '@/lib/byok/generation-blocks'
import { PORT_IMAGE, PORT_TEXT, PORT_VIDEO, type BlockComponentProps, type BlockDef } from '@/lib/pipeline/registry'

const CONFIG = GENERATION_BLOCK_CONFIGS.imageToVideo

function ImageToVideoBlock(props: BlockComponentProps) {
  return <GenerationBlockShell {...props} config={CONFIG} />
}

export const blockDef: BlockDef = {
  type: 'imageToVideo',
  label: 'Image to Video',
  description: 'Animate a first frame, with an optional last frame where the model allows one.',
  size: 'lg',
  role: 'video',
  canStart: true,
  suggestedUpstream: ['uploadImageToTmpfiles', 'textToImage', 'loadCharacter'],
  suggestedDownstream: ['videoViewer'],
  inputs: [
    { name: 'text', kind: PORT_TEXT, required: false },
    { name: 'image', kind: PORT_IMAGE, required: false },
  ],
  outputs: [{ name: 'video', kind: PORT_VIDEO }],
  // Spawned directly upstream when this block is added; references live in the loader.
  starterPrereqs: ['uploadImageToTmpfiles'],
  configKeys: [...GENERATION_CONFIG_KEYS],
  component: ImageToVideoBlock,
}
