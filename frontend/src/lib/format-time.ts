/**
 * Consolidated time/duration formatters.
 *
 *   formatElapsedSeconds — seconds | null | undefined, for elapsed timers
 *   fmtDurationSeconds   — rounded seconds with an hours branch
 *   formatRelativeTime   — ISO timestamp → "5m ago" style text
 */

/**
 * Accepts seconds | null | undefined.
 * Returns '' for falsy / non-positive input.
 * No hours branch — minutes keep counting past 60.
 */
export function formatElapsedSeconds(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return ''
  if (seconds < 60) return `${Math.round(seconds)}s`
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
}

/**
 * Rounds seconds; has an hours branch that drops the seconds component.
 */
export function fmtDurationSeconds(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** ISO timestamp → "5m ago", "3d ago", then a short date. */
export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
