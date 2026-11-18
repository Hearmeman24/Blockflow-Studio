/**
 * Artifacts filters: which sources and media types to show, favourites only,
 * and whether runs without output are hidden (`hidePartial`: partial or failed
 * runs with nothing generated; one whose generation finished is always shown). The URL is the source of
 * truth (`source`, `kind`, `character`, `fav`, `hide_partial`; the
 * single-value form of older links still reads). Within the source and type
 * groups, ticking none or all means no filter. Characters are an open list
 * (ids, `character=<id>,<id>`): any ticked one is a filter. Hiding runs without output is the default, so
 * only showing them counts as an active filter.
 */

export const SOURCES = ['pipeline', 'mcp'] as const
export const KINDS = ['image', 'video', 'other'] as const
export type SourceValue = (typeof SOURCES)[number]
export type KindValue = (typeof KINDS)[number]

export interface ArtifactFilters {
  sources: SourceValue[]
  kinds: KindValue[]
  /** Character ids; a run matches when it used any of them. */
  characters: string[]
  favorites: boolean
  /** Hide partial or failed runs that generated nothing; the URL and API name is `hide_partial`. */
  hidePartial: boolean
}

export const DEFAULT_FILTERS: ArtifactFilters = { sources: [], kinds: [], characters: [], favorites: false, hidePartial: true }

export const SOURCE_LABELS: Record<SourceValue, string> = { pipeline: 'Pipeline', mcp: 'MCP' }
export const KIND_LABELS: Record<KindValue, string> = { image: 'Image', video: 'Video', other: 'Other' }

/** A change to one filter. */
export type FilterToggle =
  | { group: 'sources'; value: SourceValue }
  | { group: 'kinds'; value: KindValue }
  | { group: 'characters'; value: string }
  | { group: 'favorites' }
  | { group: 'hidePartial' }

export interface ActiveFilter {
  key: string
  label: string
  toggle: FilterToggle
}

function pick<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  const given = new Set((raw ?? '').split(',').map((v) => v.trim()))
  return allowed.filter((v) => given.has(v))
}

const CHARACTER_ID = /^char_[0-9a-f]{32}$/

/** Valid character ids from a comma list, de-duplicated, in the order given. */
function pickCharacters(raw: string | null): string[] {
  const ids = (raw ?? '').split(',').map((v) => v.trim()).filter((v) => CHARACTER_ID.test(v))
  return [...new Set(ids)]
}

/** A group is a filter only when some, not all, of its values are ticked. */
function narrows(values: readonly string[], all: readonly string[]): boolean {
  return values.length > 0 && values.length < all.length
}

export function filtersFromParams(params: URLSearchParams): ArtifactFilters {
  return {
    sources: pick(params.get('source'), SOURCES),
    kinds: pick(params.get('kind'), KINDS),
    characters: pickCharacters(params.get('character')),
    favorites: params.get('fav') === '1',
    hidePartial: params.get('hide_partial') !== '0',
  }
}

/** Writes the filters into `params`, leaving out what equals the defaults. */
export function filtersToParams(params: URLSearchParams, filters: ArtifactFilters): void {
  const set = (key: string, value: string | null) => (value ? params.set(key, value) : params.delete(key))
  set('source', filters.sources.join(',') || null)
  set('kind', filters.kinds.join(',') || null)
  set('character', filters.characters.join(',') || null)
  set('fav', filters.favorites ? '1' : null)
  set('hide_partial', filters.hidePartial ? null : '0')
}

/** The runs request: comma lists, or null when a group does not narrow anything. */
export function requestFilters(filters: ArtifactFilters): { source: string | null; mediaKind: string | null; character: string | null; favorited: boolean; hidePartial: boolean } {
  return {
    source: narrows(filters.sources, SOURCES) ? filters.sources.join(',') : null,
    mediaKind: narrows(filters.kinds, KINDS) ? filters.kinds.join(',') : null,
    character: filters.characters.join(',') || null,
    favorited: filters.favorites,
    hidePartial: filters.hidePartial,
  }
}

export function activeFilters(filters: ArtifactFilters): ActiveFilter[] {
  const out: ActiveFilter[] = []
  if (narrows(filters.sources, SOURCES)) {
    for (const value of filters.sources) out.push({ key: `source-${value}`, label: SOURCE_LABELS[value], toggle: { group: 'sources', value } })
  }
  if (narrows(filters.kinds, KINDS)) {
    for (const value of filters.kinds) out.push({ key: `kind-${value}`, label: KIND_LABELS[value], toggle: { group: 'kinds', value } })
  }
  for (const id of filters.characters) out.push({ key: `character-${id}`, label: 'Character', toggle: { group: 'characters', value: id } })
  if (filters.favorites) out.push({ key: 'favorites', label: 'Favorites', toggle: { group: 'favorites' } })
  if (!filters.hidePartial) out.push({ key: 'partial', label: 'Showing runs without output', toggle: { group: 'hidePartial' } })
  return out
}

function flip<T extends string>(values: readonly T[], value: T, order: readonly T[]): T[] {
  const next = values.includes(value) ? values.filter((v) => v !== value) : [...values, value]
  return order.filter((v) => next.includes(v))
}

export function toggleFilter(filters: ArtifactFilters, change: FilterToggle): ArtifactFilters {
  switch (change.group) {
    case 'sources': return { ...filters, sources: flip(filters.sources, change.value, SOURCES) }
    case 'kinds': return { ...filters, kinds: flip(filters.kinds, change.value, KINDS) }
    case 'characters': return { ...filters, characters: filters.characters.includes(change.value) ? filters.characters.filter((v) => v !== change.value) : [...filters.characters, change.value] }
    case 'favorites': return { ...filters, favorites: !filters.favorites }
    case 'hidePartial': return { ...filters, hidePartial: !filters.hidePartial }
  }
}

/** Removes one active filter (a chip's ✕): back to that filter's default. */
export function removeFilter(filters: ArtifactFilters, active: ActiveFilter): ArtifactFilters {
  return toggleFilter(filters, active.toggle)
}
