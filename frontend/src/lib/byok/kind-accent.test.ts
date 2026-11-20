import { describe, expect, it } from 'vitest'
import { kindAccent } from './kind-accent'

describe('kindAccent', () => {
  it('gives each media kind its own hue: image violet, video blue, audio amber', () => {
    const hue = { image: 'violet', video: 'blue', audio: 'amber' } as const
    for (const [kind, name] of Object.entries(hue) as Array<[keyof typeof hue, string]>) {
      const accent = kindAccent(kind)
      for (const value of Object.values(accent)) {
        expect(value).toMatch(new RegExp(`\\b[a-z:-]*${name}-\\d`))
        for (const other of Object.values(hue)) if (other !== name) expect(value).not.toContain(`${other}-`)
      }
    }
  })

  it('uses only complete static class names Tailwind can see (no interpolation leftovers)', () => {
    for (const kind of ['image', 'video', 'audio'] as const) {
      for (const value of Object.values(kindAccent(kind))) {
        expect(value).not.toMatch(/\$\{|undefined|null/)
        expect(value.trim()).toBe(value)
      }
    }
  })

  it('colours mentions in a prompt with a light text tone readable on the dark field', () => {
    expect(kindAccent('image').mention).toMatch(/\btext-violet-(200|300)\b/)
    expect(kindAccent('video').mention).toMatch(/\btext-blue-(200|300)\b/)
    expect(kindAccent('audio').mention).toMatch(/\btext-amber-(200|300)\b/)
    // Colour only: a different weight or size would move the text off the caret.
    for (const kind of ['image', 'video', 'audio'] as const) {
      expect(kindAccent(kind).mention).not.toMatch(/\b(font-|text-(xs|sm|base|lg)|p[xytrbl]?-|m[xytrbl]?-|tracking-|leading-)/)
    }
  })

  it('has no accent for a retired kind (voice is audio)', () => {
    expect(kindAccent('voice' as never)).toBeUndefined()
  })
})
