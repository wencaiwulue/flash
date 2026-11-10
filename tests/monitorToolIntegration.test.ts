import { afterEach, expect, test } from 'bun:test'
import { BashTool } from '../src/tools/BashTool/BashTool.tsx'
import { MonitorTool } from '../src/tools/MonitorTool/MonitorTool.ts'
import type { AppState } from '../src/state/AppState.ts'
import { getDefaultAppState } from '../src/state/AppStateStore.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import {
  getCommandQueueSnapshot,
  resetCommandQueue,
} from '../src/utils/messageQueueManager.ts'
import { sleep } from '../src/utils/sleep.ts'

void BashTool

afterEach(() => {
  resetCommandQueue()
})

test('Monitor streams real shell output and completion notifications', async () => {
  resetCommandQueue()
  let appState = getDefaultAppState()
  const setAppState = (update: (previous: AppState) => AppState) => {
    appState = update(appState)
  }
  const context = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState,
    setAppStateForTasks: setAppState,
    toolUseId: 'tool-monitor-test',
  } as unknown as ToolUseContext

  const result = await MonitorTool.call(
    {
      command: "printf 'first\\nsecond\\n'",
      description: 'integration test monitor',
      dangerouslyDisableSandbox: true,
    },
    context,
  )
  const taskId = result.data.task_id
  for (let i = 0; i < 200; i++) {
    if (appState.tasks[taskId]?.status !== 'running') break
    await sleep(10)
  }

  expect(appState.tasks[taskId]?.status).toBe('completed')
  const notifications = getCommandQueueSnapshot().filter(
    command => command.mode === 'task-notification',
  )
  expect(
    notifications.some(command => command.value.includes('first')),
  ).toBe(true)
  expect(
    notifications.some(command => command.value.includes('second')),
  ).toBe(true)
  expect(
    notifications.some(command => command.value.includes('completed')),
  ).toBe(true)
}, 10_000)
