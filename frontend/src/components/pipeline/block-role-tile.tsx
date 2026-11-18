import { blockRoleStyle, type BlockRole } from '@/lib/pipeline/block-role'
import { cn } from '@/lib/utils'

/**
 * A block role's icon in a tinted tile: the chip next to a block's title and
 * the tile at the start of each add-block menu row. Decorative only.
 */
export function BlockRoleTile({ role, className }: { role: BlockRole; className?: string }) {
  const style = blockRoleStyle(role)
  const Icon = style.icon
  return (
    <span
      aria-hidden
      data-slot="block-role-tile"
      data-role={role}
      title={style.label}
      className={cn('flex shrink-0 items-center justify-center rounded-md', style.chip, className)}
    >
      {/* text-current: keep the role colour inside menu items, which grey out bare icons. */}
      <Icon className="size-3.5 text-current" />
    </span>
  )
}
