import { ExternalLink } from 'lucide-react'

import { PROVIDER_REFERRALS } from '@/lib/provider-referrals'
import type { CredentialName, KeyProvider } from '@/lib/settings/client'
import { cn } from '@/lib/utils'

/** Display metadata for the two BYOK providers, shared by Settings and onboarding. */
export type ProviderKeySpec = {
  provider: KeyProvider
  credential: CredentialName
  label: string
}

export const PROVIDER_KEY_SPECS: readonly ProviderKeySpec[] = [
  { provider: 'kie', credential: 'kie_api_key', label: 'Kie' },
  { provider: 'piapi', credential: 'piapi_api_key', label: 'PiAPI' },
] as const

export function providerLabel(provider: KeyProvider): string {
  return PROVIDER_KEY_SPECS.find((s) => s.provider === provider)?.label ?? provider
}

/** "Get a Kie API key" link to the provider's sign-up page. Renders nothing
 * when `lib/provider-referrals.ts` has no URL for the provider. */
export function ProviderSignUpLink({ provider, className }: { provider: KeyProvider; className?: string }) {
  const href = (PROVIDER_REFERRALS as Partial<Record<KeyProvider, string>>)[provider]
  if (!href) return null
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex items-center gap-1 text-xs text-link underline-offset-4 hover:text-link-hover hover:underline',
        className,
      )}
    >
      Get a {providerLabel(provider)} API key
      <ExternalLink className="size-3" aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  )
}
