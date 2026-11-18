'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PipelineTabsProvider } from '@/lib/pipeline/tabs-context'
import { ErrorBoundary } from '@/components/error-boundary'
import { NavBar } from '@/components/nav-bar'
import { Sidebar } from '@/components/sidebar'
import { PipelineTabs } from '@/components/pipeline/pipeline-tabs'
import { OnboardingDialog } from '@/components/onboarding-dialog'
import { CreditsPanel } from '@/components/credits-panel'
import { AppUpdateProvider } from '@/components/app-update/app-update-provider'
import { setAdvancedMode } from '@/lib/pipeline/registry'
import { getOnboardingCompleted } from '@/lib/settings/client'
import '@/components/pipeline/custom_blocks/_register'

function useFeatureFlags() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    fetch('/api/feature-flags')
      .then((res) => res.json())
      .then((flags) => {
        if (flags?.advanced) setAdvancedMode(true)
      })
      .catch(() => {})
      .finally(() => setReady(true))
  }, [])
  return ready
}

/** Opens first-start onboarding when `onboarding_completed` is not set.
 * If the pref can't be read (backend not up yet) nothing is shown. */
function useOnboarding(mounted: boolean) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!mounted) return
    let cancelled = false
    getOnboardingCompleted()
      .then((completed) => {
        if (!cancelled) setOpen(!completed)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [mounted])
  return { open, close: () => setOpen(false) }
}

export function AppShell({ children }: { children: ReactNode }) {
  useFeatureFlags()
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  const onboarding = useOnboarding(mounted)
  const pathname = usePathname()
  const isGenerateRoute = pathname === '/generate'
  const pipelineShellClass = isGenerateRoute
    ? 'h-screen bg-background'
    : 'h-screen bg-background invisible pointer-events-none fixed inset-0 -z-10'

  return (
    <ErrorBoundary>
      <TooltipProvider>
        <PipelineTabsProvider>
          <AppUpdateProvider>
          {mounted && <NavBar />}
          {mounted && <Sidebar />}
          {mounted && <CreditsPanel />}
          <main className={pipelineShellClass}>
            <PipelineTabs />
          </main>
          {mounted && <OnboardingDialog open={onboarding.open} onFinished={onboarding.close} />}
          {!isGenerateRoute && children}
          </AppUpdateProvider>
        </PipelineTabsProvider>
      </TooltipProvider>
    </ErrorBoundary>
  )
}
