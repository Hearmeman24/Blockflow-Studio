'use client'

/**
 * Actions on a run shared by the gallery tile and the viewer: Restore (open
 * the run's flow in a new tab on the canvas), Favorite and Copy prompt, as
 * icon buttons with tooltips that never stick.
 */
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Check, Copy, Rewind } from 'lucide-react'
import { ChipTooltip } from '@/components/chip-tooltip'
import { FavoriteButton } from '@/components/favorite-button'
import { Button } from '@/components/ui/button'
import { toggleRunFavorite } from '@/lib/api'
import { useMutation } from '@/lib/mutation'
import { usePipelineTabs } from '@/lib/pipeline/tabs-context'
import type { RunEntry } from '@/lib/types'

/** Opens the run's flow snapshot in a new tab and goes to the canvas. */
export function useRestoreRun(): (run: RunEntry) => void {
  const router = useRouter()
  const { restoreFlowSnapshot } = usePipelineTabs()
  return (run) => {
    const tabId = restoreFlowSnapshot(run.name || 'Restored Run', run.flow_snapshot)
    if (tabId) router.push('/generate')
  }
}

const FAVORITE_FAILED = 'Could not change the favorite. Try again.'

/**
 * The run's favourite state, kept in step with the server's value. The route
 * is a toggle, so one request at a time: the star changes at once, a click
 * while a request is pending is ignored, and a failure puts the star back and
 * says so.
 */
export function useRunFavorite(run: RunEntry, onToggled?: () => void): { fav: boolean; pending: boolean; toggle: () => Promise<void> } {
  const server = run.favorited ?? false
  const [fav, setFav] = useState(server)
  const [seen, setSeen] = useState(server)
  const mutation = useMutation(async (before: boolean) => {
    const res = await toggleRunFavorite(run.id)
    if (!res?.ok) throw new Error(typeof res?.error === 'string' ? res.error : FAVORITE_FAILED)
    return { favorited: Boolean(res.favorited), before }
  })
  // Follow a new server value (after a refresh) without an effect; not while
  // a toggle is in flight, whose answer is newer.
  if (seen !== server && !mutation.pending) {
    setSeen(server)
    setFav(server)
  }
  const toggle = async () => {
    if (mutation.pending) return
    const before = fav
    setFav(!before)
    const result = await mutation.run(before)
    if (result.status === 'done') {
      setFav(result.value.favorited)
      onToggled?.()
    } else if (result.status === 'failed') {
      setFav(before)
      toast.error(FAVORITE_FAILED)
    }
  }
  return { fav, pending: mutation.pending, toggle }
}

export function RestoreButton({ name, onRestore, className }: { name: string; onRestore: () => void; className?: string }) {
  return (
    <ChipTooltip tip="Restore" side="top">
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Restore ${name}`} onClick={onRestore} className={className}>
        <Rewind aria-hidden className="size-3.5" />
      </Button>
    </ChipTooltip>
  )
}

export function FavoriteRunButton({ name, fav, onToggle }: { name: string; fav: boolean; onToggle: () => void }) {
  return (
    <ChipTooltip tip={fav ? 'Remove from favorites' : 'Favorite'} side="top">
      <FavoriteButton active={fav} onToggle={onToggle} label={`Favorite ${name}`} />
    </ChipTooltip>
  )
}

export function CopyPromptButton({ name, prompt, className }: { name: string; prompt: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      toast.success('Prompt copied.')
    } catch {
      toast.error('Could not copy the prompt. Select the text and copy it instead.')
    }
  }
  return (
    <ChipTooltip tip={copied ? 'Copied' : 'Copy prompt'} side="top">
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Copy prompt for ${name}`} onClick={copy} className={className}>
        {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
      </Button>
    </ChipTooltip>
  )
}
