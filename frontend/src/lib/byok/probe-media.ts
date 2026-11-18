/**
 * Best-effort media metadata read in the browser (image dimensions; video and
 * audio duration and video dimensions), so ledger size, duration and
 * dimension limits can be checked before anything is sent. Returns `{}` when
 * the browser cannot read the file; the backend validates what it can.
 */
import type { MediaKind } from './types'

export interface MediaProbe {
  width?: number
  height?: number
  duration_s?: number
}

export async function probeMedia(file: File, kind: MediaKind): Promise<MediaProbe> {
  try {
    if (kind === 'image' && typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(file)
      const out = { width: bitmap.width, height: bitmap.height }
      bitmap.close?.()
      return out
    }
    if (kind !== 'image' && typeof URL.createObjectURL === 'function' && typeof document !== 'undefined') {
      const url = URL.createObjectURL(file)
      try {
        return await new Promise((resolve) => {
          const el = document.createElement(kind === 'video' ? 'video' : 'audio')
          const timer = setTimeout(() => resolve({}), 5000)
          el.preload = 'metadata'
          el.onloadedmetadata = () => {
            clearTimeout(timer)
            const video = el as HTMLVideoElement
            resolve({
              ...(Number.isFinite(el.duration) ? { duration_s: Math.round(el.duration * 100) / 100 } : {}),
              ...(kind === 'video' && video.videoWidth ? { width: video.videoWidth, height: video.videoHeight } : {}),
            })
          }
          el.onerror = () => {
            clearTimeout(timer)
            resolve({})
          }
          el.src = url
        })
      } finally {
        URL.revokeObjectURL(url)
      }
    }
  } catch {
    // Metadata is optional; the backend validates what it can.
  }
  return {}
}
