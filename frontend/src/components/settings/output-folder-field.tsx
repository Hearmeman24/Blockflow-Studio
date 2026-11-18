'use client'

import { useId, useState } from 'react'
import { FolderOpen } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { chooseFolder, type OutputFolderStatus } from '@/lib/settings/output-folder'

export const OUTPUT_FOLDER_EXPLANATION =
  'Generated images and videos and the files you add to loaders are saved here.'
export const EARLIER_FILES_NOTE =
  'If you change it, earlier files stay where they are and remain available.'

interface Props {
  value: string
  onChange: (value: string) => void
  /** From GET /api/settings/output-folder; null while unknown. */
  picker: OutputFolderStatus['picker'] | null
  disabled?: boolean
  placeholder?: string
  /** Extra helper line under the explanation. */
  note?: string
}

/** Output folder path input plus a "Choose folder…" button that opens the
 * operating system's folder dialog through the local backend. Typing a path
 * always works, even when no dialog is available. */
export function OutputFolderField({ value, onChange, picker, disabled, placeholder, note }: Props) {
  const inputId = useId()
  const helpId = useId()
  const [picking, setPicking] = useState(false)
  // The last dialog attempt's message ("busy", or "unavailable" when the
  // backend could not open one). It never disables the button: the next
  // attempt may work. Only the picker status from the backend disables it.
  const [message, setMessage] = useState<string | null>(null)

  const reason = picker && !picker.available ? picker.reason : null
  const canPick = !disabled && !picking && reason === null

  const handleChoose = async () => {
    if (picking) return
    setPicking(true)
    setMessage(null)
    const trimmed = value.trim()
    const result = await chooseFolder(trimmed || undefined)
    setPicking(false)
    if (result.status === 'chosen') onChange(result.path)
    else if (result.status === 'unavailable' || result.status === 'busy') setMessage(result.message)
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={inputId}>Output folder</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={inputId}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={helpId}
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleChoose()}
          disabled={!canPick}
          className="shrink-0"
        >
          <FolderOpen aria-hidden="true" />
          {picking ? 'Waiting for dialog…' : 'Choose folder…'}
        </Button>
      </div>
      <div id={helpId} className="space-y-1 text-xs text-muted-foreground">
        <p>{OUTPUT_FOLDER_EXPLANATION} {EARLIER_FILES_NOTE}</p>
        {note && <p>{note}</p>}
        <p aria-live="polite">{reason ?? message ?? ''}</p>
      </div>
    </div>
  )
}
