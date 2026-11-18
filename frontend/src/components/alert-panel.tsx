import * as React from 'react'
import { cn } from '@/lib/utils'

type AlertPanelVariant = 'error' | 'warning' | 'info'

interface AlertPanelProps {
  variant: AlertPanelVariant
  children: React.ReactNode
  className?: string
  icon?: React.ReactNode
  title?: React.ReactNode
}

/**
 * Body text uses the page foreground; only the border, tint and title carry the
 * state colour. The `--warning-foreground` / `--info-foreground` tokens are
 * near-black text for filled badges and must not be used here.
 *
 * Measured WCAG contrast on the dark theme (panel tint composited over
 * `--card` / `--background`):
 *   body `text-foreground`: error 15.1 / 17.2, warning 15.7 / 17.8, info 16.0 / 18.1
 *   title: `text-destructive` 5.5 / 6.2, `text-warning` 9.6 / 10.8, `text-info` 6.4 / 7.1
 *   `text-muted-foreground` inside a panel: 6.1 or better
 * The previous dark-token body text measured 1.04 to 1.14.
 */
const variantClasses: Record<AlertPanelVariant, string> = {
  error: 'border-destructive/35 bg-destructive/10 text-foreground',
  warning: 'border-warning/40 bg-warning/5 text-foreground',
  info: 'border-info/40 bg-info/5 text-foreground',
}

const variantTitleClasses: Record<AlertPanelVariant, string> = {
  error: 'text-destructive',
  warning: 'text-warning',
  info: 'text-info',
}

export function AlertPanel({ variant, children, className, icon, title }: AlertPanelProps) {
  return (
    <div
      className={cn(
        'rounded-md border px-3 py-2.5 text-xs',
        variantClasses[variant],
        className,
      )}
    >
      <div className="flex items-start gap-2">
        {icon && (
          <span className="mt-0.5 shrink-0">{icon}</span>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          {title && (
            <div className={cn('font-medium', variantTitleClasses[variant])}>{title}</div>
          )}
          {children}
        </div>
      </div>
    </div>
  )
}
