'use client'

import { GENERATION_CONFIG_KEYS, GenerationBlockShell } from '@/components/byok/generation-block-shell'
import { GENERATION_BLOCK_CONFIGS } from '@/lib/byok/generation-blocks'
import { PORT_IMAGE, PORT_TEXT, type BlockComponentProps, type BlockDef } from '@/lib/pipeline/registry'

const CONFIG = GENERATION_BLOCK_CONFIGS.textToImage

function TextToImageBlock(props: BlockComponentProps) {
  return <GenerationBlockShell {...props} config={CONFIG} />
}

export const blockDef: BlockDef = {
  type: 'textToImage',
  label: 'Text to Image',
  description: 'Generate an image from a prompt with your Kie or PiAPI key.',
  size: 'lg',
  role: 'image',
  canStart: true,
  suggestedUpstream: ['promptFromTxt'],
  suggestedDownstream: ['imageViewer', 'imageToVideo', 'imageToImage'],
  inputs: [{ name: 'text', kind: PORT_TEXT, required: false }],
  outputs: [{ name: 'image', kind: PORT_IMAGE }],
  configKeys: [...GENERATION_CONFIG_KEYS],
  component: TextToImageBlock,
}
