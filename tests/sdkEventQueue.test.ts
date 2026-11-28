import { expect, test } from 'bun:test'
import {
  enqueueSdkEvent,
  drainSdkEvents,
  emitTaskTerminatedSdk,
  resetSdkEventQueueForTests,
  type SdkEvent,
} from '../src/utils/sdkEventQueue'
import {
  setIsInteractive,
  resetStateForTests,
  getSessionId,
} from '../src/bootstrap/state'
import { startSdkMemoryMonitor } from '../src/utils/sdkHeapDumpMonitor.ts'

function resetQueueState() {
  resetSdkEventQueueForTests()
  resetStateForTests()
}

test('sdkEventQueue: FIFO ordering', () => {
  resetQueueState()
  setIsInteractive(false) // Non-interactive to enable queueing

  // Queue events in order
  const event1: SdkEvent = {
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-1',
    description: 'Task 1',
  }
  const event2: SdkEvent = {
    type: 'system',
    subtype: 'task_progress',
    task_id: 'task-1',
    description: 'Progress',
    usage: { total_tokens: 100, tool_uses: 1, duration_ms: 500 },
  }
  const event3: SdkEvent = {
    type: 'system',
    subtype: 'session_state_changed',
    state: 'idle',
  }

  enqueueSdkEvent(event1)
  enqueueSdkEvent(event2)
  enqueueSdkEvent(event3)

  // Drain and verify order
  const drained = drainSdkEvents()
  expect(drained.length).toBe(3)
  expect(drained[0].subtype).toBe('task_started')
  expect(drained[1].subtype).toBe('task_progress')
  expect(drained[2].subtype).toBe('session_state_changed')
})

test('sdkEventQueue: does not queue in interactive mode', () => {
  resetQueueState()
  setIsInteractive(true) // Interactive mode

  const event: SdkEvent = {
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-1',
    description: 'Task 1',
  }

  enqueueSdkEvent(event)

  // Drain should get nothing
  const drained = drainSdkEvents()
  expect(drained.length).toBe(0)
})

test('sdkEventQueue: bounded backpressure - drops oldest when full', () => {
  resetQueueState()
  setIsInteractive(false)

  // Queue 1001 events to exceed MAX_QUEUE_SIZE of 1000
  for (let i = 0; i < 1001; i++) {
    enqueueSdkEvent({
      type: 'system',
      subtype: 'task_started',
      task_id: `task-${i}`,
      description: `Task ${i}`,
    })
  }

  const drained = drainSdkEvents()
  expect(drained.length).toBe(1000)

  // Oldest event (task-0) should be dropped
  expect(drained[0].task_id).toBe('task-1')
  expect(drained[999].task_id).toBe('task-1000')
})

test('sdkEventQueue: drain empties the queue', () => {
  resetQueueState()
  setIsInteractive(false)

  // Queue some events
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-1',
    description: 'Task 1',
  })
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-2',
    description: 'Task 2',
  })

  // First drain gets them
  const drained1 = drainSdkEvents()
  expect(drained1.length).toBe(2)

  // Second drain gets nothing
  const drained2 = drainSdkEvents()
  expect(drained2.length).toBe(0)
})

test('sdkEventQueue: adds uuid and sessionId to drained events', () => {
  resetQueueState()
  setIsInteractive(false)

  const event: SdkEvent = {
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-1',
    description: 'Task 1',
  }

  enqueueSdkEvent(event)

  const drained = drainSdkEvents()
  expect(drained.length).toBe(1)
  expect(drained[0].uuid).toBeDefined()
  expect(typeof drained[0].uuid).toBe('string')
  expect(drained[0].session_id).toBe(getSessionId())
})

test('sdkEventQueue: each drain gets new uuids', () => {
  resetQueueState()
  setIsInteractive(false)

  // Queue and drain twice
  const event: SdkEvent = {
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-1',
    description: 'Task 1',
  }

  enqueueSdkEvent(event)
  const drained1 = drainSdkEvents()
  const uuid1 = drained1[0].uuid

  enqueueSdkEvent(event)
  const drained2 = drainSdkEvents()
  const uuid2 = drained2[0].uuid

  expect(uuid1).not.toBe(uuid2)
})

test('sdkEventQueue: emitTaskTerminatedSdk enqueues correctly', () => {
  resetQueueState()
  setIsInteractive(false)

  emitTaskTerminatedSdk('task-123', 'completed', {
    toolUseId: 'tool-456',
    summary: 'Done',
    outputFile: '/path/to/output',
    usage: { total_tokens: 1000, tool_uses: 5, duration_ms: 2000 },
  })

  const drained = drainSdkEvents()
  expect(drained.length).toBe(1)
  expect(drained[0].subtype).toBe('task_notification')
  expect(drained[0].task_id).toBe('task-123')
  expect(drained[0].status).toBe('completed')
  expect(drained[0].tool_use_id).toBe('tool-456')
  expect(drained[0].summary).toBe('Done')
  expect(drained[0].output_file).toBe('/path/to/output')
  expect(drained[0].usage).toEqual({
    total_tokens: 1000,
    tool_uses: 5,
    duration_ms: 2000,
  })
})

test('sdkEventQueue: emitTaskTerminatedSdk optional params', () => {
  resetQueueState()
  setIsInteractive(false)

  emitTaskTerminatedSdk('task-456', 'failed')

  const drained = drainSdkEvents()
  expect(drained.length).toBe(1)
  expect(drained[0].subtype).toBe('task_notification')
  expect(drained[0].task_id).toBe('task-456')
  expect(drained[0].status).toBe('failed')
  expect(drained[0].tool_use_id).toBeUndefined()
  expect(drained[0].summary).toBe('')
  expect(drained[0].output_file).toBe('')
  expect(drained[0].usage).toBeUndefined()
})

test('sdkHeapDumpMonitor remains explicitly disabled in the external build', () => {
  const first = startSdkMemoryMonitor()
  const second = startSdkMemoryMonitor()

  expect(first).toEqual({ enabled: false })
  expect(second).toEqual(first)
})

test('sdkEventQueue: can queue all event types', () => {
  resetQueueState()
  setIsInteractive(false)

  // Task started
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_started',
    task_id: 't1',
    description: 'Start',
    workflow_name: 'test',
    tool_use_id: 'tool-1',
    prompt: 'prompt',
  })

  // Task progress
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_progress',
    task_id: 't1',
    description: 'Progress',
    usage: { total_tokens: 10, tool_uses: 1, duration_ms: 100 },
    last_tool_name: 'edit',
    summary: '...',
    workflow_progress: [],
  })

  // Task notification
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_notification',
    task_id: 't1',
    status: 'completed',
    output_file: '',
    summary: '',
  })

  // Session state changed
  enqueueSdkEvent({
    type: 'system',
    subtype: 'session_state_changed',
    state: 'idle',
  })

  const drained = drainSdkEvents()
  expect(drained.length).toBe(4)
  expect(drained[0].subtype).toBe('task_started')
  expect(drained[1].subtype).toBe('task_progress')
  expect(drained[2].subtype).toBe('task_notification')
  expect(drained[3].subtype).toBe('session_state_changed')
})
