/**
 * Load Character reports the fullest media section it shows (all of the
 * character's files of a kind, selected or not), so the card can narrow while
 * a character has at most two files of each kind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/characters/api', async (orig) => {
  const real = await orig<typeof import('@/lib/characters/api')>()
  return { ...real, listCharacters: vi.fn() }
})

import { blockDef } from '@/components/pipeline/custom_blocks/generated/load_character'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'
import { listCharacters } from '@/lib/characters/api'
import type { Character, CharacterMedia, CharacterMediaKind } from '@/lib/characters/types'
import { blockProps, renderGenerationBlock, stubGenerationFetch } from '@/test-utils/byok-harness'

function media(cid: string, id: string, kind: CharacterMediaKind, position: number): CharacterMedia {
  return { id, kind, label: `${id}.bin`, local: `/outputs/characters/${cid}/${id}.bin`, size_bytes: 10, width: null, height: null, duration_s: null, position, created_at: '' }
}
function character(id: string, name: string, files: CharacterMedia[]): Character {
  return { id, name, description: '', created_at: '', updated_at: '', default_face_id: files[0]?.id ?? null, default_audio_id: null, media: files }
}
const ONE_IMAGE = character('c1', 'One Image', [media('c1', 'i1', 'image', 0)])
const THREE_AUDIO = character('c2', 'Three Audio', [
  media('c2', 'i1', 'image', 0), media('c2', 'a1', 'audio', 0), media('c2', 'a2', 'audio', 1), media('c2', 'a3', 'audio', 2),
])

beforeEach(() => {
  sessionStorage.clear()
  vi.mocked(listCharacters).mockReset().mockResolvedValue([ONE_IMAGE, THREE_AUDIO])
  stubGenerationFetch({ catalog: CATALOG_BOTH })
})
afterEach(() => vi.unstubAllGlobals())

describe('Load Character media count', () => {
  it('reports 0 with no character, then the fullest section of the chosen one', async () => {
    const user = userEvent.setup()
    const setMediaItemCount = vi.fn()
    renderGenerationBlock(blockDef.component, { ...blockProps('lcw'), setMediaItemCount })
    const last = () => setMediaItemCount.mock.calls.at(-1)?.[0]
    expect(last()).toBe(0)

    const pick = async (name: string) => {
      await user.click(await screen.findByRole('combobox', { name: 'Character' }))
      await user.click(screen.getAllByRole('option').find((o) => o.textContent?.includes(name))!)
    }
    await pick('One Image')
    await waitFor(() => expect(last()).toBe(1))
    await pick('Three Audio')
    await waitFor(() => expect(last()).toBe(3))
  })
})
