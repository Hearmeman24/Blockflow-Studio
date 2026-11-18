import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProviderMissingCard } from '../provider-missing-card'
import { PROVIDER_REFERRALS } from '@/lib/provider-referrals'

describe('ProviderMissingCard', () => {
  it('shows a PiAPI blocking card with the configured referral URL', () => {
    render(
      <ProviderMissingCard
        provider="PiAPI"
        credentialLabel="PiAPI API key"
        settingsHint="Settings -> Credentials"
        referralUrl={PROVIDER_REFERRALS.piapi}
      />,
    )

    expect(screen.getByText('PiAPI API key required')).toBeInTheDocument()
    expect(screen.getByText(/This block is disabled until the credential is added/i)).toBeInTheDocument()
    expect(screen.getByText(/Settings -> Credentials/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /create PiAPI account/i })).toHaveAttribute(
      'href',
      'https://piapi.ai/?ref=dbc2855b-3394-4052-8b8a-6dcc471bfced',
    )
  })

  it('shows a Kie referral URL when configured', () => {
    render(
      <ProviderMissingCard
        provider="Kie"
        credentialLabel="Kie API key"
        referralUrl={PROVIDER_REFERRALS.kie}
      />,
    )

    expect(screen.getByRole('link', { name: /create Kie account/i })).toHaveAttribute(
      'href',
      'https://kie.ai/?ref=071ed206b70bc522e7626d3b4d1ad069',
    )
  })

  it('omits the referral CTA when no provider referral URL is configured', () => {
    render(
      <ProviderMissingCard
        provider="Example"
        credentialLabel="Example API key"
      />,
    )

    expect(screen.queryByRole('link', { name: /create Example account/i })).not.toBeInTheDocument()
  })
})

