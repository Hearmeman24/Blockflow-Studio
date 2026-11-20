/**
 * Decorative accent per media kind: image violet, video blue, audio amber (the block roles in `lib/pipeline/block-role.ts` use the same hues). This is the only
 * place these hues are defined for media; they mark what a thing is, never a
 * state (success, warning, selection use the semantic tokens).
 *
 * Every value is a complete static class string so Tailwind can see it.
 */
import type { CharacterMediaKind } from '@/lib/characters/types'

export interface KindAccent {
  /** Small icon chip next to a section heading: tinted background and icon colour. */
  chip: string
  /** A tinted tile surface (sound tiles, the empty portrait): background and border. */
  tile: string
  /** A dashed Add tile at rest and on hover (works with a ghost Button). */
  add: string
  /** The Add tile while files are dragged over it. */
  addDragging: string
  /** Waveform bars at rest (bars use `bg-current`). */
  wave: string
  /** Waveform bars before the playhead while playing. */
  wavePlayed: string
  /** A mention of a reference of this kind in a prompt: colour and a faint tint only, so the
   *  text keeps the textarea's exact metrics (no weight, size or spacing). The 300 tones
   *  stay well above 7:1 contrast on the dark field. */
  mention: string
}

const ACCENTS: Record<CharacterMediaKind, KindAccent> = {
  image: {
    chip: 'bg-violet-500/15 text-violet-300',
    tile: 'border-violet-400/20 bg-violet-500/[0.07]',
    add: 'border-violet-400/30 text-violet-300/80 hover:border-violet-400/60 hover:bg-violet-500/10 hover:text-violet-200 dark:hover:bg-violet-500/10',
    addDragging: 'border-violet-400 bg-violet-500/15 text-violet-200',
    wave: 'text-violet-300/45',
    wavePlayed: 'text-violet-200',
    mention: 'rounded-sm bg-violet-500/15 text-violet-300',
  },
  video: {
    chip: 'bg-blue-500/15 text-blue-300',
    tile: 'border-blue-400/20 bg-blue-500/[0.07]',
    add: 'border-blue-400/30 text-blue-300/80 hover:border-blue-400/60 hover:bg-blue-500/10 hover:text-blue-200 dark:hover:bg-blue-500/10',
    addDragging: 'border-blue-400 bg-blue-500/15 text-blue-200',
    wave: 'text-blue-300/45',
    wavePlayed: 'text-blue-200',
    mention: 'rounded-sm bg-blue-500/15 text-blue-300',
  },
  audio: {
    chip: 'bg-amber-500/15 text-amber-300',
    tile: 'border-amber-400/20 bg-amber-500/[0.07]',
    add: 'border-amber-400/30 text-amber-300/80 hover:border-amber-400/60 hover:bg-amber-500/10 hover:text-amber-200 dark:hover:bg-amber-500/10',
    addDragging: 'border-amber-400 bg-amber-500/15 text-amber-200',
    wave: 'text-amber-300/45',
    wavePlayed: 'text-amber-200',
    mention: 'rounded-sm bg-amber-500/15 text-amber-300',
  },
}

export function kindAccent(kind: CharacterMediaKind): KindAccent {
  return ACCENTS[kind]
}
