import { describe, expect, it } from 'vitest'
import { PRIVATE_BLOCK_TYPES } from '@/components/pipeline/custom_blocks/_register'
import { NODE_TYPES, type NodeTypeDef } from './registry'
import {
  STARTER_SUGGESTIONS,
  SUGGESTED_NEXT_BY_TYPE,
  getSuggestedTypes,
  validateSuggestionMap,
} from './block-suggestions'

function block(type: string, canStart = true): NodeTypeDef {
  return {
    type,
    label: type,
    description: `${type} description`,
    size: 'sm',
    canStart,
    inputs: [],
    outputs: [],
  }
}

describe('block suggestions', () => {
  it('returns ordered starter suggestions filtered to valid starter defs', () => {
    const validTypes = [
      block('videoViewer'),
      block('promptFromTxt'),
      block('uploadImageToTmpfiles'),
      block('videoLoader'),
    ]

    expect(getSuggestedTypes(validTypes, { kind: 'starter' })).toEqual([
      'uploadImageToTmpfiles',
      'videoLoader',
      'promptFromTxt',
    ])
  })

  it('suggests the generation blocks first when starting a pipeline', () => {
    const validTypes = ['promptFromTxt', 'textToImage', 'omniReferenceToVideo', 'textToVideo', 'imageToVideo', 'imageToImage']
      .map((type) => block(type))
    expect(getSuggestedTypes(validTypes, { kind: 'starter' })).toEqual([
      'textToImage', 'textToVideo', 'imageToVideo', 'imageToImage', 'omniReferenceToVideo', 'promptFromTxt',
    ])
  })

  it('suggests generation blocks after loaders and viewers after generation blocks', () => {
    const validTypes = ['imageToVideo', 'imageToImage', 'omniReferenceToVideo', 'imageViewer', 'videoViewer'].map((type) => block(type))
    expect(getSuggestedTypes(validTypes, { kind: 'upstream', upstreamType: 'uploadImageToTmpfiles' })).toEqual([
      'imageToVideo', 'imageToImage', 'omniReferenceToVideo', 'imageViewer',
    ])
    expect(getSuggestedTypes(validTypes, { kind: 'upstream', upstreamType: 'textToImage' })).toEqual([
      'imageViewer', 'imageToVideo', 'imageToImage',
    ])
    expect(getSuggestedTypes(validTypes, { kind: 'upstream', upstreamType: 'omniReferenceToVideo' })).toEqual(['videoViewer'])
  })

  it('suggests Load Character as a starter and the reference-taking generation blocks after it', () => {
    const validTypes = ['loadCharacter', 'imageToVideo', 'imageToImage', 'omniReferenceToVideo', 'textToVideo'].map((type) => block(type))
    expect(getSuggestedTypes(validTypes, { kind: 'starter' })).toContain('loadCharacter')
    expect(getSuggestedTypes(validTypes, { kind: 'upstream', upstreamType: 'loadCharacter' })).toEqual([
      'imageToVideo', 'imageToImage', 'omniReferenceToVideo',
    ])
  })

  it('suggests the Prompt Writer as a starter and the text-prompted generation blocks after it', () => {
    const validTypes = ['promptWriter', 'textToVideo', 'textToImage', 'imageToVideo', 'imageToImage', 'omniReferenceToVideo', 'hitl']
      .map((type) => block(type))
    expect(getSuggestedTypes(validTypes, { kind: 'starter' })).toContain('promptWriter')
    expect(getSuggestedTypes(validTypes, { kind: 'upstream', upstreamType: 'promptWriter' })).toEqual([
      'textToVideo', 'textToImage', 'imageToVideo', 'imageToImage', 'omniReferenceToVideo', 'hitl',
    ])
  })

  it('returns ordered downstream suggestions for video contexts', () => {
    const validTypes = [
      block('videoViewer'),
      block('videoFx'),
      block('videoStitcher'),
    ]

    expect(getSuggestedTypes(validTypes, { kind: 'upstream', upstreamType: 'videoLoader' })).toEqual([
      'videoViewer',
      'videoFx',
      'videoStitcher',
    ])

    expect(getSuggestedTypes(validTypes, { kind: 'upstream', upstreamType: 'videoFx' })).toEqual([
      'videoStitcher',
      'videoViewer',
    ])
  })

  it('returns nothing for an upstream type that is no longer registered', () => {
    expect(getSuggestedTypes([block('videoViewer')], { kind: 'upstream', upstreamType: 'removedBlock' })).toEqual([])
  })

  it('never suggests a block that is not in the valid type list', () => {
    const validTypes = [block('videoViewer')]

    expect(getSuggestedTypes(validTypes, { kind: 'upstream', upstreamType: 'videoLoader' })).toEqual([
      'videoViewer',
    ])
  })

  it('validates map references and duplicate suggestions', () => {
    // Every suggestion must reference a block that is actually registered.
    const known = new Set(Object.keys(NODE_TYPES))
    const result = validateSuggestionMap(known)

    expect(result).toEqual({ unknownTypes: [], duplicateSuggestions: [] })
  })

  it('keeps exported maps readable and non-empty', () => {
    expect(STARTER_SUGGESTIONS.length).toBeGreaterThan(0)
    expect(Object.keys(SUGGESTED_NEXT_BY_TYPE)).toContain('videoLoader')
  })

  it('covers every registered block as a suggestion source or target', () => {
    const suggestedSurface = new Set<string>([
      ...STARTER_SUGGESTIONS,
      ...Object.keys(SUGGESTED_NEXT_BY_TYPE),
      ...Object.values(SUGGESTED_NEXT_BY_TYPE).flat(),
    ])

    // Private blocks (private_blocks/, gitignored) can't appear in this committed
    // map, so they're out of scope for the coverage check.
    const isPrivate = new Set(PRIVATE_BLOCK_TYPES)
    const missing = Object.keys(NODE_TYPES)
      .filter((type) => !suggestedSurface.has(type) && !isPrivate.has(type))
      .sort()

    expect(missing).toEqual([])
  })
})
