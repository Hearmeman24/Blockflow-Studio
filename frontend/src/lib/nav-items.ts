import { Sparkles, FolderOpen, Users } from 'lucide-react'

export const NAV_ITEMS = [
  { href: '/generate', label: 'Generate', icon: Sparkles },
  { href: '/characters', label: 'Characters', icon: Users },
  { href: '/artifacts', label: 'Artifacts', icon: FolderOpen },
] as const
