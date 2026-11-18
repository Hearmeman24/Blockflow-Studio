'use client'

import { GENERATION_CONFIG_KEYS, GenerationBlockShell } from '@/components/byok/generation-block-shell'
import { GENERATION_BLOCK_CONFIGS } from '@/lib/byok/generation-blocks'
import { PORT_IMAGE, PORT_TEXT, type BlockComponentProps, type BlockDef } from '@/lib/pipeline/registry'

const CONFIG = GENERATION_BLOCK_CONFIGS.imageToImage

function ImageToImageBlock(props: BlockComponentProps) {
  return <GenerationBlockShell {...props} config={CONFIG} />
}

export const blockDef: BlockDef = {
  type: 'imageToImage',
  label: 'Image to Image',
  description: 'Edit or restyle images, or upscale one, with your Kie or PiAPI key.',
  size: 'lg',
  role: 'image',
  canStart: true,
  suggestedUpstream: ['uploadImageToTmpfiles', 'textToImage', 'loadCharacter'],
  suggestedDownstream: ['imageViewer', 'imageToVideo'],
  inputs: [
    { name: 'text', kind: PORT_TEXT, required: false },
    { name: 'image', kind: PORT_IMAGE, required: false },
  ],
  outputs: [{ name: 'image', kind: PORT_IMAGE }],
  // Spawned directly upstream when this block is added; references live in the loader.
  starterPrereqs: ['uploadImageToTmpfiles'],
  configKeys: [...GENERATION_CONFIG_KEYS],
  component: ImageToImageBlock,
}
