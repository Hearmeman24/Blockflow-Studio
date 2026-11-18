import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Lips outline, drawn to match lucide-react's 24px stroke icons (lucide has no
 * lips icon). Decorative by default; pass `title` to give it an accessible name.
 */
export function LipsIcon({ className, title, ...props }: React.SVGProps<SVGSVGElement> & { title?: string }) {
  const labelled = Boolean(title)
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon="lips"
      className={cn('size-3.5 shrink-0', className)}
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      {...props}
    >
      {labelled && <title>{title}</title>}
      <path d="M2 12c2.5-3.5 5-5.5 7-5.5 1.2 0 2.1.7 3 1.5.9-.8 1.8-1.5 3-1.5 2 0 4.5 2 7 5.5-2.5 3.5-5.5 5.5-10 5.5S4.5 15.5 2 12Z" />
      <path d="M2 12c3 .8 6.5 1.2 10 1.2s7-.4 10-1.2" />
    </svg>
  )
}
