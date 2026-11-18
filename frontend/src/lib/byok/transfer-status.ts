/**
 * The stored lifecycle of a file being moved into the app: in flight, then
 * `ready` or `error`. Loader items (`LoaderItem.status`) spell the in-flight
 * state `saving`; the legacy in-block references (`GenerationReference.status`,
 * read only from old flows and the `block_<id>_references` session key) spell
 * it `uploading`. Both stored spellings stay as they are.
 *
 * A transfer cannot survive a reload, so a restored in-flight state is
 * `interrupted`; each caller turns that into `error` with its own message.
 */
export type TransferInFlight = 'saving' | 'uploading'

export type RestoredTransfer = 'ready' | 'error' | 'interrupted'

/** The restored state of a stored status, or undefined when it is not one of the three. */
export function restoreTransferStatus(raw: unknown, inFlight: TransferInFlight): RestoredTransfer | undefined {
  if (raw === 'ready' || raw === 'error') return raw
  if (raw === inFlight) return 'interrupted'
  return undefined
}
