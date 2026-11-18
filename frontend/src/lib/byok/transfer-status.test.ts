import { describe, expect, it } from 'vitest'
import { restoreTransferStatus } from './transfer-status'
import { restoreLoaderItems } from './loader-items'
import { restoreReferences } from './references'

describe('restoreTransferStatus', () => {
  it('keeps ready and error, and ends a transfer that was in flight as interrupted', () => {
    expect(restoreTransferStatus('ready', 'saving')).toBe('ready')
    expect(restoreTransferStatus('error', 'saving')).toBe('error')
    expect(restoreTransferStatus('saving', 'saving')).toBe('interrupted')
    expect(restoreTransferStatus('uploading', 'uploading')).toBe('interrupted')
  })

  it('reads only its own in-flight spelling, and nothing else', () => {
    expect(restoreTransferStatus('uploading', 'saving')).toBeUndefined()
    expect(restoreTransferStatus('saving', 'uploading')).toBeUndefined()
    expect(restoreTransferStatus(undefined, 'saving')).toBeUndefined()
    expect(restoreTransferStatus('READY', 'saving')).toBeUndefined()
    expect(restoreTransferStatus(1, 'saving')).toBeUndefined()
  })
})

describe('both restore paths use it', () => {
  it('a loader item: unknown or missing reads as ready; an interrupted save is an error', () => {
    const [a, b, c] = restoreLoaderItems([
      { id: 'a', label: 'a.png', local: '/outputs/a.png' },
      { id: 'b', label: 'b.png', local: '/outputs/b.png', status: 'uploading' },
      { id: 'c', label: 'c.png', status: 'saving' },
    ])
    expect(a.status).toBe('ready')
    expect(b.status).toBe('ready')
    expect(c).toEqual({ id: 'c', label: 'c.png', status: 'error', error: 'Saving this file was interrupted. Replace it or add it again.' })
  })

  it('a legacy reference: unknown or missing stays unset; an interrupted upload is an error', () => {
    const [a, b, c] = restoreReferences([
      { id: 'a', kind: 'image', local: '/outputs/a.png' },
      { id: 'b', kind: 'image', local: '/outputs/b.png', status: 'saving' },
      { id: 'c', kind: 'image', status: 'uploading' },
    ])
    expect(a.status).toBeUndefined()
    expect(b.status).toBeUndefined()
    expect(c.status).toBe('error')
    expect(c.error).toBe('The upload was interrupted. Remove this reference and add the file again.')
  })
})
