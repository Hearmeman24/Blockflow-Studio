import type { NodeTypeDef } from '@/lib/pipeline/registry'
import { BLOCK_ROLES, blockRole, blockRoleStyle, type BlockRole } from '@/lib/pipeline/block-role'
import {
  getSuggestedTypes,
  type BlockSuggestionContext,
} from '@/lib/pipeline/block-suggestions'

export interface BlockPickerItem {
  def: NodeTypeDef
  suggested: boolean
  /** The block's own role, also inside Suggested. */
  role: BlockRole
}

export interface BlockPickerGroup {
  key: 'suggested' | BlockRole
  label: string
  items: BlockPickerItem[]
}

/** Suggested first, then one section per role in `BLOCK_ROLES` order: Image, Video, Loaders, Prompts. */
export function getBlockPickerGroups(
  validTypes: NodeTypeDef[],
  context?: BlockSuggestionContext,
): BlockPickerGroup[] {
  const validTypesById = new Map(validTypes.map((def) => [def.type, def]))
  const suggestedTypeOrder = getSuggestedTypes(validTypes, context)
  const suggestedTypes = new Set(suggestedTypeOrder)
  const suggested = suggestedTypeOrder
    .map((type) => validTypesById.get(type))
    .filter((def): def is NodeTypeDef => Boolean(def))
    .map((def) => ({ def, suggested: true, role: blockRole(def) }))
  const regular = validTypes
    .filter((def) => !suggestedTypes.has(def.type))
    .map((def) => ({ def, suggested: false, role: blockRole(def) }))

  const groups: BlockPickerGroup[] = []
  if (suggested.length > 0) {
    groups.push({ key: 'suggested', label: 'Suggested', items: suggested })
  }

  for (const role of BLOCK_ROLES) {
    const items = regular.filter((item) => item.role === role)
    if (items.length > 0) groups.push({ key: role, label: blockRoleStyle(role).groupLabel, items })
  }

  return groups
}
