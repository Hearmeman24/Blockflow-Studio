import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'

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
 * the app's own tab is never navigated away.
 */
export function DownloadButton({ url }: { url: string }) {
  const name = downloadFileName(url)
  const external = !isSameOrigin(url)
  return (
    <Button asChild variant="outline" size="sm" className="w-full">
      <a
        href={url}
        download={name}
        aria-label={`Download ${name}`}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        <Download aria-hidden="true" />
        Download
      </a>
    </Button>
  )
}
