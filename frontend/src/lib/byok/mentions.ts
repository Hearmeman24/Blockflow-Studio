/**
 * Reference badges above the prompt: one per reference the block receives,
 * and the text a badge inserts. The syntax comes from the ledger's
 * `mentions` for the selected provider, model and mode; without one the
 * fallback form ("Image1") is used, as the ledger does for undocumented models.
 */
import type { GenerationReference } from './references'
import type { MediaKind, MentionSpec, ModeSpec } from './types'

const PLAIN: MentionSpec = {
  image: 'Image{n}',
  video: 'Video{n}',
  audio: 'Audio{n}',
  first_frame: null,
  last_frame: null,
  documented: false,
}

const ORDER: readonly MediaKind[] = ['image', 'video', 'audio']
const LABEL: Record<MediaKind, string> = { image: 'Image', video: 'Video', audio: 'Audio' }

export interface ReferenceBadge {
  key: string
  kind: MediaKind
  /** Shown on the chip: "Image 1", "First frame", "Audio 1"; "Mia · Audio 1" for a character's file. */
  label: string
  /** Inserted into the prompt. */
  text: string
  /** Preview source for images and videos. */
  thumbnail?: string
}

/** Longest character name shown on a badge, in code points: the chip does not wrap. */
const CHARACTER_LABEL_MAX = 20

function shortName(name: string): string {
  const chars = Array.from(name)
  return chars.length > CHARACTER_LABEL_MAX ? `${chars.slice(0, CHARACTER_LABEL_MAX).join('').trimEnd()}…` : name
}

function fill(template: string, n: number): string {
  return template.replaceAll('{n}', String(n))
}

export function referenceBadges(spec: ModeSpec | null | undefined, refs: readonly GenerationReference[]): ReferenceBadge[] {
  const mentions = spec?.mentions ?? PLAIN
  const out: ReferenceBadge[] = []
  for (const kind of ORDER) {
    refs.filter((r) => r.kind === kind).forEach((ref, i) => {
      const n = i + 1
      const role = ref.role === 'first_frame' || ref.role === 'last_frame' ? ref.role : null
      const byRole = role ? mentions[role] : null
      let label: string
      let text: string
      if (byRole) {
        label = role === 'first_frame' ? 'First frame' : 'Last frame'
        text = byRole
      } else {
        label = `${LABEL[kind]} ${n}`
        text = fill(mentions[kind], n)
      }
      // A character's file says whose it is.
      const character = (ref.character ?? '').trim()
      if (character) label = `${shortName(character)} · ${label}`
      out.push({
        key: `${kind}:${n}:${ref.id}`,
        kind,
        label,
        text,
        ...(kind === 'image' || kind === 'video' ? { thumbnail: ref.local ?? ref.url } : {}),
      })
    })
  }
  return out
}

/**
 * Insert `text` into `value`, replacing [start, end). Adds a space on either
 * side only where the neighbouring character is not already whitespace. When
 * the prompt was never focused, the text is appended instead.
 */
export function insertMention(value: string, start: number, end: number, text: string, focused: boolean): { value: string; caret: number } {
  const from = focused ? Math.max(0, Math.min(start, value.length)) : value.length
  const to = focused ? Math.max(from, Math.min(end, value.length)) : value.length
  const before = value.slice(0, from)
  const after = value.slice(to)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^\s/.test(after) ? ' ' : ''
  const next = `${before}${lead}${text}${trail}${after}`
  return { value: next, caret: before.length + lead.length + text.length }
}
