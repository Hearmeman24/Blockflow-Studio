'use client'

import { PROMPT_OUTPUT_PORT, PromptWriterBlock } from '@/components/prompt-writer/prompt-writer-block'
import { WRITER_CONFIG_KEYS } from '@/lib/prompt-writer/config'
import { PORT_AUDIO, PORT_IMAGE, PORT_TEXT, PORT_VIDEO, type BlockDef } from '@/lib/pipeline/registry'

// `promptWriter`, the `prompt` output and the `local_settings` / `user_prompt`
// / `output` config keys are unchanged from the pre-fork block, so flows saved
// before the fork restore it (see lib/prompt-writer/config.ts for the mapping).
// The optional media inputs and `send_media` (lib/prompt-writer/media.ts) were
// added later; a flow without `send_media` loads with every box unticked.
export const blockDef: BlockDef = {
  type: 'promptWriter',
  label: 'Prompt Writer',
  description: 'Turn a short idea into a full image or video prompt with OpenRouter, Ollama or LM Studio.',
  size: 'lg',
  role: 'prompt',
  canStart: true,
  suggestedDownstream: ['textToVideo', 'textToImage', 'imageToVideo', 'imageToImage', 'omniReferenceToVideo', 'hitl'],
  // Media the user can tick to send to the model; all optional, so the block still starts a pipeline.
  inputs: [
    { name: 'image', kind: PORT_IMAGE, required: false },
    { name: 'video', kind: PORT_VIDEO, required: false },
    { name: 'audio', kind: PORT_AUDIO, required: false },
  ],
  outputs: [{ name: PROMPT_OUTPUT_PORT, kind: PORT_TEXT }],
  configKeys: [...WRITER_CONFIG_KEYS],
  // The block writes its result here while it runs; a saved run reads it after the run.
  resultConfigKeys: ['output'],
  component: PromptWriterBlock,
}
