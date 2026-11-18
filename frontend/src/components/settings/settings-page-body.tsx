'use client'

import { useRouter, useSearchParams } from 'next/navigation'

import { AppTab } from './app-tab'
import { ApiKeysTab } from './api-keys-tab'
import { KeyboardTab } from './keyboard-tab'
import { SETTINGS_TABS, SettingsLayout, type SettingsTabId } from './layout'
import { StorageTab } from './storage-tab'
import { ShortcutPrefsProvider } from '@/lib/settings/shortcuts-client'

// Derived from SETTINGS_TABS so a new tab can't drift out of the guard.
export function isSettingsTab(value: string | null): value is SettingsTabId {
  return SETTINGS_TABS.some((t) => t.id === value)
}

export function SettingsPageBody() {
  const router = useRouter()
  const params = useSearchParams()
  const rawTab = params?.get('tab') ?? null
  const activeTab: SettingsTabId = isSettingsTab(rawTab) ? rawTab : 'credentials'

  const setTab = (tab: SettingsTabId) => {
    const next = new URLSearchParams(params?.toString() ?? '')
    next.set('tab', tab)
    router.replace(`/settings?${next.toString()}`)
  }

  return (
    <SettingsLayout activeTab={activeTab} onTabChange={setTab}>
      {activeTab === 'credentials' && <ApiKeysTab />}
      {activeTab === 'storage' && <StorageTab />}
      {activeTab === 'app' && <AppTab />}
      {activeTab === 'keyboard' && (
        <ShortcutPrefsProvider>
          <KeyboardTab />
        </ShortcutPrefsProvider>
      )}
    </SettingsLayout>
  )
}
