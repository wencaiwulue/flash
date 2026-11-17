type Listener = () => void
type OnChange<T> = (args: { newState: T; oldState: T }) => void

export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()
  let isNotifying = false
  const updateQueue: Array<(prev: T) => T> = []

  const flushQueue = () => {
    while (updateQueue.length > 0) {
      const updater = updateQueue.shift()!
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) continue
      state = next
      onChange?.({ newState: next, oldState: prev })
      // Make a copy of listeners to handle unsubscribes during iteration
      for (const listener of [...listeners]) listener()
    }
  }

  return {
    getState: () => state,

    setState: (updater: (prev: T) => T) => {
      if (isNotifying) {
        updateQueue.push(updater)
        return
      }
      isNotifying = true
      try {
        const prev = state
        const next = updater(prev)
        if (Object.is(next, prev)) return
        state = next
        onChange?.({ newState: next, oldState: prev })
        // Make a copy of listeners to handle unsubscribes during iteration
        for (const listener of [...listeners]) listener()
        flushQueue()
      } finally {
        isNotifying = false
      }
    },

    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
