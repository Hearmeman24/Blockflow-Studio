import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'
import { getModeSpec } from '@/lib/byok/catalog'
import { EMPTY_PARAMS, reconcileParams, type ParamState } from '@/lib/byok/params'
import type { GenerationMode } from '@/lib/byok/types'
import { GenerationSettings } from './generation-settings'

const spec = (provider: string, model: string, mode: GenerationMode, settings = {}) =>
  getModeSpec(CATALOG_BOTH, provider, model, mode, settings)!

const empty = (): ParamState => ({ ...EMPTY_PARAMS, settings: {} })
const toolbar = () => screen.getByRole('toolbar', { name: 'Settings' })

describe('GenerationSettings chip row', () => {
  it('renders one compact row with a chip per ledger setting and no label rows or helper paragraphs', () => {
    const s = spec('kie', 'seedance-2', 'text_to_video')
    const { container } = render(<GenerationSettings spec={s} params={empty()} onChange={vi.fn()} />)
    const chips = within(toolbar())
    expect(chips.getByRole('group', { name: 'Duration: 5 seconds' })).toBeInTheDocument()
    expect(chips.getByRole('button', { name: 'Resolution: 720p' })).toBeInTheDocument()
    expect(chips.getByRole('button', { name: 'Aspect ratio: 16:9' })).toBeInTheDocument()
    for (const setting of s.settings) {
      expect(chips.getByRole('button', { name: new RegExp(`^${setting.label}: `) })).toBeInTheDocument()
    }
    expect(toolbar()).toHaveClass('flex', 'flex-wrap')
    expect(container.querySelectorAll('p')).toHaveLength(0)
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('toggles a boolean in one click with aria-pressed and a visible state change', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const s = spec('kie', 'seedance-2', 'text_to_video')
    const { rerender } = render(<GenerationSettings spec={s} params={empty()} onChange={onChange} />)
    const chip = screen.getByRole('button', { name: 'Kie content filter: off' })
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    expect(chip).toHaveTextContent('Content filter')
    const offClass = chip.className
    await user.click(chip)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ settings: { nsfw_checker: true } }))
    rerender(<GenerationSettings spec={s} params={{ ...empty(), settings: { nsfw_checker: true } }} onChange={onChange} />)
    const on = screen.getByRole('button', { name: 'Kie content filter: on' })
    expect(on).toHaveAttribute('aria-pressed', 'true')
    expect(on.className).not.toEqual(offClass)
  })

  it('changes an enum through its menu', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<GenerationSettings spec={spec('kie', 'seedance-2', 'text_to_video')} params={empty()} onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Aspect ratio: 16:9' }))
    await user.click(await screen.findByRole('menuitemradio', { name: '9:16' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ aspect_ratio: '9:16' }))
  })

  it('opens enum menus from the keyboard', async () => {
    const user = userEvent.setup()
    render(<GenerationSettings spec={spec('kie', 'gpt-image-2.6', 'text_to_image', {})} params={empty()} onChange={vi.fn()} />)
    screen.getByRole('button', { name: 'Quality: medium' }).focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('menuitemradio', { name: 'high' })).toBeInTheDocument()
  })

  it('steps the duration within the ledger range and offers the automatic value', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const s = spec('kie', 'seedance-2', 'text_to_video')
    const { rerender } = render(<GenerationSettings spec={s} params={{ ...empty(), duration: 15 }} onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'Longer' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Shorter' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ duration: 14 }))
    rerender(<GenerationSettings spec={s} params={{ ...empty(), duration: 4 }} onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'Shorter' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Let the model choose the duration: off' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ duration: -1 }))
    rerender(<GenerationSettings spec={s} params={{ ...empty(), duration: -1 }} onChange={onChange} />)
    expect(screen.getByTestId('duration-value')).toHaveTextContent('Auto')
  })

  it('has no automatic duration where the ledger has none', () => {
    render(<GenerationSettings spec={spec('piapi', 'seedance-2', 'text_to_video')} params={empty()} onChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Let the model choose the duration/ })).toBeNull()
  })

  it('edits a number in a small popover', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<GenerationSettings spec={spec('kie', 'wan-3.0', 'text_to_video')} params={empty()} onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Seed: Random' }))
    const input = await screen.findByRole('spinbutton', { name: 'Seed' })
    fireEvent.change(input, { target: { value: '42' } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ settings: { seed: 42 } }))
    fireEvent.change(input, { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ settings: { seed: null } }))
  })

  it('shows the full name and ledger description in a tooltip on keyboard focus', async () => {
    const user = userEvent.setup()
    const omni = spec('piapi', 'seedance-2', 'omni_reference_to_video')
    render(<GenerationSettings spec={omni} params={empty()} onChange={vi.fn()} />)
    const chip = screen.getByRole('button', { name: 'Real people in references: off' })
    expect(chip).toHaveTextContent('Real people')
    while (document.activeElement !== chip) await user.tab()
    const description = omni.settings.find((s) => s.key === 'real_people')!.description
    expect(await screen.findByRole('tooltip')).toHaveTextContent(description)
  })

  it('closes the tooltip on click and keeps it closed after choosing a value, with focus back on the chip', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<GenerationSettings spec={spec('kie', 'seedance-2', 'text_to_video')} params={empty()} onChange={onChange} />)
    const chip = screen.getByRole('button', { name: 'Resolution: 720p' })
    await user.hover(chip)
    expect(await screen.findByRole('tooltip')).toBeInTheDocument()
    await user.click(chip)
    expect(screen.queryByRole('tooltip')).toBeNull()
    await user.click(await screen.findByRole('menuitemradio', { name: '1080p' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ resolution: '1080p' }))
    await waitFor(() => expect(chip).toHaveFocus())
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('keeps the tooltip closed after closing a menu with Escape', async () => {
    const user = userEvent.setup()
    render(<GenerationSettings spec={spec('kie', 'seedance-2', 'text_to_video')} params={empty()} onChange={vi.fn()} />)
    const chip = screen.getByRole('button', { name: 'Aspect ratio: 16:9' })
    await user.click(chip)
    await screen.findByRole('menuitemradio', { name: '9:16' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(chip).toHaveFocus())
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('closes the tooltip when a toggle or the stepper is clicked', async () => {
    const user = userEvent.setup()
    render(<GenerationSettings spec={spec('kie', 'seedance-2', 'text_to_video')} params={empty()} onChange={vi.fn()} />)
    const toggle = screen.getByRole('button', { name: 'Kie content filter: off' })
    await user.hover(toggle)
    expect(await screen.findByRole('tooltip')).toBeInTheDocument()
    await user.click(toggle)
    expect(screen.queryByRole('tooltip')).toBeNull()
    await user.unhover(toggle)
    const longer = screen.getByRole('button', { name: 'Longer' })
    await user.hover(longer)
    expect(await screen.findByRole('tooltip')).toBeInTheDocument()
    await user.click(longer)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('keeps a hover tooltip open while the pointer rests on the chip', async () => {
    const user = userEvent.setup()
    render(<GenerationSettings spec={spec('kie', 'seedance-2', 'text_to_video')} params={empty()} onChange={vi.fn()} />)
    await user.hover(screen.getByRole('button', { name: 'Resolution: 720p' }))
    expect(await screen.findByRole('tooltip')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 700))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Output resolution')
  })

  it('still shows the tooltip when a chip is reached with Tab', async () => {
    const user = userEvent.setup()
    render(<GenerationSettings spec={spec('kie', 'seedance-2', 'text_to_video')} params={empty()} onChange={vi.fn()} />)
    const chip = screen.getByRole('button', { name: 'Resolution: 720p' })
    while (document.activeElement !== chip) await user.tab()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Output resolution')
  })

  it('shows the setting name once, and the description only when it adds something', async () => {
    const user = userEvent.setup()
    render(<GenerationSettings spec={spec('kie', 'seedance-2', 'text_to_video')} params={empty()} onChange={vi.fn()} />)
    await user.hover(screen.getByRole('button', { name: 'Resolution: 720p' }))
    const tip = await screen.findByRole('tooltip')
    expect(tip.textContent).toBe('Output resolution')
    await user.unhover(screen.getByRole('button', { name: 'Resolution: 720p' }))
    await user.hover(screen.getByRole('button', { name: 'Kie content filter: off' }))
    const filter = await screen.findByRole('tooltip')
    expect(filter.textContent).toMatch(/^Kie content filter: offKie's optional extra content filter/)
    expect(filter.textContent?.match(/Kie content filter/g)).toHaveLength(1)
  })

  it('shows a compact notice for values reset after a switch, and dismisses it', async () => {
    const user = userEvent.setup()
    const piapi = spec('piapi', 'seedance-2', 'text_to_video')
    const { params, changes } = reconcileParams(piapi, { ...empty(), resolution: '4k' }, 'Seedance 2 on PiAPI')
    const onDismiss = vi.fn()
    render(<GenerationSettings spec={piapi} params={params} onChange={vi.fn()} changes={changes} onDismissChanges={onDismiss} />)
    expect(screen.getByText('Resolution 4k is not available for Seedance 2 on PiAPI; reset to 480p.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resolution: 480p' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalled()
  })

  it('flags an invalid value on its chip and resets only on request', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const piapi = spec('piapi', 'seedance-2', 'text_to_video')
    render(<GenerationSettings spec={piapi} params={{ ...empty(), resolution: '4k' }} onChange={onChange} />)
    const chip = screen.getByRole('button', { name: /^Resolution: / })
    expect(chip).toHaveAttribute('aria-invalid', 'true')
    expect(within(chip).getByTestId('chip-invalid')).toBeInTheDocument()
    expect(screen.getByText(/Resolution 4k is not available/)).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Reset these values' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ resolution: null }))
  })
})
