'use client'

import { AlertTriangle, Copy, Eye, EyeOff, X } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { AlertPanel } from '@/components/alert-panel'
import { usePipeline } from '@/lib/pipeline/pipeline-context'
import { describeUnsupportedBlock, extractRecoverableText } from '@/lib/pipeline/legacy-blocks'
import type { PipelineBlock } from '@/lib/pipeline/types'
import { cn } from '@/lib/utils'

/** Longest text shown in a read-only field; Copy always copies the full value. */
export const MAX_DISPLAY_CHARS = 20_000

interface UnsupportedBlockCardProps {
  block: PipelineBlock
  displayNumber: string
}

async function copyText(text: string) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
    await navigator.clipboard.writeText(text)
    toast.success('Copied to clipboard')
  } catch {
    toast.error('Could not copy to the clipboard')
  }
}

/**
 * Placeholder for a block whose type is not registered in this version (removed
 * by the BYOK fork, or from a block pack that is not installed). The block stays
 * in the pipeline with its saved data so re-exporting the flow loses nothing;
 * the card explains why it cannot run and lets the user copy saved prompts out
 * before removing it.
 */
export function UnsupportedBlockCard({ block, displayNumber }: UnsupportedBlockCardProps) {
  const { removeBlock, toggleBlockDisabled, isRunning } = usePipeline()
  const info = describeUnsupportedBlock(block.type)
  const label = block.label || info.label
  const isDisabled = !!block.disabled
  const config = block.preserved?.config
  const recoverable = extractRecoverableText(config)
  const settingsCount = config && typeof config === 'object' ? Object.keys(config).length : 0

  return (
    <Card
      role="group"
      aria-label={`Unsupported block: ${label}`}
      tabIndex={0}
      data-testid="unsupported-block-card"
      className={cn(
        'flex w-[360px] min-h-[220px] shrink-0 flex-col border-2 border-dashed border-warning/40 panningDisabled wheelDisabled',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isDisabled && 'opacity-60',
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between gap-2 px-4 py-2.5 shrink-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{displayNumber}</span>
          <CardTitle className="truncate text-sm" title={label}>
            {label}
          </CardTitle>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => toggleBlockDisabled(block.id)}
            disabled={isRunning}
            aria-label={isDisabled ? 'Enable block' : 'Disable block'}
            title={isDisabled ? 'Enable block' : 'Disable block'}
          >
            {isDisabled ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => removeBlock(block.id)}
            disabled={isRunning}
            aria-label="Remove block"
            title="Remove block"
          >
            <X className="size-3" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="flex-1 space-y-3 overflow-y-auto px-4 pb-3 pt-0">
        <AlertPanel
          variant="warning"
          icon={<AlertTriangle className="size-3.5 text-warning" aria-hidden="true" />}
          title="Unsupported block"
        >
          <p className="text-muted-foreground">{info.reason}</p>
          <p className="text-2xs text-muted-foreground">
            Type <code className="font-mono text-foreground">{block.type || '(none)'}</code>
          </p>
          <p className="text-2xs text-muted-foreground">
            {isDisabled
              ? 'Disabled. It is skipped when the pipeline runs.'
              : 'The pipeline will not run until you remove or disable this block.'}
          </p>
        </AlertPanel>

        {settingsCount > 0 && (
          <p className="text-2xs text-muted-foreground">
            {settingsCount === 1
              ? 'Its 1 saved setting is kept and saved with the flow.'
              : `Its ${settingsCount} saved settings are kept and saved with the flow.`}
          </p>
        )}

        {recoverable.map((entry) => {
          const truncated = entry.text.length > MAX_DISPLAY_CHARS
          return (
            <div key={entry.key} className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-2xs font-medium text-muted-foreground">{entry.label}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-2xs"
                  onClick={() => void copyText(entry.text)}
                  aria-label={`Copy ${entry.label}`}
                >
                  <Copy className="size-3" aria-hidden="true" />
                  Copy
                </Button>
              </div>
              <Textarea
                readOnly
                aria-label={`Saved ${entry.label}`}
                value={truncated ? entry.text.slice(0, MAX_DISPLAY_CHARS) : entry.text}
                className="min-h-16 max-h-40 resize-y whitespace-pre-wrap break-words text-xs"
              />
              {truncated && (
                <p className="text-3xs text-muted-foreground">
                  Showing the first {MAX_DISPLAY_CHARS.toLocaleString()} characters. Copy copies the full text.
                </p>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
