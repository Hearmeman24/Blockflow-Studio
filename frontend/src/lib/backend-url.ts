/**
 * Direct FastAPI URL for endpoints that exceed the Next.js dev proxy's body
 * or socket limits. BlockFlow runs locally through app.py, which launches
 * FastAPI on BACKEND_PORT and serves CORS-open backend routes. app.py passes
 * the chosen port through as NEXT_PUBLIC_BACKEND_PORT so the client bundle
 * can reach it directly.
 */
const DEFAULT_BACKEND_PORT = '47301'

export function directBackendUrl(path: string): string {
  if (typeof window === 'undefined') return path
  const port = process.env.NEXT_PUBLIC_BACKEND_PORT || DEFAULT_BACKEND_PORT
  return `${window.location.protocol}//${window.location.hostname}:${port}${path}`
}
