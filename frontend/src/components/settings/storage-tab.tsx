'use client'

import { useEffect, useState, type ComponentType } from 'react'
import { Cloud, HardDrive } from 'lucide-react'

import {
  getAssetStorageMode,
  setAssetStorageMode,
  type AssetStorageMode,
} from '@/lib/settings/client'

import { Button } from '@/components/ui/button'

const OPTIONS: Array<{
  value: AssetStorageMode
  label: string
  description: string
  icon: ComponentType<{ className?: string }>
}> = [
  {
    value: 'local_only',
    label: 'Local only',
    description: 'Loader files stay on this machine. They are uploaded to Kie or PiAPI only when a generation uses them.',
    icon: HardDrive,
  },
  {
    value: 'tmpfiles',
    label: 'Temporary public URLs',
    description: 'When the provider refuses a local file at run time, it is sent to tmpfiles.org instead. Anyone with that link can open the file while it exists.',
    icon: Cloud,
  },
]

export function StorageTab() {
  // savedMode = what's persisted; mode = the staged selection (persisted on Save).
  const [savedMode, setSavedMode] = useState<AssetStorageMode | null>(null)
  const [mode, setMode] = useState<AssetStorageMode>('local_only')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getAssetStorageMode()
      .then((value) => {
        if (cancelled) return
        setSavedMode(value)
        setMode(value)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await setAssetStorageMode(mode)
      setSavedMode(mode)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const dirty = savedMode !== null && mode !== savedMode
  const canSave = !loading && !saving && dirty

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-base font-semibold">Uploaded files</h2>
        <p className="text-xs leading-5 text-muted-foreground">
          Image and video loaders always save files on this machine. A local file is uploaded to the provider only when a generation needs it.
        </p>
      </section>

      <fieldset className="grid gap-3 md:grid-cols-2" disabled={loading || saving}>
        <legend className="sr-only">Uploaded file storage mode</legend>
        {OPTIONS.map((option) => {
          const Icon = option.icon
          const checked = mode === option.value
          return (
            <label
              key={option.value}
              className={`relative rounded-md border p-4 ${
                checked ? 'border-primary bg-primary/10' : 'border-border/60 bg-background/60'
              }`}
            >
              <input
                type="radio"
                name="asset_storage_mode"
                value={option.value}
                checked={checked}
                onChange={() => setMode(option.value)}
                className="sr-only"
              />
              <div className="mb-3 flex items-center justify-between">
                <div className="flex size-9 items-center justify-center rounded-md bg-primary/15 text-primary">
                  <Icon className="size-4" />
                </div>
              </div>
              <div className="text-sm font-semibold">{option.label}</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{option.description}</p>
            </label>
          )
        })}
      </fieldset>

      <div className="flex items-center gap-3">
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={!canSave}
        >
          Save
        </Button>
        {saving && <span className="text-xs text-muted-foreground">Saving…</span>}
        {!saving && dirty && (
          <span className="text-xs text-muted-foreground">Unsaved changes.</span>
        )}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </div>
  )
}
