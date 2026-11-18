export const PROVIDER_REFERRALS = {
  piapi: 'https://piapi.ai/?ref=dbc2855b-3394-4052-8b8a-6dcc471bfced',
  kie: 'https://kie.ai/?ref=071ed206b70bc522e7626d3b4d1ad069',
} as const

export type ProviderReferralKey = keyof typeof PROVIDER_REFERRALS
