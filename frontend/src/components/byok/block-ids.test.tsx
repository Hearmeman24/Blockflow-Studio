/** Two generation blocks on one canvas must not share ids: a label focuses its own block's field. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'
import { blockProps, stubGenerationFetch } from '@/test-utils/byok-harness'
import { GenerationBlockShell, type GenerationBlockConfig } from './generation-block-shell'

const T2I: GenerationBlockConfig = { mode: 'text_to_image', output: 'image', referenceKinds: [] }
const OMNI: GenerationBlockConfig = { mode: 'omni_reference_to_video', output: 'video', referenceKinds: ['video', 'image', 'audio'] }

beforeEach(() => sessionStorage.clear())
afterEach(() => vi.unstubAllGlobals())

function Pair({ a, b }: { a: GenerationBlockConfig; b: GenerationBlockConfig }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <GenerationBlockShell {...blockProps('first')} config={a} pollIntervalMs={1} />
      <GenerationBlockShell {...blockProps('second')} config={b} pollIntervalMs={1} />
    </SWRConfig>
  )
}

function duplicateIds(): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const el of document.querySelectorAll('[id]')) {
    if (seen.has(el.id)) dupes.add(el.id)
    seen.add(el.id)
  }
  return [...dupes]
}

describe.each([
  ['two blocks of one mode', T2I, T2I],
  ['two blocks sharing a mode with another type', OMNI, OMNI],
])('%s', (_name, a, b) => {
  it('has no duplicate ids and each prompt label focuses its own textarea', async () => {
    stubGenerationFetch({ catalog: CATALOG_BOTH })
    render(<Pair a={a} b={b} />)
    await waitFor(() => expect(document.querySelectorAll('textarea')).toHaveLength(2))
    const areas = [...document.querySelectorAll('textarea')]
    expect(duplicateIds()).toEqual([])
    const labels = screen.getAllByText(/^Generation Prompt/)
    const user = userEvent.setup()
    await user.click(labels[1])
    expect(areas[1]).toHaveFocus()
    await user.click(labels[0])
    expect(areas[0]).toHaveFocus()
    for (const id of areas.map((el) => el.id)) expect(id).toMatch(/^\S+$/)
  })
})
