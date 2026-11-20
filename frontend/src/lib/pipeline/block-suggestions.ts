import type { NodeTypeDef } from './registry'

export type BlockSuggestionContext =
  | { kind: 'starter' }
  | { kind: 'upstream'; upstreamType?: string }

export const STARTER_SUGGESTIONS = [
  'textToImage',
  'textToVideo',
  'imageToVideo',
  'imageToImage',
  'omniReferenceToVideo',
  'characterSwap',
  'uploadImageToTmpfiles',
  'videoLoader',
  'omniReferenceLoader',
  'loadCharacter',
  'promptWriter',
  'promptFromTxt',
] as const

export const SUGGESTED_NEXT_BY_TYPE: Record<string, readonly string[]> = {
  uploadImageToTmpfiles: ['imageToVideo', 'imageToImage', 'omniReferenceToVideo', 'imageViewer', 'imageInspector'],

  textToImage: ['imageViewer', 'imageToVideo', 'imageToImage'],
  imageToImage: ['imageViewer', 'imageToVideo', 'imageToImage'],
  textToVideo: ['videoViewer', 'videoFx', 'videoStitcher'],
  imageToVideo: ['videoViewer', 'videoFx', 'videoStitcher'],
  omniReferenceToVideo: ['videoViewer', 'videoFx', 'videoStitcher'],
  characterSwap: ['videoViewer', 'videoFx', 'videoStitcher'],

  videoLoader: ['videoViewer', 'videoFx', 'videoStitcher'],
  omniReferenceLoader: ['omniReferenceToVideo'],
  loadCharacter: ['imageToVideo', 'imageToImage', 'omniReferenceToVideo'],
  videoFx: ['videoStitcher', 'videoViewer'],
  videoStitcher: ['videoFx', 'videoViewer'],

  promptWriter: ['textToVideo', 'textToImage', 'imageToVideo', 'imageToImage', 'omniReferenceToVideo', 'hitl'],
  promptFromTxt: ['textToImage', 'textToVideo', 'hitl'],
  hitl: ['imageViewer', 'videoViewer', 'audioViewer'],
}

export interface SuggestionMapValidationResult {
  unknownTypes: string[]
  duplicateSuggestions: string[]
}

function uniqueInOrder(types: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const type of types) {
    if (seen.has(type)) continue
    seen.add(type)
    result.push(type)
  }
  return result
}

export function getSuggestedTypes(
  validTypes: NodeTypeDef[],
  context?: BlockSuggestionContext,
): string[] {
  if (!context) return []

  const candidates =
    context.kind === 'starter'
      ? STARTER_SUGGESTIONS
      : context.upstreamType
        ? (SUGGESTED_NEXT_BY_TYPE[context.upstreamType] ?? [])
        : []

  if (candidates.length === 0) return []

  const validTypeIds = new Set(validTypes.map((def) => def.type))
  return uniqueInOrder(candidates).filter((type) => validTypeIds.has(type))
}

export function validateSuggestionMap(knownTypes: Set<string>): SuggestionMapValidationResult {
  const unknownTypes = new Set<string>()
  const duplicateSuggestions: string[] = []

  const validateList = (owner: string, suggestions: readonly string[]) => {
    const seen = new Set<string>()
    for (const suggestion of suggestions) {
      if (!knownTypes.has(suggestion)) unknownTypes.add(suggestion)
      if (seen.has(suggestion)) duplicateSuggestions.push(`${owner}:${suggestion}`)
      seen.add(suggestion)
    }
  }

  validateList('starter', STARTER_SUGGESTIONS)

  for (const [owner, suggestions] of Object.entries(SUGGESTED_NEXT_BY_TYPE)) {
    if (!knownTypes.has(owner)) unknownTypes.add(owner)
    validateList(owner, suggestions)
  }

  return {
    unknownTypes: [...unknownTypes].sort(),
    duplicateSuggestions,
  }
}
