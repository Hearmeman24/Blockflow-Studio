import { describe, expect, it } from 'vitest'
import type { NodeTypeDef } from '@/lib/pipeline/registry'
import type { BlockRole } from '@/lib/pipeline/block-role'
import { getBlockPickerGroups } from './block-picker-groups'

function block(type: string, label = type, role?: BlockRole): NodeTypeDef {
  return {
    type,
    label,
    description: `${label} description`,
    size: 'sm',
    ...(role ? { role } : {}),
    canStart: true,
    inputs: [],
    outputs: [],
  }
}

describe('getBlockPickerGroups', () => {
  it('pins upstream Suggested first, then groups the rest by role: Image, Video, Loaders, Prompts', () => {
    const groups = getBlockPickerGroups(
      [
        block('promptFromTxt', 'Prompt From Txt', 'prompt'),
        block('audioViewer', 'Audio Viewer', 'loader'),
        block('videoLoader', 'Video Loader', 'loader'),
        block('videoViewer', 'Video Viewer', 'video'),
        block('uploadImageToTmpfiles', 'Image Loader', 'loader'),
        block('imageViewer', 'Image Viewer', 'image'),
        block('textToImage', 'Text to Image', 'image'),
      ],
      { kind: 'upstream', upstreamType: 'uploadImageToTmpfiles' },
    )

    expect(groups.map((group) => [group.key, group.label])).toEqual([
      ['suggested', 'Suggested'],
      ['image', 'Image'],
      ['video', 'Video'],
      ['loader', 'Loaders'],
      ['prompt', 'Prompts'],
    ])
    expect(groups[0].items.map((item) => item.def.type)).toEqual(['imageViewer'])
    expect(groups[1].items.map((item) => item.def.type)).toEqual(['textToImage'])
    expect(groups[2].items.map((item) => item.def.type)).toEqual(['videoViewer'])
    expect(groups[3].items.map((item) => item.def.type)).toEqual(['audioViewer', 'videoLoader', 'uploadImageToTmpfiles'])
    expect(groups[4].items.map((item) => item.def.type)).toEqual(['promptFromTxt'])
  })

  it('gives every item its role, and Suggested items keep their own role', () => {
    const groups = getBlockPickerGroups(
      [
        block('uploadImageToTmpfiles', 'Image Loader', 'loader'),
        block('videoLoader', 'Video Loader', 'loader'),
        block('promptFromTxt', 'Prompt From Txt', 'prompt'),
        block('imageViewer', 'Image Viewer', 'image'),
      ],
      { kind: 'starter' },
    )

    expect(groups.map((group) => group.key)).toEqual(['suggested', 'image'])
    expect(groups[0].items.map((item) => [item.def.type, item.role])).toEqual([
      ['uploadImageToTmpfiles', 'loader'],
      ['videoLoader', 'loader'],
      ['promptFromTxt', 'prompt'],
    ])
    expect(groups[1].items.map((item) => [item.def.type, item.role])).toEqual([['imageViewer', 'image']])
  })

  it('keeps non-suggested blocks out of Suggested when no context exists', () => {
    const groups = getBlockPickerGroups([
      block('videoViewer', 'Video Viewer', 'video'),
      block('promptFromTxt', 'Prompt From Txt', 'prompt'),
    ])

    expect(groups.map((group) => group.label)).toEqual(['Video', 'Prompts'])
  })

  it('files loaders under Loaders, not under Image or Video', () => {
    const groups = getBlockPickerGroups([
      block('videoLoader', 'Video Loader', 'loader'),
      block('omniReferenceLoader', 'Omni Reference Loader', 'loader'),
      block('loadCharacter', 'Load Character', 'loader'),
      block('uploadImageToTmpfiles', 'Image Loader', 'loader'),
      block('imageToImage', 'Image to Image', 'image'),
      block('imageToVideo', 'Image to Video', 'video'),
    ])
    expect(groups.map((group) => [group.label, group.items.map((item) => item.def.type)])).toEqual([
      ['Image', ['imageToImage']],
      ['Video', ['imageToVideo']],
      ['Loaders', ['videoLoader', 'omniReferenceLoader', 'loadCharacter', 'uploadImageToTmpfiles']],
    ])
  })

  it('uses the port-based role for blocks that declare none', () => {
    const groups = getBlockPickerGroups([
      { ...block('futureVideoBlock'), inputs: [{ name: 'video', kind: 'video' }], outputs: [{ name: 'video', kind: 'video' }] },
      { ...block('futureImageBlock'), inputs: [{ name: 'image', kind: 'image' }] },
      { ...block('futureAudioLoader'), outputs: [{ name: 'audio', kind: 'audio' }] },
      { ...block('futureTextBlock'), inputs: [{ name: 'text', kind: 'text' }], outputs: [{ name: 'text', kind: 'text' }] },
      block('futureUtility'),
    ])

    expect(groups.map((group) => [group.label, group.items.map((item) => item.def.type)])).toEqual([
      ['Image', ['futureImageBlock']],
      ['Video', ['futureVideoBlock']],
      ['Loaders', ['futureAudioLoader', 'futureUtility']],
      ['Prompts', ['futureTextBlock']],
    ])
  })
})
