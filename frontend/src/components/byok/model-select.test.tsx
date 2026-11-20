import '@/test-utils/ui-sdk-jsdom'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CATALOG_BOTH, CATALOG_KIE } from '@/lib/byok/__fixtures__'
import { modelsForMode } from '@/lib/byok/catalog'
import { ModelSelect } from './model-select'
import { ProviderSelect } from './provider-select'

async function arrowTo(user: ReturnType<typeof userEvent.setup>, name: string) {
  for (let i = 0; i < 12; i++) {
    const current = document.querySelector('[role="option"][data-highlighted]')
    if (current?.textContent?.startsWith(name) && !current.textContent.startsWith(`${name} `)) return current
    await user.keyboard('{ArrowDown}')
  }
  throw new Error(`could not highlight ${name}`)
}

const optionName = (o: HTMLElement) => {
  const copy = within(o).getByTestId('model-option-name').cloneNode(true) as HTMLElement
  copy.querySelectorAll('.sr-only').forEach((el) => el.remove())
  return copy.textContent
}

function option(name: string) {
  return screen.getAllByRole('option').find((o) => optionName(o) === name)!
}

describe('ModelSelect', () => {
  it('lists every model for the mode, in catalog order', async () => {
    const user = userEvent.setup()
    render(<ModelSelect catalog={CATALOG_BOTH} mode="text_to_image" provider="kie" value="seedream-5-pro" onChange={vi.fn()} />)
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    const names = screen.getAllByRole('option').map(optionName)
    expect(names).toEqual(modelsForMode(CATALOG_BOTH, 'text_to_image').map((m) => m.name))
    expect(names).not.toContain('Image Upscaler')
  })

  it('greys out models the provider cannot serve, with a visible and announced reason', async () => {
    const user = userEvent.setup()
    render(<ModelSelect catalog={CATALOG_KIE} mode="text_to_video" provider="piapi" value={null} onChange={vi.fn()} />)
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    const seedance = option('Seedance 2')
    expect(seedance).toHaveAttribute('aria-disabled', 'true')
    expect(seedance).toHaveAttribute('aria-description', 'Requires a PiAPI API key')
    expect(seedance).toHaveTextContent('Requires a PiAPI API key')
    const wan = option('Wan 3.0')
    expect(wan).toHaveAttribute('aria-disabled', 'true')
    expect(wan.getAttribute('aria-description')).toBe('Not offered by PiAPI NSFW. Provider content rules still apply.')
  })

  it('keeps unavailable options reachable by keyboard but never selects them', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ModelSelect catalog={CATALOG_KIE} mode="text_to_video" provider="piapi" value={null} onChange={onChange} />)
    const trigger = screen.getByRole('combobox', { name: 'Model' })
    await user.click(trigger)
    const highlighted = await arrowTo(user, 'Seedance 2')
    expect(highlighted).toHaveAttribute('aria-disabled', 'true')
    await user.keyboard('{Enter}')
    await user.click(option('Seedance 2 Fast'))
    expect(onChange).not.toHaveBeenCalled()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('selects an available model with the keyboard', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ModelSelect catalog={CATALOG_KIE} mode="text_to_video" provider="kie" value="seedance-2" onChange={onChange} />)
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    await arrowTo(user, 'Seedance 2 Fast')
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('seedance-2-fast')
  })

  it('supports typeahead on the closed trigger', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ModelSelect catalog={CATALOG_KIE} mode="text_to_video" provider="kie" value="seedance-2" onChange={onChange} />)
    screen.getByRole('combobox', { name: 'Model' }).focus()
    await user.keyboard('kl')
    expect(onChange).toHaveBeenLastCalledWith('kling-4.0')
  })

  it('becomes selectable once the catalog revalidates with the key', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(
      <ModelSelect catalog={CATALOG_KIE} mode="text_to_video" provider="piapi" value={null} onChange={onChange} />,
    )
    rerender(<ModelSelect catalog={CATALOG_BOTH} mode="text_to_video" provider="piapi" value={null} onChange={onChange} />)
    await user.click(screen.getByRole('combobox', { name: 'Model' }))
    expect(option('Seedance 2')).not.toHaveAttribute('aria-disabled')
    await user.click(option('Seedance 2 Mini'))
    expect(onChange).toHaveBeenCalledWith('seedance-2-mini')
  })

  it('shows the NSFW marker on the selected value and options', async () => {
    const user = userEvent.setup()
    render(<ModelSelect catalog={CATALOG_KIE} mode="text_to_video" provider="kie" value="wan-3.0" onChange={vi.fn()} />)
    const trigger = screen.getByRole('combobox', { name: 'Model' })
    expect(within(trigger).getByText('NSFW')).toHaveClass('sr-only')
    expect(trigger.querySelector('[data-icon="lips"]')).not.toBeNull()
    await user.click(trigger)
    expect(option('Wan 3.0').querySelector('[data-icon="lips"]')).not.toBeNull()
    expect(option('Seedance 2').querySelector('[data-icon="lips"]')).toBeNull()
  })

  it('shows the bolt on the fast option and on the trigger when it is selected, and on no other option', async () => {
    const user = userEvent.setup()
    render(<ModelSelect catalog={CATALOG_KIE} mode="text_to_video" provider="kie" value="wan-3.0-prime" onChange={vi.fn()} />)
    const trigger = screen.getByRole('combobox', { name: 'Model' })
    expect(within(trigger).getByText('Fast')).toHaveClass('sr-only')
    expect(trigger.querySelector('[data-fast]')).not.toBeNull()
    expect(trigger.querySelector('[data-icon="lips"]')).not.toBeNull()
    await user.click(trigger)
    const prime = option('Wan 3.0 Prime')
    expect(prime.querySelector('[data-fast]')).not.toBeNull()
    expect(prime.querySelector('[data-icon="lips"]')).not.toBeNull()
    expect(prime.getAttribute('aria-description')).toContain('Fast.')
    const withBolt = screen.getAllByRole('option').filter((o) => o.querySelector('[data-fast]'))
    expect(withBolt).toEqual([prime])
  })
})

describe('ProviderSelect', () => {
  it('shows providers without a key as unavailable with the reason', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<ProviderSelect catalog={CATALOG_KIE} value="kie" onChange={onChange} />)
    const trigger = screen.getByRole('combobox', { name: 'Provider' })
    expect(trigger).toHaveTextContent('Kie')
    await user.click(trigger)
    const piapi = screen.getAllByRole('option').find((o) => o.textContent?.startsWith('PiAPI'))!
    expect(piapi).toHaveAttribute('aria-disabled', 'true')
    expect(piapi).toHaveTextContent('Requires a PiAPI API key')
    await user.click(piapi)
    expect(onChange).not.toHaveBeenCalled()
  })
})
