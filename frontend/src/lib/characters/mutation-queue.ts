/**
 * A serial queue per key: a task starts when the one before it with the same
 * key has settled (resolved or rejected), so changes to one character reach
 * the server, and their answers reach the cache, in the order they were made.
 * Different keys do not wait for each other.
 */
export interface SerialQueue {
  run: <T>(key: string, task: () => Promise<T>) => Promise<T>
}

export function createSerialQueue(): SerialQueue {
  const tails = new Map<string, Promise<void>>()
  return {
    run: <T,>(key: string, task: () => Promise<T>): Promise<T> => {
      const before = tails.get(key)
      let result: Promise<T>
      if (before) {
        result = before.then(task)
      } else {
        // Nothing queued for this key: start now, as a plain call would.
        try {
          result = task()
        } catch (err) {
          result = Promise.reject(err)
        }
      }
      const tail = result.then(() => undefined, () => undefined)
      tails.set(key, tail)
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key)
      })
      return result
    },
  }
}

/**
 * The new order of one kind after moving `id` by one place among the items
 * that are not locked (locked ones keep their places), or null when it cannot move.
 */
export function movedOrder(ids: readonly string[], id: string, delta: -1 | 1, locked: readonly string[] = []): string[] | null {
  const fixed = new Set(locked)
  const movable = ids.filter((x) => !fixed.has(x))
  const from = movable.indexOf(id)
  const neighbour = movable[from + delta]
  if (from < 0 || !neighbour) return null
  const next = [...ids]
  const a = next.indexOf(id)
  const b = next.indexOf(neighbour)
  ;[next[a], next[b]] = [next[b], next[a]]
  return next
}
