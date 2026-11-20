import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PipelineProvider } from '@/lib/pipeline/pipeline-context'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { BlockLayoutProvider } from '@/lib/pipeline/block-layout-context'
import { registerBlockDef, type BlockComponentProps, type BlockDef } from '@/lib/pipeline/registry'
import { useHeaderWarnings } from '@/lib/pipeline/use-header-warnings'
import { BlockCard } from '../block-card'

const INFO = ['Put the first thing in the first loader.', 'Put the second thing in the second loader.']

function WarningStub({ setHeaderWarnings }: BlockComponentProps) {
  useHeaderWarnings(setHeaderWarnings, [{ id: 'w1', message: 'Something to look at.' }])
  return null
}

function stub(type: string, label: string, extra: Partial<BlockDef> = {}): BlockDef {
  return {
    type, label, description: '', size: 'sm', canStart: true, inputs: [], outputs: [],
    component: () => null, ...extra,
  }
}

beforeAll(() => {
  registerBlockDef(stub('info_stub_plain', 'Plain'))
  registerBlockDef(stub('info_stub_with', 'Helpful', { info: INFO }))
  registerBlockDef(stub('info_stub_empty', 'Empty', { info: [] }))
  registerBlockDef(stub('info_stub_warn', 'Warned', { info: INFO, component: WarningStub }))
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

function renderCard(type: string) {
  return render(
    <PipelineTabsProvider>
      <PipelineProvider tabId={`info-${type}`}>
        <BlockLayoutProvider>
          <BlockCard block={{ id: `b-${type}`, type }} displayNumber="1" />
        </BlockLayoutProvider>
      </PipelineProvider>
    </PipelineTabsProvider>,
  )
}

describe('block info button', () => {
  it('is absent when the block declares no info, or an empty list', () => {
    renderCard('info_stub_plain')
    expect(screen.queryByRole('button', { name: /^How to use/ })).toBeNull()
    renderCard('info_stub_empty')
    expect(screen.queryByRole('button', { name: /^How to use/ })).toBeNull()
  })

  it('has an accessible name with the block label and starts closed', () => {
    renderCard('info_stub_with')
    const button = screen.getByRole('button', { name: 'How to use Helpful' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(INFO[0])).toBeNull()
  })

  it('opens on click with every line, and closes on a second click', async () => {
    const user = userEvent.setup()
    renderCard('info_stub_with')
    const button = screen.getByRole('button', { name: 'How to use Helpful' })
    await user.click(button)
    const panel = await screen.findByRole('dialog', { name: 'How to use Helpful' })
    expect(within(panel).getAllByRole('listitem').map((li) => li.textContent)).toEqual(INFO)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    await user.click(button)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'How to use Helpful' })).toBeNull())
  })

  it('opens with Enter from the keyboard, closes with Escape and returns focus to the button', async () => {
    const user = userEvent.setup()
    renderCard('info_stub_with')
    const button = screen.getByRole('button', { name: 'How to use Helpful' })
    button.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('dialog', { name: 'How to use Helpful' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'How to use Helpful' })).toBeNull())
    expect(button).toHaveFocus()
  })

  it('uses the renamed label in its accessible name', async () => {
    render(
      <PipelineTabsProvider>
        <PipelineProvider tabId="info-renamed">
          <BlockLayoutProvider>
            <BlockCard block={{ id: 'b-renamed', type: 'info_stub_with', label: 'My swap' }} displayNumber="1" />
          </BlockLayoutProvider>
        </PipelineProvider>
      </PipelineTabsProvider>,
    )
    expect(screen.getByRole('button', { name: 'How to use My swap' })).toBeInTheDocument()
  })

  it('sits beside the header warning badge; opening the info leaves the warnings in place', async () => {
    const user = userEvent.setup()
    renderCard('info_stub_warn')
    const badge = await screen.findByTestId('warning-badge')
    expect(badge).toHaveAccessibleName('1 warning: Something to look at')
    await user.click(screen.getByRole('button', { name: 'How to use Warned' }))
    const panel = await screen.findByRole('dialog', { name: 'How to use Warned' })
    expect(within(panel).queryByText('Something to look at.')).toBeNull()
    expect(screen.getByTestId('warning-badge')).toHaveAccessibleName('1 warning: Something to look at')
  })
})
