'use client'

/**
 * Load Character: one saved character's images, videos and audio as
 * references, chosen file by file. Behaves like the loaders (limits from the
 * downstream block, flags, health, run blockers), except that a kind the
 * downstream model does not take is simply not sent. Files are managed on the
 * Characters page. Logic in `components/characters/use-load-character.ts`.
 */
import { LoadCharacterBlock } from '@/components/characters/load-character-block'
import { LOAD_CHARACTER_KEYS } from '@/lib/characters/load-character'
import { PORT_AUDIO, PORT_IMAGE, PORT_VIDEO, type BlockDef } from '@/lib/pipeline/registry'

export const blockDef: BlockDef = {
  type: 'loadCharacter',
  label: 'Load Character',
  description: "Use a saved character's images, videos and audio as references, chosen file by file.",
  size: 'huge',
  role: 'loader',
  canStart: true,
  suggestedDownstream: ['imageToVideo', 'imageToImage', 'omniReferenceToVideo'],
  satisfiesPrereqs: ['uploadImageToTmpfiles', 'omniReferenceLoader', 'videoLoader'],
  inputs: [],
  outputs: [
    { name: 'image', kind: PORT_IMAGE },
    { name: 'video', kind: PORT_VIDEO },
    { name: 'audio', kind: PORT_AUDIO },
  ],
  configKeys: [LOAD_CHARACTER_KEYS.characterId, LOAD_CHARACTER_KEYS.selection, LOAD_CHARACTER_KEYS.snapshot],
  component: LoadCharacterBlock,
}
