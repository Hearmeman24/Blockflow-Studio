/**
 * Loop mode of one pipeline tab, as one declared state.
 *
 *   state \ event       start            runEnded(ok)        runEnded(error)  restart           stop | runCancelled
 *   off                 looping(1, run)  -                   -                -                 -
 *   looping(n, run)     -                looping(n, restart) off              -                 off
 *   looping(n, restart) -                -                   -                looping(n+1, run) off
 *
 * `runCancelled` comes from the tab's run phase whenever its run is cancelled,
 * whoever cancelled it, so a cancel always stops the loop.
 */

export type LoopState =
  | { kind: 'off' }
  | { kind: 'looping'; iteration: number; awaiting: 'run' | 'restart' }

export type LoopEvent =
  | { type: 'start' }
  | { type: 'runEnded'; hadError: boolean }
  | { type: 'restart' }
  | { type: 'stop' }
  | { type: 'runCancelled' }

export const LOOP_OFF: LoopState = { kind: 'off' }

function unreachable(value: never): never {
  throw new Error(`Unknown loop event: ${JSON.stringify(value)}`)
}

/** The next loop state; returns `state` itself when the event does not apply. */
export function transitionLoop(state: LoopState, event: LoopEvent): LoopState {
  switch (event.type) {
    case 'start':
      return state.kind === 'off' ? { kind: 'looping', iteration: 1, awaiting: 'run' } : state
    case 'runEnded':
      if (state.kind !== 'looping' || state.awaiting !== 'run') return state
      return event.hadError ? LOOP_OFF : { ...state, awaiting: 'restart' }
    case 'restart':
      if (state.kind !== 'looping' || state.awaiting !== 'restart') return state
      return { kind: 'looping', iteration: state.iteration + 1, awaiting: 'run' }
    case 'stop':
    case 'runCancelled':
      return state.kind === 'off' ? state : LOOP_OFF
    default:
      return unreachable(event)
  }
}

/** Whether the tab's last loop run ended and the next one is due. */
export function needsRestart(state: LoopState): boolean {
  return state.kind === 'looping' && state.awaiting === 'restart'
}

export function loopIteration(state: LoopState): number | null {
  return state.kind === 'looping' ? state.iteration : null
}
