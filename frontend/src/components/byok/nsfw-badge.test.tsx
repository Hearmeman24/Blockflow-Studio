import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CATALOG_BOTH } from '@/lib/byok/__fixtures__'
import { ModelName, NsfwBadge, NSFW_DESCRIPTION } from './nsfw-badge'

describe('NsfwBadge', () => {
  it('has screen-reader text, the lips icon, and a tooltip on keyboard focus', async () => {
    const user = userEvent.setup()
    render(<NsfwBadge />)
    expect(screen.getByText('NSFW')).toHaveClass('sr-only')
    const trigger = screen.getByText('NSFW').closest('[data-slot="nsfw-badge"]') as HTMLElement
    expect(trigger.querySelector('[data-icon="lips"]')).not.toBeNull()
    await user.tab()
    expect(trigger).toHaveFocus()
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('NSFW')
    expect(tooltip).toHaveTextContent('Provider content rules still apply')
    expect(NSFW_DESCRIPTION).toBe('NSFW. Provider content rules still apply.')
  })

  it('shows the tooltip on hover', async () => {
    const user = userEvent.setup()
    render(<NsfwBadge />)
    await user.hover(screen.getByText('NSFW').closest('[data-slot="nsfw-badge"]') as HTMLElement)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('NSFW')
  })
})

describe('ModelName', () => {
  it('marks NSFW models with the token colour, icon and text, and nothing on others', () => {
    const { rerender } = render(<ModelName name="Wan 3.0" nsfw />)
    const name = screen.getByText('Wan 3.0')
    expect(name.closest('[data-nsfw]')).toHaveClass('text-nsfw')
    expect(screen.getByText('NSFW')).toBeInTheDocument()
    rerender(<ModelName name="Seedance 2" nsfw={false} />)
    expect(screen.queryByText('NSFW')).toBeNull()
    expect(screen.getByText('Seedance 2').closest('[data-nsfw]')).toBeNull()
  })

  it('is shown for exactly the NSFW models in the catalog', () => {
    render(
      <ul>
        {CATALOG_BOTH.models.map((m) => (
          <li key={m.id} data-testid={m.id}><ModelName name={m.name} nsfw={m.nsfw} /></li>
        ))}
      </ul>,
    )
    const marked = CATALOG_BOTH.models
      .filter((m) => screen.getByTestId(m.id).querySelector('[data-icon="lips"]'))
      .map((m) => m.id)
    expect(marked).toEqual(CATALOG_BOTH.models.filter((m) => m.nsfw).map((m) => m.id))
    expect(marked.length).toBeGreaterThan(0)
  })
})
