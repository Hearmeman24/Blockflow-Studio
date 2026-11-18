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

  it('has no accent for a retired kind (voice is audio)', () => {
    expect(kindAccent('voice' as never)).toBeUndefined()
  })
})
