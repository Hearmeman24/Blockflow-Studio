'use client'

import { useState, type ComponentType } from 'react'
import { Cloud, HardDrive } from 'lucide-react'

import {
  getAssetStorageMode,
  setAssetStorageMode,
  type AssetStorageMode,
} from '@/lib/settings/client'

import { AlertPanel } from '@/components/alert-panel'
import { Button } from '@/components/ui/button'
import { useMutation } from '@/lib/mutation'
import { useResource } from '@/lib/resource'

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
  // The saved mode is what is persisted; the staged choice (null = none yet)
  // is persisted on Save.
  const load = useResource(() => getAssetStorageMode(), [])
  const [staged, setStaged] = useState<AssetStorageMode | null>(null)
  const save = useMutation(async (next: AssetStorageMode) => {
    await setAssetStorageMode(next)
    load.setData(() => next)
  })

  const savedMode = load.resource.kind === 'ready' ? load.resource.data : null
  const mode = staged ?? savedMode
  const saving = save.pending
  const dirty = savedMode !== null && mode !== savedMode
  const canSave = savedMode !== null && !saving && dirty

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-base font-semibold">Uploaded files</h2>
        <p className="text-xs leading-5 text-muted-foreground">
          Image and video loaders always save files on this machine. A local file is uploaded to the provider only when a generation needs it.
        </p>
      </section>

      {load.resource.kind === 'error' && (
        <AlertPanel variant="error" title="Could not load the storage setting">
          <p>{load.resource.message}</p>
          <Button type="button" size="sm" variant="outline" onClick={load.retry} className="mt-2">
            Retry
          </Button>
        </AlertPanel>
      )}

      <fieldset className="grid gap-3 md:grid-cols-2" disabled={savedMode === null || saving}>
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
                onChange={() => setStaged(option.value)}
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
          onClick={() => {
            if (mode) void save.run(mode)
          }}
          disabled={!canSave}
        >
          Save
        </Button>
        {saving && <span className="text-xs text-muted-foreground">Saving…</span>}
        {!saving && dirty && (
          <span className="text-xs text-muted-foreground">Unsaved changes.</span>
        )}
        {save.state.kind === 'error' && <span className="text-xs text-destructive">{save.state.message}</span>}
      </div>
    </div>
  )
}
