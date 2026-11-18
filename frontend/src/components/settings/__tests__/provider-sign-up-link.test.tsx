import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// Simulate a referral map with the Kie entry missing.
vi.mock('@/lib/provider-referrals', () => ({
  PROVIDER_REFERRALS: { piapi: 'https://piapi.ai/?ref=test' },
}))

import { ProviderSignUpLink } from '../provider-keys'

describe('ProviderSignUpLink', () => {
  test('renders the referral URL when present', () => {
    render(<ProviderSignUpLink provider="piapi" />)
    const link = screen.getByRole('link', { name: /get a piapi api key/i })
    expect(link).toHaveAttribute('href', 'https://piapi.ai/?ref=test')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  test('renders nothing when the referral entry is missing', () => {
    const { container } = render(<ProviderSignUpLink provider="kie" />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
