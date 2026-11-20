'use client'

/**
 * The history of a viewer block (Image, Video and Audio Viewer): every output
 * the viewer was shown, in order, without repeats.
 *
 * - A new upstream output (a different list of URLs) appends the URLs not
 *   shown yet and selects the newest. The same output again, on any later
 *   render, adds nothing; nor does the input going empty. Loop iterations and
 *   iterator items are new outputs, so they accumulate.
 * - Clear empties the history and hides the current output until a new
 *   output arrives, which then starts the history on its own.
 * - Before the first output is recorded, the current output is shown.
 * - At most `MAX_VIEWER_HISTORY` outputs are kept, the oldest dropped, so a
 *   Loop that runs overnight cannot grow it without bound.
 * - The strip renders only the latest `revealed` entries (one
 *   `VIEWER_STRIP_PAGE` at first); Show older reveals one more page. Clear
 *   goes back to one page.
 */
import { useCallback, useEffect, useMemo, useReducer } from 'react'

/** Entries the strip shows at first, and how many more each Show older reveals. */
export const VIEWER_STRIP_PAGE = 30
/** Outputs a viewer keeps; older ones are dropped. */
export const MAX_VIEWER_HISTORY = 200

export interface ViewerHistoryState {
  history: string[]
  /** The last output seen, as its URLs joined; empty before the first. */
  lastKey: string
  /** Clear was pressed and no new output has arrived since. */
  cleared: boolean
  selected: number
  /** How many of the latest entries the strip renders (at least one page). */
  revealed: number
}

export type ViewerHistoryAction =
  | { type: 'output'; urls: readonly string[] }
  | { type: 'clear' }
  | { type: 'select'; index: number }
  | { type: 'show_older' }

export const INITIAL_VIEWER_HISTORY: ViewerHistoryState = {
  history: [], lastKey: '', cleared: false, selected: 0, revealed: VIEWER_STRIP_PAGE,
}

function outputKey(urls: readonly string[]): string {
  return urls.join('\n')
}

export function viewerHistoryReducer(state: ViewerHistoryState, action: ViewerHistoryAction): ViewerHistoryState {
  switch (action.type) {
    case 'output': {
      const key = outputKey(action.urls)
      if (!key || key === state.lastKey) return state
      const fresh = action.urls.filter((u) => !state.history.includes(u))
      if (fresh.length === 0) return { ...state, lastKey: key }
      const history = [...state.history, ...fresh].slice(-MAX_VIEWER_HISTORY)
      return { ...state, history, lastKey: key, cleared: false, selected: history.length - 1 }
    }
    case 'clear':
      return { ...state, history: [], cleared: true, selected: 0, revealed: VIEWER_STRIP_PAGE }
    case 'select':
      return { ...state, selected: action.index }
    case 'show_older': {
      if (state.revealed >= state.history.length) return state
      return { ...state, revealed: Math.min(state.revealed + VIEWER_STRIP_PAGE, state.history.length) }
    }
  }
}

export interface ViewerHistory {
  /** Every output recorded since the last Clear. */
  history: string[]
  /** What the viewer shows: the history, else the current output, or nothing after Clear. */
  displayUrls: string[]
  /** The selected position, always within `displayUrls` (0 when empty). */
  selectedIndex: number
  select: (index: number) => void
  clear: () => void
  /** Index in `displayUrls` of the first entry the strip renders. */
  stripStart: number
  /** Older entries the strip does not render (`stripStart`); Show older reveals them. */
  hiddenOlder: number
  showOlder: () => void
}

export function useViewerHistory(currentUrls: readonly string[]): ViewerHistory {
  const [state, dispatch] = useReducer(viewerHistoryReducer, INITIAL_VIEWER_HISTORY)
  // Keyed by content, so a new array with the same URLs does not re-run it.
  const key = outputKey(currentUrls)
  useEffect(() => {
    dispatch({ type: 'output', urls: key ? key.split('\n') : [] })
  }, [key])

  const current = useMemo(() => (key ? key.split('\n') : []), [key])
  const displayUrls = state.cleared ? [] : state.history.length > 0 ? state.history : current
  const selectedIndex = displayUrls.length === 0 ? 0 : Math.min(Math.max(0, state.selected), displayUrls.length - 1)
  const select = useCallback((index: number) => dispatch({ type: 'select', index }), [])
  const clear = useCallback(() => dispatch({ type: 'clear' }), [])
  const showOlder = useCallback(() => dispatch({ type: 'show_older' }), [])
  const stripStart = Math.max(0, displayUrls.length - Math.max(state.revealed, VIEWER_STRIP_PAGE))
  return {
    history: state.history, displayUrls, selectedIndex, select, clear, stripStart, hiddenOlder: stripStart, showOlder,
  }
}
