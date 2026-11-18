'use client'

/**
 * Floating credits control, fixed at the top right of the app: remaining
 * credits per connected provider, from `GET /api/providers/balances`.
 *
 * Compact pill by default; hover, keyboard focus or click opens a popover
 * with one row per provider (status, balance, last updated, retry), a
 * Refresh button and a link to Settings → API keys. Hover and focus preview
 * it without moving focus; click or Enter pins it and moves focus inside;
 * Escape closes it and returns focus to the pill.
 */
import Link from 'next/link'
import { useRef, useState } from 'react'
import { RefreshCw, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/status-badge'
import { formatBalance, formatCompactAmount, formatUpdated, type ProviderBalance } from '@/lib/byok/cost'
import { useProviderBalances } from '@/lib/byok/use-provider-balances'
import { cn } from '@/lib/utils'

export const SETTINGS_KEYS_HREF = '/settings?tab=credentials'

// Below the centred nav bar up to xl, beside it from xl (1280px) up: the nav
// bar (with the update indicator) is about 650px wide and a pill with two
// balances about 240px, so side by side they only fit from about 1150px. The
// canvas Recenter button sits lower inside the canvas, so they never overlap.
const POSITION = 'fixed right-4 top-16 z-40 xl:top-4'

/**
 * Top padding that keeps page content below this panel: on narrow screens it
 * sits at top-16 (4rem) and is about 2rem tall, so content starts at pt-28
 * (7rem); from xl up it sits beside the nav bar and pages keep pt-20. Change
 * it together with POSITION.
 */
export const CREDITS_PANEL_CLEARANCE = 'pt-28 xl:pt-20'

const STATUS_TEXT: Record<ProviderBalance['status'], string> = {
  ok: 'Connected',
  unavailable: 'Balance unavailable',
  error: 'Error',
  not_configured: 'Not connected',
}
const STATUS_VARIANT = {
  ok: 'success', unavailable: 'warning', error: 'error', not_configured: 'neutral',
} as const

function pillText(b: ProviderBalance): string {
  if (b.status === 'ok' && typeof b.amount === 'number') return formatCompactAmount(b.amount, b.unit)
  return b.status === 'error' ? 'error' : 'unavailable'
}

function announcement(balances: ProviderBalance[] | undefined, error: Error | undefined): string {
  if (error && !balances) return 'Credits unavailable.'
  if (!balances) return ''
  return balances
    .map((b) => `${b.label}: ${b.status === 'ok' ? formatBalance(b) : STATUS_TEXT[b.status].toLowerCase()}.`)
    .join(' ')
}

function BalanceRow({ balance, onRetry, busy }: { balance: ProviderBalance; onRetry: () => void; busy: boolean }) {
  const text = balance.status === 'ok' ? formatBalance(balance) : ''
  return (
    <li data-testid={`balance-row-${balance.provider}`} className="space-y-1 py-2 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{balance.label}</span>
        <StatusBadge variant={STATUS_VARIANT[balance.status]}>{STATUS_TEXT[balance.status]}</StatusBadge>
      </div>
      {text && <p className="text-sm tabular-nums">{text}</p>}
      {balance.message && balance.status !== 'ok' && (
        <p className="text-muted-foreground text-2xs">{balance.message}</p>
      )}
      <div className="text-muted-foreground flex items-center justify-between gap-2 text-2xs">
        {balance.status === 'not_configured' ? (
          <Link href={SETTINGS_KEYS_HREF} className="text-link hover:underline">
            Add a {balance.label} key
          </Link>
        ) : (
          <span>Updated {formatUpdated(balance.fetched_at)}</span>
        )}
        {balance.status === 'error' && (
          <Button type="button" variant="outline" size="xs" onClick={onRetry} disabled={busy}
            aria-label={`Retry ${balance.label}`}>
            Retry
          </Button>
        )}
      </div>
    </li>
  )
}

export function CreditsPanel({ debounceMs, className }: { debounceMs?: number; className?: string }) {
  const { balances, error, isLoading, isRefreshing, refresh } = useProviderBalances({ debounceMs })
  const [open, setOpen] = useState(false)
  // 'preview' (hover / focus) keeps focus on the pill; 'pinned' (click / Enter) moves it inside.
  const mode = useRef<'preview' | 'pinned'>('preview')
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Focus coming back to the pill after a close must not reopen the preview.
  const suppressFocusOpen = useRef(false)
  const panel = useRef<HTMLDivElement>(null)

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const preview = () => {
    cancelClose()
    if (!open) {
      mode.current = 'preview'
      setOpen(true)
    }
  }
  const scheduleClose = () => {
    if (mode.current === 'pinned') return
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), 150)
  }

  const live = (
    <span data-testid="credits-live" aria-live="polite" className="sr-only">
      {announcement(balances, error)}
    </span>
  )

  if (isLoading) {
    return (
      <div data-testid="credits-panel" className={cn(POSITION, className)}>
        <div
          role="status"
          aria-label="Loading credits"
          className="bg-card/80 flex h-8 items-center gap-2 rounded-full border border-border/50 px-3 shadow-lg backdrop-blur-md"
        >
          <Wallet aria-hidden className="text-muted-foreground size-4" />
          <Skeleton className="h-3 w-20" />
        </div>
        {live}
      </div>
    )
  }

  const connected = (balances ?? []).filter((b) => b.configured)
  if (balances && connected.length === 0) {
    return (
      <div data-testid="credits-panel" className={cn(POSITION, className)}>
        <Button asChild variant="outline" size="sm" className="bg-card/80 rounded-full shadow-lg backdrop-blur-md">
          <Link href={SETTINGS_KEYS_HREF}>
            <Wallet aria-hidden className="size-4" />
            Add an API key
          </Link>
        </Button>
        {live}
      </div>
    )
  }

  const summary = balances
    ? connected.map((b) => ({ key: b.provider, text: `${b.label} ${pillText(b)}` }))
    : [{ key: 'error', text: 'Credits unavailable' }]

  return (
    <div data-testid="credits-panel" className={cn(POSITION, className)}>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            suppressFocusOpen.current = true
            cancelClose()
          }
          setOpen(next)
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Credits: ${summary.map((s) => s.text).join(', ')}. Show details`}
            onPointerEnter={preview}
            onPointerLeave={scheduleClose}
            onFocus={() => {
              if (suppressFocusOpen.current) return
              preview()
            }}
            onBlur={() => {
              suppressFocusOpen.current = false
            }}
            onClick={(e) => {
              // A click on an open preview pins it instead of closing it.
              if (open && mode.current === 'preview') {
                e.preventDefault()
                mode.current = 'pinned'
                panel.current?.querySelector<HTMLElement>('button, a')?.focus()
                return
              }
              mode.current = 'pinned'
            }}
            className="bg-card/80 hover:bg-accent/70 h-8 max-w-[calc(100vw-2rem)] gap-2 rounded-full px-3 shadow-lg backdrop-blur-md"
          >
            <Wallet aria-hidden className="size-4" />
            {summary.map(({ key, text }, i) => (
              <span key={key} className={cn('truncate text-xs tabular-nums', i > 0 && 'border-border/60 border-l pl-2')}>
                {text}
              </span>
            ))}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          ref={panel}
          align="end"
          aria-label="Provider credits"
          className="w-72 p-3"
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
          onOpenAutoFocus={(e) => {
            if (mode.current === 'preview') e.preventDefault()
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold">Provider credits</p>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Refresh balances"
              disabled={isRefreshing}
              onClick={() => void refresh()}
            >
              <RefreshCw aria-hidden className={cn('size-3.5', isRefreshing && 'animate-spin motion-reduce:animate-none')} />
            </Button>
          </div>
          {balances ? (
            <ul className="divide-border/60 divide-y">
              {balances.map((b) => (
                <BalanceRow key={b.provider} balance={b} busy={isRefreshing} onRetry={() => void refresh()} />
              ))}
            </ul>
          ) : (
            <div className="space-y-2">
              <p className="text-destructive text-xs">{error?.message ?? 'Could not load balances.'}</p>
              <Button type="button" variant="outline" size="xs" onClick={() => void refresh()} disabled={isRefreshing}>
                Retry
              </Button>
            </div>
          )}
          <div className="border-border/60 mt-2 border-t pt-2">
            <Link href={SETTINGS_KEYS_HREF} className="text-link text-2xs hover:underline">
              Manage API keys in Settings
            </Link>
          </div>
        </PopoverContent>
      </Popover>
      {live}
    </div>
  )
}
