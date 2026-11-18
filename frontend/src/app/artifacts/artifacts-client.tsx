'use client'

import { Suspense } from 'react'
import { RunHistory } from '@/components/run-history'
import { CREDITS_PANEL_CLEARANCE } from '@/components/credits-panel'
import { SIDE_NAV_CLEARANCE } from '@/components/sidebar'
import { cn } from '@/lib/utils'

/**
 * Wider than the usual max-w-6xl page, since the gallery wants large tiles:
 * from tablet width up, 80 % of the window, centred (10 % free each side,
 * which also clears the floating side nav: 10 % of 768 px is beyond the nav's
 * edge). On phones, the normal right gutter and a left inset that clears it.
 */
function ArtifactsInner() {
  return (
    <main className={cn(SIDE_NAV_CLEARANCE, CREDITS_PANEL_CLEARANCE, 'pr-4 pb-6 md:mx-auto md:w-4/5 md:px-0')}>
      <RunHistory />
    </main>
  )
}

export function ArtifactsClient() {
  return (
    <Suspense>
      <ArtifactsInner />
    </Suspense>
  )
}
