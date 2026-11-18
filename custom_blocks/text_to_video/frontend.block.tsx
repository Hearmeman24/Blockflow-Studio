'use client'

import { GENERATION_CONFIG_KEYS, GenerationBlockShell } from '@/components/byok/generation-block-shell'
import { GENERATION_BLOCK_CONFIGS } from '@/lib/byok/generation-blocks'
import { PORT_TEXT, PORT_VIDEO, type BlockComponentProps, type BlockDef } from '@/lib/pipeline/registry'

const CONFIG = GENERATION_BLOCK_CONFIGS.textToVideo

function TextToVideoBlock(props: BlockComponentProps) {
  return <GenerationBlockShell {...props} config={CONFIG} />
}

export const blockDef: BlockDef = {
  type: 'textToVideo',
  label: 'Text to Video',
  description: 'Generate a video from a prompt with your Kie or PiAPI key.',
  size: 'lg',
  role: 'video',
  canStart: true,
  suggestedUpstream: ['promptFromTxt'],
  suggestedDownstream: ['videoViewer'],
  inputs: [{ name: 'text', kind: PORT_TEXT, required: false }],
  outputs: [{ name: 'video', kind: PORT_VIDEO }],
  configKeys: [...GENERATION_CONFIG_KEYS],
  component: TextToVideoBlock,
}
