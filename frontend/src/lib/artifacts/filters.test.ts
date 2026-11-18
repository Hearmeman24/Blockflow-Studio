import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FILTERS, activeFilters, filtersFromParams, filtersToParams, removeFilter, requestFilters, toggleFilter,
  type ArtifactFilters,
} from './filters'

const params = (s: string) => new URLSearchParams(s)
const f = (over: Partial<ArtifactFilters> = {}): ArtifactFilters => ({ ...DEFAULT_FILTERS, ...over })

describe('filtersFromParams', () => {
  it('reads a fresh URL as the defaults (hide partial on)', () => {
    expect(filtersFromParams(params(''))).toEqual(DEFAULT_FILTERS)
    expect(DEFAULT_FILTERS).toEqual({ sources: [], kinds: [], characters: [], favorites: false, hidePartial: true })
  })

  it('reads the legacy single-value params', () => {
    expect(filtersFromParams(params('source=mcp&kind=video&fav=1&hide_partial=0'))).toEqual({
      sources: ['mcp'], kinds: ['video'], characters: [], favorites: true, hidePartial: false,
    })
  })

  it('reads comma lists, drops unknown values and keeps a stable order', () => {
    expect(filtersFromParams(params('source=mcp,pipeline&kind=other,dataset,image'))).toEqual(f({
      sources: ['pipeline', 'mcp'], kinds: ['image', 'other'],
    }))
  })
})

describe('filtersToParams', () => {
  it('writes only what differs from the defaults, and round-trips', () => {
    const p = new URLSearchParams('q=fox&page=3')
    filtersToParams(p, f({ sources: ['mcp'], kinds: ['image', 'video'], favorites: true, hidePartial: false }))
    expect(p.get('source')).toBe('mcp')
    expect(p.get('kind')).toBe('image,video')
    expect(p.get('fav')).toBe('1')
    expect(p.get('hide_partial')).toBe('0')
    expect(p.get('q')).toBe('fox')
    expect(filtersFromParams(p)).toEqual(f({ sources: ['mcp'], kinds: ['image', 'video'], favorites: true, hidePartial: false }))
    filtersToParams(p, DEFAULT_FILTERS)
    expect(p.toString()).toBe('q=fox&page=3')
  })
})

describe('requestFilters', () => {
  it('sends a subset, and nothing for none or all of a group', () => {
    expect(requestFilters(f())).toEqual({ source: null, mediaKind: null, character: null, favorited: false, hidePartial: true })
    expect(requestFilters(f({ sources: ['mcp'], kinds: ['image', 'video'] }))).toMatchObject({ source: 'mcp', mediaKind: 'image,video' })
    expect(requestFilters(f({ sources: ['pipeline', 'mcp'], kinds: ['image', 'video', 'other'] }))).toMatchObject({ source: null, mediaKind: null })
  })
})

describe('activeFilters', () => {
  it('lists only non-default filters; none or all of a group is not a filter', () => {
    expect(activeFilters(f())).toEqual([])
    expect(activeFilters(f({ sources: ['pipeline', 'mcp'], kinds: ['image', 'video', 'other'] }))).toEqual([])
    expect(activeFilters(f({ sources: ['mcp'], kinds: ['video'], favorites: true, hidePartial: false })).map((a) => a.label))
      .toEqual(['MCP', 'Video', 'Favorites', 'Showing runs without output'])
  })
})

describe('toggleFilter / removeFilter', () => {
  it('toggles group values and the two switches', () => {
    let s = toggleFilter(f(), { group: 'kinds', value: 'video' })
    expect(s.kinds).toEqual(['video'])
    s = toggleFilter(s, { group: 'kinds', value: 'image' })
    expect(s.kinds).toEqual(['image', 'video'])
    s = toggleFilter(s, { group: 'kinds', value: 'video' })
    expect(s.kinds).toEqual(['image'])
    expect(toggleFilter(f(), { group: 'favorites' }).favorites).toBe(true)
    expect(toggleFilter(f(), { group: 'hidePartial' }).hidePartial).toBe(false)
  })

  it('removes a single active filter, back to its default', () => {
    const s = f({ sources: ['mcp'], kinds: ['image', 'video'], favorites: true, hidePartial: false })
    const [mcp, image, , fav, partial] = activeFilters(s)
    expect(removeFilter(s, mcp).sources).toEqual([])
    expect(removeFilter(s, image).kinds).toEqual(['video'])
    expect(removeFilter(s, fav).favorites).toBe(false)
    expect(removeFilter(s, partial).hidePartial).toBe(true)
  })
})

const A = `char_${'a'.repeat(32)}`
const B = `char_${'0123456789abcdef'.repeat(2)}`

describe('character filter', () => {
  it('reads valid ids in order, drops malformed ones and duplicates', () => {
    const raw = `${B},nope,char_XYZ,${A},${B},char_${'a'.repeat(31)},char_${'A'.repeat(32)},,`
    expect(filtersFromParams(params(`character=${raw}`)).characters).toEqual([B, A])
    expect(filtersFromParams(params('character=')).characters).toEqual([])
    expect(filtersFromParams(params('')).characters).toEqual([])
    expect(filtersFromParams(params(`character=${A}`)).characters).toEqual([A])
  })

  it('writes the param only when ticked, leaves other params alone, and round-trips', () => {
    const p = new URLSearchParams('q=fox&page=2&source=mcp')
    filtersToParams(p, f({ sources: ['mcp'], characters: [B, A] }))
    expect(p.get('character')).toBe(`${B},${A}`)
    expect(p.get('q')).toBe('fox')
    expect(p.get('source')).toBe('mcp')
    expect(filtersFromParams(p).characters).toEqual([B, A])
    filtersToParams(p, f({ sources: ['mcp'] }))
    expect(p.has('character')).toBe(false)
    expect(p.toString()).toBe('q=fox&page=2&source=mcp')
  })

  it('sends the ticked ids to the runs request, or null for none', () => {
    expect(requestFilters(f({ characters: [A, B] })).character).toBe(`${A},${B}`)
    expect(requestFilters(f()).character).toBeNull()
  })

  it('every ticked character is an active filter, however many exist', () => {
    const active = activeFilters(f({ sources: ['mcp'], characters: [A, B] }))
    expect(active.map((a) => a.toggle)).toEqual([
      { group: 'sources', value: 'mcp' }, { group: 'characters', value: A }, { group: 'characters', value: B },
    ])
    expect(activeFilters(f())).toEqual([])
  })

  it('toggles an id on (appended) and off, leaving the other groups alone', () => {
    let s = toggleFilter(f({ kinds: ['image'] }), { group: 'characters', value: B })
    s = toggleFilter(s, { group: 'characters', value: A })
    expect(s).toEqual(f({ kinds: ['image'], characters: [B, A] }))
    expect(toggleFilter(s, { group: 'characters', value: B }).characters).toEqual([A])
  })

  it('removes one character chip, and clearing to the defaults removes them all', () => {
    const s = f({ characters: [A, B], favorites: true })
    const chip = activeFilters(s).find((a) => a.toggle.group === 'characters' && a.toggle.value === A)!
    expect(removeFilter(s, chip).characters).toEqual([B])
    const p = new URLSearchParams(`character=${A}`)
    filtersToParams(p, DEFAULT_FILTERS)
    expect(p.toString()).toBe('')
  })
})
