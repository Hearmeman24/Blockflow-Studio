/**
 * A media section heading: a small tinted icon chip for the kind, the title,
 * and an optional muted count. Shared by the Characters editor and the Load
 * Character block.
 */
import type { ReactNode } from 'react'
import { Film, Image as ImageIcon, Music } from 'lucide-react'
import { kindAccent } from '@/lib/byok/kind-accent'
import type { CharacterMediaKind } from '@/lib/characters/types'
import { cn } from '@/lib/utils'

export const KIND_ICON = { image: ImageIcon, video: Film, audio: Music } as const

export function KindIconChip({ kind, className }: { kind: CharacterMediaKind; className?: string }) {
  const Icon = KIND_ICON[kind]
  return (
    <span aria-hidden className={cn('flex size-6 shrink-0 items-center justify-center rounded-md', kindAccent(kind).chip, className)}>
      <Icon className="size-3.5" />
    </span>
  )
}

export function KindHeading({
  kind,
  title,
  count,
  as: Tag = 'h3',
  small = false,
}: {
  kind: CharacterMediaKind
  title: ReactNode
  count?: number
  as?: 'h3' | 'h4'
  /** Denser type for block cards. */
  small?: boolean
}) {
  return (
    <Tag className={cn('flex min-w-0 items-center gap-2 font-medium', small ? 'text-xs' : 'text-sm')}>
      <KindIconChip kind={kind} className={small ? 'size-5 [&_svg]:size-3' : undefined} />
      <span className="truncate">{title}</span>
      {count != null && count > 0 && <span className="text-muted-foreground font-normal tabular-nums">{count}</span>}
    </Tag>
  )
}
