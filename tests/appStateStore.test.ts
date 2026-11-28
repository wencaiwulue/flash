import { describe, expect, test } from 'bun:test'
import { createStore } from '../src/state/store'

describe('createStore', () => {
  test('nested setState is delivered once in FIFO order without recursion overflow', () => {
    const store = createStore(0)
    const seen: number[] = []
    store.subscribe(() => {
      seen.push(store.getState())
      if (store.getState() < 2) {
        store.setState((value) => value + 1)
      }
    })
    store.setState((value) => value + 1)
    expect(seen).toEqual([1, 2])
  })

  test('multiple nested setStates are processed in order', () => {
    const store = createStore({ count: 0, log: [] as string[] })
    const seen: typeof store['state'][] = []
    store.subscribe(() => {
      seen.push({ ...store.getState() })
      const state = store.getState()
      if (state.count < 3) {
        store.setState((prev) => ({
          ...prev,
          count: prev.count + 1,
          log: [...prev.log, `increment to ${prev.count + 1}`],
        }))
      }
    })
    store.setState((prev) => ({ ...prev, count: 1, log: [...prev.log, 'initial'] }))
    expect(seen).toHaveLength(3)
    expect(seen[0]).toEqual({ count: 1, log: ['initial'] })
    expect(seen[1]).toEqual({ count: 2, log: ['initial', 'increment to 2'] })
    expect(seen[2]).toEqual({ count: 3, log: ['initial', 'increment to 2', 'increment to 3'] })
  })

  test('unsubscribe works correctly during notification', () => {
    const store = createStore(0)
    const seen1: number[] = []
    const seen2: number[] = []
    const unsubscribe1 = store.subscribe(() => seen1.push(store.getState()))
    const unsubscribe2 = store.subscribe(() => {
      seen2.push(store.getState())
      unsubscribe1()
    })
    store.setState((v) => v + 1)
    expect(seen1).toEqual([1])
    expect(seen2).toEqual([1])
    // First subscriber should be unsubscribed now
    store.setState((v) => v + 1)
    expect(seen1).toEqual([1]) // No change
    expect(seen2).toEqual([1, 2])
  })

  test('state updates correctly without reentrancy issues', () => {
    const store = createStore(0)
    // Subscribe twice to verify both get all notifications
    const seenA: number[] = []
    const seenB: number[] = []
    store.subscribe(() => seenA.push(store.getState()))
    store.subscribe(() => {
      seenB.push(store.getState())
      // Nested update
      if (store.getState() === 1) {
        store.setState((v) => v + 1)
      }
    })
    store.setState((v) => v + 1)
    expect(seenA).toEqual([1, 2])
    expect(seenB).toEqual([1, 2])
  })
})
