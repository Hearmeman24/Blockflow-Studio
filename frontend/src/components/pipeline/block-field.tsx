import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

interface BlockFieldProps {
  label: string
  hint?: string
  htmlFor?: string
  /** A small control at the end of the label row, such as the prompt library button. */
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}

export function BlockField({ label, hint, htmlFor, action, children, className }: BlockFieldProps) {
  const labelEl = (
    <Label className="text-2xs" htmlFor={htmlFor}>
      {label}
    </Label>
  )
  return (
    <div className={cn('space-y-1', className)}>
      {action ? <div className="flex min-w-0 items-center justify-between gap-2">{labelEl}{action}</div> : labelEl}
      {children}
      {hint && <p className="text-3xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
