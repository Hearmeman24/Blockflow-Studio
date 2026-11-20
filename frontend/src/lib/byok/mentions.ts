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

/** The text that refers to the n-th reference of a kind (1-based) for this mode: "@image_1", "Video1". */
export function mentionText(spec: ModeSpec | null | undefined, kind: MediaKind, n: number): string {
  return fill((spec?.mentions ?? PLAIN)[kind], n)
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

/** A mention to find in a prompt, and the kind of the reference it names. */
export interface MentionTarget {
  text: string
  kind: MediaKind
}

/** One run of a prompt: plain text (`kind` null) or a mention of an attached reference. */
export interface MentionSegment {
  text: string
  kind: MediaKind | null
}

const WORD_CHAR = /[\p{L}\p{N}_]/u

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/**
 * Split a prompt into plain text and mentions of the given references, for
 * colouring. Only whole mentions count: where a mention starts or ends with a
 * letter, digit or underscore, the character beyond that edge must not be one
 * ("Image1" is not found in "Image10" or "MyImage1"; "@image_1" not in
 * "@image_12"). The longer of two overlapping mentions wins. Case-sensitive,
 * like the providers' syntax. One regular-expression pass over literal
 * alternatives: linear in the prompt length. The segments joined give back
 * the prompt.
 */
export function mentionSegments(value: string, mentions: readonly MentionTarget[]): MentionSegment[] {
  if (!value) return []
  const kinds = new Map<string, MediaKind>()
  for (const m of mentions) if (m.text && !kinds.has(m.text)) kinds.set(m.text, m.kind)
  if (kinds.size === 0) return [{ text: value, kind: null }]
  const alternatives = [...kinds.keys()]
    .sort((a, b) => b.length - a.length)
    .map((text) => {
      const chars = Array.from(text)
      const before = WORD_CHAR.test(chars[0]) ? '(?<![\\p{L}\\p{N}_])' : ''
      const after = WORD_CHAR.test(chars[chars.length - 1]) ? '(?![\\p{L}\\p{N}_])' : ''
      return `${before}${escapeRegExp(text)}${after}`
    })
  const pattern = new RegExp(alternatives.join('|'), 'gu')
  const out: MentionSegment[] = []
  let last = 0
  for (const match of value.matchAll(pattern)) {
    const start = match.index
    if (start > last) out.push({ text: value.slice(last, start), kind: null })
    out.push({ text: match[0], kind: kinds.get(match[0]) ?? null })
    last = start + match[0].length
  }
  if (last < value.length) out.push({ text: value.slice(last), kind: null })
  return out
}
