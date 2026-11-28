import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'stream'
import {
  getNext,
  useNotifications,
  type Notification,
} from '../src/context/notifications.tsx'
import { render } from '../src/ink.ts'
import {
  AppStoreContext,
  type AppState,
} from '../src/state/AppState.tsx'
import { getDefaultAppState } from '../src/state/AppStateStore.ts'
import { createStore } from '../src/state/store.ts'
import { collapseBackgroundBashNotifications } from '../src/utils/collapseBackgroundBashNotifications.ts'
import type { RenderableMessage } from '../src/types/message.ts'

let api: ReturnType<typeof useNotifications> | null = null
let store: ReturnType<typeof createStore<AppState>>
let instance: Awaited<ReturnType<typeof render>> | undefined

function Harness(): React.ReactNode {
  api = useNotifications()
  return null
}

beforeEach(async () => {
  api = null
  store = createStore<AppState>(getDefaultAppState())
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    isRaw: boolean
    setRawMode: (value: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.isRaw = false
  stdin.setRawMode = value => {
    stdin.isRaw = value
  }
  stdin.ref = () => {}
  stdin.unref = () => {}
  instance = await render(
    <AppStoreContext.Provider value={store}>
      <Harness />
    </AppStoreContext.Provider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    },
  )
  await new Promise(resolve => setTimeout(resolve, 20))
})

afterEach(async () => {
  instance?.unmount()
  instance = undefined
  await new Promise(resolve => setTimeout(resolve, 140))
})

function note(
  key: string,
  priority: Notification['priority'] = 'medium',
  overrides: Partial<Notification> = {},
): Notification {
  return { key, text: key, priority, timeoutMs: 40, ...overrides }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(predicate()).toBe(true)
}

describe('useNotifications real Ink/AppState queue', () => {
  test('keeps the current notification and drains high before medium priority', async () => {
    api!.addNotification(note('low', 'low'))
    api!.addNotification(note('high', 'high'))
    api!.addNotification(note('medium', 'medium'))

    expect(store.getState().notifications.current?.key).toBe('low')
    expect(store.getState().notifications.queue.map(item => item.key)).toEqual([
      'high',
      'medium',
    ])
    await waitFor(() => store.getState().notifications.current?.key === 'high')
    await waitFor(() => store.getState().notifications.current?.key === 'medium')
    await waitFor(() => store.getState().notifications.current === null)
    expect(store.getState().notifications.queue).toEqual([])
  })

  test('immediate preempts and requeues the non-immediate current notification', async () => {
    api!.addNotification(note('ordinary', 'high', { timeoutMs: 100 }))
    api!.addNotification(note('urgent', 'immediate', { timeoutMs: 30 }))

    expect(store.getState().notifications.current?.key).toBe('urgent')
    expect(store.getState().notifications.queue.map(item => item.key)).toEqual([
      'ordinary',
    ])
    await waitFor(() => store.getState().notifications.current?.key === 'ordinary')
  })

  test('folds into both current and queued notifications without duplicates', async () => {
    const fold = (accumulator: Notification, incoming: Notification) => ({
      ...incoming,
      text: `${accumulator.text}+${incoming.text}`,
    })
    api!.addNotification(note('current', 'high', { fold }))
    api!.addNotification(note('current', 'high', { fold }))
    expect(store.getState().notifications.current?.text).toBe('current+current')

    api!.addNotification(note('queued', 'low', { fold }))
    api!.addNotification(note('queued', 'low', { fold }))
    expect(store.getState().notifications.queue).toHaveLength(1)
    expect(store.getState().notifications.queue[0]?.text).toBe('queued+queued')
  })

  test('invalidates current and queued notifications for normal and immediate arrivals', async () => {
    api!.addNotification(note('stale', 'high'))
    api!.addNotification(note('fresh', 'high', { invalidates: ['stale'] }))
    expect(store.getState().notifications.current?.key).toBe('fresh')
    expect(store.getState().notifications.queue.map(item => item.key)).not.toContain(
      'stale',
    )

    api!.addNotification(
      note('urgent', 'immediate', { invalidates: ['fresh'] }),
    )
    expect(store.getState().notifications.current?.key).toBe('urgent')
    expect(store.getState().notifications.queue.map(item => item.key)).not.toContain(
      'fresh',
    )
  })

  test('removeNotification clears current and queued entries and advances the queue', async () => {
    api!.addNotification(note('first', 'high'))
    api!.addNotification(note('second', 'high'))

    api!.removeNotification('first')
    expect(store.getState().notifications.current?.key).toBe('second')
    api!.removeNotification('second')
    expect(store.getState().notifications.current).toBeNull()
    expect(store.getState().notifications.queue).toEqual([])
  })

  test('getNext preserves insertion order for equal priorities and handles empty queues', () => {
    expect(getNext([])).toBeUndefined()
    expect(getNext([note('first'), note('second')])?.key).toBe('first')
    expect(getNext([note('low', 'low'), note('high', 'high')])?.key).toBe(
      'high',
    )
  })
})

function taskNotification(status: string, summary: string): RenderableMessage {
  return {
    type: 'user',
    uuid: `${status}-${summary}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<task-notification><status>${status}</status><summary>${summary}</summary></task-notification>`,
        },
      ],
    },
  } as unknown as RenderableMessage
}

describe('background notification collapse', () => {
  const originalFlicker = process.env.CLAUDE_CODE_NO_FLICKER

  afterEach(() => {
    if (originalFlicker === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
    else process.env.CLAUDE_CODE_NO_FLICKER = originalFlicker
  })

  test('collapses only consecutive completed bash notifications and preserves failures', () => {
    process.env.CLAUDE_CODE_NO_FLICKER = '1'
    const completed = (name: string) =>
      taskNotification('completed', `Background command ${name}`)
    const messages = [
      completed('one'),
      completed('two'),
      completed('three'),
      taskNotification('failed', 'Background command failed'),
      completed('four'),
      completed('five'),
    ]

    const collapsed = collapseBackgroundBashNotifications(messages, false)
    expect(collapsed).toHaveLength(3)
    expect(collapsed[0]?.message.content[0]).toMatchObject({
      type: 'text',
      text: '<task-notification><status>completed</status><summary>3 background commands completed</summary></task-notification>',
    })
    expect(collapsed[1]).toBe(messages[3])
    expect(collapsed[2]?.message.content[0]).toMatchObject({
      type: 'text',
      text: '<task-notification><status>completed</status><summary>2 background commands completed</summary></task-notification>',
    })
  })

  test('verbose and fullscreen-disabled modes preserve the original messages', () => {
    process.env.CLAUDE_CODE_NO_FLICKER = '1'
    const messages = [taskNotification('completed', 'Background command one')]
    expect(collapseBackgroundBashNotifications(messages, true)).toBe(messages)

    process.env.CLAUDE_CODE_NO_FLICKER = '0'
    expect(collapseBackgroundBashNotifications(messages, false)).toBe(messages)
  })
})
