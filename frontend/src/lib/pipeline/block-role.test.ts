import { describe, expect, it } from 'vitest'
import '@/components/pipeline/custom_blocks/_register'
import { listBlockDefs, type NodeTypeDef } from './registry'
import { BLOCK_ROLES, blockRole, blockRoleStyle, inferBlockRole } from './block-role'

function def(overrides: Partial<NodeTypeDef>): NodeTypeDef {
  return { type: 'x', label: 'X', description: 'x', size: 'sm', canStart: true, inputs: [], outputs: [], ...overrides }
}

const EXPECTED: Record<string, string> = {
  textToImage: 'image',
  imageToImage: 'image',
  imageViewer: 'image',
  imageInspector: 'image',
  textToVideo: 'video',
  imageToVideo: 'video',
  omniReferenceToVideo: 'video',
  videoFx: 'video',
  videoStitcher: 'video',
  videoViewer: 'video',
  uploadImageToTmpfiles: 'loader',
  videoLoader: 'loader',
  omniReferenceLoader: 'loader',
  loadCharacter: 'loader',
  audioViewer: 'loader',
  hitl: 'loader',
  promptWriter: 'prompt',
  promptFromTxt: 'prompt',
}

describe('block roles', () => {
  it('every shipped block declares its role on its blockDef', () => {
    for (const block of listBlockDefs()) {
      expect(block.role, block.type).toBeDefined()
      expect(BLOCK_ROLES, block.type).toContain(block.role)
    }
  })

  it('maps each shipped block to its role', () => {
    const actual = Object.fromEntries(listBlockDefs().map((block) => [block.type, blockRole(block)]))
    expect(actual).toEqual(EXPECTED)
  })

  it('a declared role wins over the ports', () => {
    expect(blockRole(def({ role: 'prompt', outputs: [{ name: 'video', kind: 'video' }] }))).toBe('prompt')
  })

  it('infers a role from the ports when none is declared', () => {
    // Takes no input and outputs media: a loader, whatever the media.
    expect(inferBlockRole(def({ outputs: [{ name: 'image', kind: 'image' }] }))).toBe('loader')
    expect(inferBlockRole(def({ outputs: [{ name: 'audio', kind: 'audio' }] }))).toBe('loader')
    // Video ports win over image ports, then image, then text.
    expect(inferBlockRole(def({
      inputs: [{ name: 'image', kind: 'image' }],
      outputs: [{ name: 'video', kind: 'video' }],
    }))).toBe('video')
    expect(inferBlockRole(def({ inputs: [{ name: 'image', kind: 'image' }] }))).toBe('image')
    expect(inferBlockRole(def({ outputs: [{ name: 'prompt', kind: 'prompt' }] }))).toBe('prompt')
    expect(inferBlockRole(def({ inputs: [{ name: 'text', kind: 'text' }], outputs: [{ name: 'text', kind: 'text' }] }))).toBe('prompt')
    // Nothing better fits: the utility role.
    expect(inferBlockRole(def({}))).toBe('loader')
    expect(inferBlockRole(def({ inputs: [{ name: 'metadata', kind: 'metadata' }] }))).toBe('loader')
    expect(blockRole(def({ inputs: [{ name: 'video', kind: 'video' }] }))).toBe('video')
  })

  it('gives every role a label, an icon and complete static class strings in its own hue', () => {
    const hue = { image: 'violet', video: 'blue', loader: 'amber', prompt: 'emerald' } as const
    for (const role of BLOCK_ROLES) {
      const style = blockRoleStyle(role)
      expect(style.label.trim()).not.toBe('')
      expect(style.groupLabel.trim()).not.toBe('')
      expect(style.icon).toBeTruthy()
      for (const value of [style.border, style.chip, style.heading]) {
        expect(value).not.toMatch(/\$\{|undefined/)
        for (const token of value.split(' ')) expect(token, `${role}: ${token}`).toContain(hue[role])
      }
    }
  })
})
