import { describe, expect, it } from 'vitest'
import { PROVIDER_REFERRALS } from './provider-referrals'

describe('PROVIDER_REFERRALS', () => {
  it('lists exactly the PiAPI and Kie referral links', () => {
    expect(PROVIDER_REFERRALS).toEqual({
      piapi: 'https://piapi.ai/?ref=dbc2855b-3394-4052-8b8a-6dcc471bfced',
      kie: 'https://kie.ai/?ref=071ed206b70bc522e7626d3b4d1ad069',
    })
  })

  it('has no entry for removed providers', () => {
    expect(Object.keys(PROVIDER_REFERRALS)).not.toContain('runpod')
  })
})
