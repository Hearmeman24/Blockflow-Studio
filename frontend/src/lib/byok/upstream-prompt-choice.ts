/**
 * The generation blocks' "Use the upstream prompt" switch follows the
 * upstream prompt source on its edges only:
 *
 *   had source -> has source   switch
 *   no  -> yes                 on
 *   yes -> no                  off
 *   no  -> no, yes -> yes      unchanged (a choice the user made is kept)
 *
 * The block remembers which source state it last acted on ("seen"). At mount
 * that is the current source when a choice was stored (a reload or a loaded
 * flow: the choice was made with that source), otherwise "no source", so a
 * source already wired when the block is added turns the switch on.
 */

/** The switch after the source changed from `hadSource` to `hasSource`; `current` is the switch now. */
export function nextUpstreamChoice(current: boolean, hadSource: boolean, hasSource: boolean): boolean {
  return hadSource === hasSource ? current : hasSource
}

/** The source state the block counts as already seen when it mounts. */
export function initialSeenSource(hadStoredChoice: boolean, hasSource: boolean): boolean {
  return hadStoredChoice ? hasSource : false
}
