import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CostEstimateChip, JobCostBadge } from './cost-chip'
import type { CostEstimate } from '@/lib/byok/cost'

const KIE: CostEstimate = {
  amount: 205, unit: 'credits', usd_equivalent: 1.025, basis: '5 s × 41 credits/s at 720p',
  source: 'provider-specs/kie/seedance-2-0.txt', as_of: '2026-11-15', confidence: 'listed',
}
const PI: CostEstimate = { ...KIE, amount: 1, unit: 'usd', usd_equivalent: 1, basis: '5 s × $0.20/s at 720p' }

describe('CostEstimateChip', () => {
  it('renders nothing without an estimate', () => {
    const { container } = render(<CostEstimateChip estimate={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the estimate in credits or dollars with an accessible name', () => {
    const { rerender } = render(<CostEstimateChip estimate={KIE} />)
    const chip = screen.getByRole('button', { name: /Estimated cost ≈ 205 credits/ })
    expect(chip).toHaveTextContent('≈ 205 credits')
    rerender(<CostEstimateChip estimate={PI} />)
    expect(screen.getByRole('button', { name: /Estimated cost ≈ \$1\.00/ })).toHaveTextContent('≈ $1.00')
  })

  it('explains the basis and date in a tooltip on keyboard focus (server without price_source)', async () => {
    const user = userEvent.setup()
    render(<CostEstimateChip estimate={KIE} />)
    await user.tab()
    expect(screen.getByRole('button', { name: /Estimated cost/ })).toHaveFocus()
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('5 s × 41 credits/s at 720p')
    expect(tip).toHaveTextContent('≈ $1.03')
    expect(tip).toHaveTextContent('Prices as of 2026-11-15')
  })

  it('leads its tooltip with the estimate disclaimer naming the provider', async () => {
    const user = userEvent.setup()
    render(<CostEstimateChip estimate={KIE} providerName="Kie" />)
    const chip = screen.getByRole('button', { name: /Estimated cost/ })
    await user.hover(chip)
    const tip = await screen.findByRole('tooltip')
    expect(tip.textContent).toMatch(/^Estimated cost\. Provider prices can change, so check Kie for the actual cost\./)
    await user.click(chip)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('keeps the tooltip open while the pointer rests on the chip', async () => {
    const user = userEvent.setup()
    render(<CostEstimateChip estimate={KIE} providerName="Kie" />)
    const chip = screen.getByRole('button', { name: /Estimated cost/ })
    // Browsers deliver the first pointermove before React re-renders the hover state;
    // Radix's own delayed open must not then close the tooltip we opened.
    fireEvent.pointerMove(chip, { pointerType: 'mouse' })
    await user.hover(chip)
    expect(await screen.findByRole('tooltip')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 700))
    expect(screen.getByRole('tooltip')).toHaveTextContent('check Kie for the actual cost')
  })

  describe('where the price came from', () => {
    const tipFor = async (estimate: CostEstimate) => {
      const user = userEvent.setup()
      render(<CostEstimateChip estimate={estimate} providerName="Kie" />)
      await user.tab()
      return screen.findByRole('tooltip')
    }
    // Midday UTC, so the local date is the same day in every time zone.
    const AT = '2026-11-14T12:00:00Z'
    const DAY = new Date(AT).toLocaleDateString(undefined, { dateStyle: 'medium' })

    it('observed: the price the provider charged last time', async () => {
      const tip = await tipFor({ ...KIE, price_source: 'observed', price_updated_at: AT })
      expect(tip).toHaveTextContent('Based on what Kie charged for your last run of this model.')
      expect(tip).not.toHaveTextContent('seedance-2-0.txt')
    })

    it('ledger: the public price list and its date', async () => {
      const tip = await tipFor({ ...KIE, price_source: 'ledger', price_updated_at: AT })
      expect(tip).toHaveTextContent(`From the public price list, updated ${DAY}.`)
      expect(tip).not.toHaveTextContent('Prices as of')
    })

    it('bundled: the price list shipped with this version and its date', async () => {
      const tip = await tipFor({ ...KIE, price_source: 'bundled', price_updated_at: AT })
      expect(tip).toHaveTextContent(`From the price list shipped with this version, dated ${DAY}.`)
    })

    it('leaves the date out when it is missing or unreadable', async () => {
      const tip = await tipFor({ ...KIE, price_source: 'ledger', price_updated_at: 'not a date' })
      expect(tip).toHaveTextContent(/From the public price list\.$/)
    })

    it('stays at four short lines at most, lead first', async () => {
      const tip = await tipFor({ ...KIE, confidence: 'partial', price_source: 'bundled', price_updated_at: AT })
      const lines = tip.querySelectorAll('p')
      expect(lines.length).toBeLessThanOrEqual(4)
      expect(lines[0]).toHaveTextContent(/^Estimated cost\. Provider prices can change, so check Kie for the actual cost\.$/)
      expect(lines[1]).toHaveTextContent('5 s × 41 credits/s at 720p')
    })
  })

  it('looks hoverable and focusable like the other chips', () => {
    render(<CostEstimateChip estimate={KIE} />)
    const chip = screen.getByRole('button', { name: /Estimated cost/ })
    expect(chip.className).toMatch(/hover:/)
    expect(chip.className).toMatch(/focus-visible:/)
    expect(chip.className).toMatch(/rounded-full/)
  })

  it('marks a partial estimate as a lower bound', async () => {
    const user = userEvent.setup()
    render(<CostEstimateChip estimate={{ ...KIE, confidence: 'partial', basis: 'at least 10 s' }} />)
    expect(screen.getByRole('button', { name: /at least/ })).toHaveTextContent('≥ 205 credits')
    await user.tab()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/lower bound|not fully listed/)
  })
})

describe('JobCostBadge', () => {
  it('renders nothing when the job has no cost', () => {
    const { container, rerender } = render(<JobCostBadge job={{ cost: null }} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<JobCostBadge job={{}} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<JobCostBadge job={{ cost: { amount: 'x' } as never }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the actual charge with its USD value', () => {
    render(<JobCostBadge job={{ cost: { amount: 205, unit: 'credits', usd_equivalent: 1.025 } }} />)
    expect(screen.getByText('Cost: 205 credits ≈ $1.03')).toBeInTheDocument()
  })

  it('shows PiAPI points as dollars first, and raw points when unconvertible', () => {
    const { rerender } = render(<JobCostBadge job={{ cost: { amount: 6000000, unit: 'points', usd_equivalent: 0.6 } }} />)
    expect(screen.getByText('Cost: $0.60 (6,000,000 points)')).toBeInTheDocument()
    rerender(<JobCostBadge job={{ cost: { amount: 1234, unit: 'points', usd_equivalent: null } }} />)
    expect(screen.getByText('Cost: 1,234 points')).toBeInTheDocument()
  })

  it('says not charged for a zero cost', () => {
    render(<JobCostBadge job={{ cost: { amount: 0, unit: 'credits', usd_equivalent: 0 } }} />)
    expect(screen.getByText('Not charged (0 credits)')).toBeInTheDocument()
  })
})

describe('CostEstimateChip without an estimate', () => {
  const REASON = {
    code: 'conflicting_sources',
    message: "PiAPI's own pages give two different prices for this model. The actual charge will be shown after the run.",
  }

  it('renders nothing when there is neither an estimate nor a reason', () => {
    const { container } = render(<CostEstimateChip estimate={null} unavailable={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows "No estimate" with an icon and the reason on keyboard focus', async () => {
    const user = userEvent.setup()
    render(<CostEstimateChip estimate={null} unavailable={REASON} />)
    const chip = screen.getByTestId('cost-unavailable-chip')
    expect(chip).toHaveTextContent('No estimate')
    expect(chip.querySelector('svg')).not.toBeNull()
    expect(chip).toHaveAttribute('data-code', 'conflicting_sources')
    await user.tab()
    expect(chip).toHaveFocus()
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent("PiAPI's own pages give two different prices for this model.")
    expect(tip).toHaveTextContent('The actual cost is shown in the output viewer after the run.')
  })

  it('prefers the estimate when both are given', () => {
    render(<CostEstimateChip estimate={KIE} unavailable={REASON} />)
    expect(screen.getByTestId('cost-estimate-chip')).toBeInTheDocument()
    expect(screen.queryByTestId('cost-unavailable-chip')).toBeNull()
  })
})
