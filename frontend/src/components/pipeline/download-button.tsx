import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const FALLBACK_NAME = 'download'

function parse(url: string): URL | null {
  try {
    return new URL(url, window.location.href)
  } catch {
    return null
  }
}

/** The last path segment of a URL, without query or hash and decoded; "download" when there is none. */
export function downloadFileName(url: string): string {
  const path = parse(url)?.pathname ?? url.split(/[?#]/)[0]
  const last = path.substring(path.lastIndexOf('/') + 1)
  if (!last) return FALLBACK_NAME
  try {
    return decodeURIComponent(last) || FALLBACK_NAME
  } catch {
    return last
  }
}

/** Browsers honour the `download` attribute only for the app's own origin (and blob:/data: URLs). */
function isSameOrigin(url: string): boolean {
  const u = parse(url)
  if (!u) return true
  if (u.protocol === 'blob:' || u.protocol === 'data:') return true
  return u.origin === window.location.origin
}

/**
 * Download link for the item a viewer shows: a real link, styled as a small
 * secondary Button. A file on another origin opens in a new tab instead, so
 * the app's own tab is never navigated away. `iconOnly` is the compact form
 * for a viewer's bottom row: the icon alone, the same accessible name, and the
 * URL (the file's path) as its tooltip.
 */
export function DownloadButton({ url, iconOnly = false, className }: {
  url: string
  iconOnly?: boolean
  className?: string
}) {
  const name = downloadFileName(url)
  const external = !isSameOrigin(url)
  return (
    <Button
      asChild
      variant="outline"
      size={iconOnly ? 'icon-xs' : 'sm'}
      className={cn(iconOnly ? 'shrink-0' : 'w-full', className)}
    >
      <a
        href={url}
        download={name}
        aria-label={`Download ${name}`}
        {...(iconOnly ? { title: url } : {})}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        <Download aria-hidden="true" />
        {!iconOnly && 'Download'}
      </a>
    </Button>
  )
}
