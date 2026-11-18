/**
 * What one loader item shows, from its three independent axes: the save
 * (`LoaderItem.status`), the reference check (`ReferenceHealth`, read only for
 * a saved item) and the downstream limit (`ItemFlag`). The priority is written
 * once, here:
 *
 *   saving > not saved > broken > flagged > not verified > ok
 *
 * The tile strip shows exactly this state. The run blockers and the run check
 * read it to tell unsaved and broken items apart; a limit flag can block a run
 * on its own as well, so the blockers still read `flag` for that.
 */
import type { ItemFlag, ItemFlagStatus, LoaderItem } from './loader-items'
import { isBrokenStatus, type ReferenceHealth } from './reference-health'

/** A flag that marks a problem (anything but `ok`). */
export type RaisedFlag = ItemFlag & { status: Exclude<ItemFlagStatus, 'ok'> }

export type ItemDisplayState =
  | { kind: 'saving' }
  | { kind: 'not_saved'; detail: string | null }
  | { kind: 'broken'; health: ReferenceHealth }
  | { kind: 'flagged'; flag: RaisedFlag }
  | { kind: 'unverified'; detail: string }
  | { kind: 'ok' }

export type ItemDisplayKind = ItemDisplayState['kind']

export function itemDisplayState(
  item: Pick<LoaderItem, 'status' | 'error'>,
  health: ReferenceHealth | undefined,
  flag?: ItemFlag,
): ItemDisplayState {
  if (item.status === 'saving') return { kind: 'saving' }
  if (item.status === 'error') return { kind: 'not_saved', detail: item.error ?? null }
  if (health && isBrokenStatus(health.status)) return { kind: 'broken', health }
  if (flag && flag.status !== 'ok') return { kind: 'flagged', flag: flag as RaisedFlag }
  if (health?.status === 'unchecked') return { kind: 'unverified', detail: health.detail }
  return { kind: 'ok' }
}
