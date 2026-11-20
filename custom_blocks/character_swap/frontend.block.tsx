'use client'

/**
 * Character Swap: replaces the person in a driving video with the person from
 * an image. A generation block with a fixed prompt and a fixed set of models;
 * the video and the image come from the two loaders spawned with it.
 */
import { GenerationBlockShell } from '@/components/byok/generation-block-shell'
import { GENERATION_BLOCK_CONFIGS } from '@/lib/byok/generation-blocks'
import { PORT_IMAGE, PORT_VIDEO, type BlockComponentProps, type BlockDef } from '@/lib/pipeline/registry'

const CONFIG = GENERATION_BLOCK_CONFIGS.characterSwap

function CharacterSwapBlock(props: BlockComponentProps) {
  return <GenerationBlockShell {...props} config={CONFIG} />
}

export const blockDef: BlockDef = {
  type: 'characterSwap',
  label: 'Character Swap',
  description: 'Replace the person in a video with the person from an image.',
  size: 'lg',
  role: 'video',
  canStart: true,
  suggestedUpstream: ['videoLoader', 'uploadImageToTmpfiles', 'loadCharacter'],
  suggestedDownstream: ['videoViewer'],
  inputs: [
    { name: 'video', kind: PORT_VIDEO, required: false },
    { name: 'image', kind: PORT_IMAGE, required: false },
  ],
  outputs: [{ name: 'video', kind: PORT_VIDEO }],
  // Spawned directly upstream when this block is added: the driving video, then the person.
  starterPrereqs: ['videoLoader', 'uploadImageToTmpfiles'],
  // The prompt is fixed; the key holds the text that was sent, so a saved run shows it.
  configKeys: ['provider', 'model', 'prompt', 'params'],
  info: [
    'Put the driving video in the Video Loader.',
    'Put an image of the person to swap in, in the Image Loader.',
    'Wan 3.0 and Seedance 2.5 give the best quality.',
    "Seedance 2 and Kling 4.0 are alternatives; the cost chip shows each model's price.",
  ],
  component: CharacterSwapBlock,
}
