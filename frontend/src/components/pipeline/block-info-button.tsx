'use client'

/**
 * Header info button: shown by the block card for a block that declares
 * `info` on its `BlockDef`. Opens a small panel with the block's usage notes.
 * Click, Enter or Space opens it; Escape or a click outside closes it and
 * focus returns to the button. Blocks never render this themselves.
 */
import { Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

export interface BlockInfoButtonProps {
  /** The block's display name, for the accessible name ("How to use <label>"). */
  label: string
  /** Short usage notes, one per line. Nothing renders for an empty list. */
  info: readonly string[] | undefined
}

export function BlockInfoButton({ label, info }: BlockInfoButtonProps) {
  if (!info || info.length === 0) return null
  const name = `How to use ${label}`
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={name} title={name} data-testid="block-info-button">
          <Info aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label={name} className="w-64 p-2.5">
        <ul className="text-muted-foreground list-disc space-y-1 pl-4 text-xs">
          {info.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
