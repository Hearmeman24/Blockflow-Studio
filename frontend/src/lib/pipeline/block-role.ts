/**
 * Block roles: what a block is for, shown as one decorative hue shared by the
 * block card (border and header chip) and the add-block menu (section headers
 * and row tiles). A block declares its role with `role` on its blockDef; a
 * block without one (a user's private block, say) gets a role from its ports.
 *
 * The hues are the media accents of `lib/byok/kind-accent.ts` at the same
 * strength, plus emerald for prompts. They say what a block is, never a state:
 * selection, status and warnings use the semantic tokens.
 *
 * Every class string is complete and static so Tailwind can see it.
 */
import { FileTextIcon, FolderOpenIcon, ImageIcon, VideoIcon, type LucideIcon } from 'lucide-react'
import {
  PORT_AUDIO,
  PORT_IMAGE,
  PORT_TEXT,
  PORT_VIDEO,
  canonicalizePortKind,
  type NodeTypeDef,
} from './registry'

export type BlockRole = 'image' | 'video' | 'loader' | 'prompt'

/** Also the order of the role sections in the add-block menu, after Suggested. */
export const BLOCK_ROLES: readonly BlockRole[] = ['image', 'video', 'loader', 'prompt']

export interface BlockRoleStyle {
  /** One role, e.g. in the header chip's accessible name. */
  label: string
  /** The add-block menu section. */
  groupLabel: string
  icon: LucideIcon
  /** The block card border. */
  border: string
  /** A small icon tile: tinted background and icon colour (card header, menu rows). */
  chip: string
  /** Section header text and icon in the add-block menu. */
  heading: string
}

const STYLES: Record<BlockRole, BlockRoleStyle> = {
  image: {
    label: 'Image',
    groupLabel: 'Image',
    icon: ImageIcon,
    border: 'border-violet-500/25',
    chip: 'bg-violet-500/15 text-violet-300',
    heading: 'text-violet-300',
  },
  video: {
    label: 'Video',
    groupLabel: 'Video',
    icon: VideoIcon,
    border: 'border-blue-500/25',
    chip: 'bg-blue-500/15 text-blue-300',
    heading: 'text-blue-300',
  },
  loader: {
    label: 'Loader',
    groupLabel: 'Loaders',
    icon: FolderOpenIcon,
    border: 'border-amber-500/25',
    chip: 'bg-amber-500/15 text-amber-300',
    heading: 'text-amber-300',
  },
  prompt: {
    label: 'Prompt',
    groupLabel: 'Prompts',
    icon: FileTextIcon,
    border: 'border-emerald-500/25',
    chip: 'bg-emerald-500/15 text-emerald-300',
    heading: 'text-emerald-300',
  },
}

const MEDIA_KINDS = new Set([PORT_IMAGE, PORT_VIDEO, PORT_AUDIO])

type RoleSource = Pick<NodeTypeDef, 'inputs' | 'outputs'> & { role?: BlockRole }

/**
 * The role a block's ports suggest. A block that takes no input and outputs
 * media is a loader; otherwise video ports win, then image, then text; a block
 * with none of these is a utility, shown with the loaders.
 */
export function inferBlockRole(def: RoleSource): BlockRole {
  const outputKinds = new Set(def.outputs.map((port) => canonicalizePortKind(port.kind)))
  const inputKinds = new Set(def.inputs.map((port) => canonicalizePortKind(port.kind)))
  if (def.inputs.length === 0 && [...outputKinds].some((kind) => MEDIA_KINDS.has(kind))) return 'loader'
  const has = (kind: string) => outputKinds.has(kind) || inputKinds.has(kind)
  if (has(PORT_VIDEO)) return 'video'
  if (has(PORT_IMAGE)) return 'image'
  if (has(PORT_TEXT)) return 'prompt'
  return 'loader'
}

/** The block's declared role, or the one its ports suggest. */
export function blockRole(def: RoleSource): BlockRole {
  return def.role ?? inferBlockRole(def)
}

export function blockRoleStyle(role: BlockRole): BlockRoleStyle {
  return STYLES[role]
}
