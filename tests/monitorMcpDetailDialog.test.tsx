import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import { MonitorMcpDetailDialog } from '../src/components/tasks/MonitorMcpDetailDialog.tsx'
import { render } from '../src/ink.ts'
import { createTaskStateBase } from '../src/Task.ts'
import type { MonitorMcpTaskState } from '../src/tasks/MonitorMcpTask/MonitorMcpTask.ts'
import { sleep } from '../src/utils/sleep.ts'
import {
  appendTaskOutput,
  cleanupTaskOutput,
  flushTaskOutput,
} from '../src/utils/task/diskOutput.ts'

function task(
  overrides: Partial<MonitorMcpTaskState> = {},
): MonitorMcpTaskState {
  return {
    ...createTaskStateBase('m-local-id', 'monitor_mcp', 'MCP monitor'),
    type: 'monitor_mcp',
    status: 'running',
    serverName: 'tasks-server',
    toolName: 'long-running-tool',
    remoteTaskId: 'remote-task-id-that-is-not-the-local-id',
    remoteStatus: 'working',
    cancelRequested: false,
    lastRemoteUpdateAt: Date.parse('2026-11-11T01:02:03.000Z'),
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

async function mountDialog(
  initialTask: MonitorMcpTaskState,
  onKill: () => Promise<boolean> = () => Promise.resolve(false),
  onBack: () => void = () => {},
) {
  const stdout = new PassThrough()
  Object.assign(stdout, { columns: 120, rows: 40 })
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (value: boolean) => void
    ref: () => void
    unref: () => void
  }
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => {},
    ref: () => {},
    unref: () => {},
  })
  let output = ''
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  let current = initialTask
  const element = () => (
    <MonitorMcpDetailDialog task={current} onKill={onKill} onBack={onBack} />
  )
  const instance = await render(element(), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  await sleep(30)

  return {
    text: () => stripAnsi(output),
    clear: () => {
      output = ''
    },
    press: async (value: string) => {
      output = ''
      stdin.write(value)
      await sleep(30)
    },
    rerender: async (next: MonitorMcpTaskState) => {
      current = next
      output = ''
      instance.rerender(element())
      await sleep(30)
    },
    unmount: () => {
      instance.unmount()
      instance.cleanup()
    },
  }
}

test('shows real local and remote identity, status, update time, and cancel action', async () => {
  const dialog = await mountDialog(task())
  try {
    const output = dialog.text()
    expect(output).toContain('MCP task monitor')
    expect(output).toContain('m-local-id')
    expect(output).toContain('tasks-server / long-running-tool')
    expect(output).toContain('remote-task-id-that-is-not-the-local-id')
    expect(output).toContain('working')
    expect(output).toContain('2026-11-11T01:02:03.000Z')
    expect(output).toContain('x to request cancellation')
  } finally {
    dialog.unmount()
  }
})

test('shows waiting, retryable failure, and confirmed cancellation distinctly', async () => {
  const dialog = await mountDialog(task({ cancelRequested: true }))
  try {
    expect(dialog.text()).toContain('waiting for server confirmation')
    expect(dialog.text()).not.toContain('x to request cancellation')
    expect(dialog.text()).not.toContain('x to retry cancellation')

    await dialog.rerender(
      task({ cancelRequested: true, error: 'request timed out' }),
    )
    expect(dialog.text()).toContain('Cancellation was not confirmed')
    expect(dialog.text()).toContain('request timed out')
    expect(dialog.text()).toContain('x to retry cancellation')
    expect(dialog.text()).not.toContain('Remote task cancelled')

    await dialog.rerender(
      task({
        status: 'killed',
        remoteStatus: 'cancelled',
        cancelRequested: true,
        endTime: Date.now(),
      }),
    )
    expect(dialog.text()).toContain('Remote task cancelled')
    expect(dialog.text()).not.toContain('request cancellation')
    expect(dialog.text()).not.toContain('retry cancellation')
  } finally {
    dialog.unmount()
  }
})

test('bounds recent output to the latest ten lines', async () => {
  appendTaskOutput(
    'm-local-id',
    Array.from({ length: 20 }, (_, index) => `output-line-${index}`).join('\n'),
  )
  await flushTaskOutput('m-local-id')
  const dialog = await mountDialog(task())
  try {
    await dialog.rerender(task({ lastRemoteUpdateAt: Date.now() }))
    for (let attempt = 0; attempt < 40 && !dialog.text().includes('output-line-19'); attempt++) {
      await sleep(25)
    }
    expect(dialog.text()).toContain('output-line-19')
    expect(dialog.text()).toContain('output-line-10')
    expect(dialog.text()).not.toContain('output-line-0\n')
    expect(dialog.text()).toContain('Showing the latest 10 lines')
  } finally {
    dialog.unmount()
    await cleanupTaskOutput('m-local-id')
  }
})

test('keyboard cancellation deduplicates, retries failure, and close has no kill side effect', async () => {
  const firstResponse = deferred<boolean>()
  let killCalls = 0
  let backCalls = 0
  const dialog = await mountDialog(
    task(),
    () => {
      killCalls++
      return killCalls === 1 ? firstResponse.promise : Promise.resolve(true)
    },
    () => {
      backCalls++
    },
  )

  try {
    await dialog.press('x')
    await dialog.press('x')
    expect(killCalls).toBe(1)

    await dialog.rerender(task({ cancelRequested: true }))
    expect(dialog.text()).toContain('waiting for server confirmation')
    firstResponse.resolve(false)
    await sleep(30)
    await dialog.rerender(task({ cancelRequested: true, error: 'still working' }))
    expect(dialog.text()).toContain('Cancellation was not confirmed')

    await dialog.press('x')
    expect(killCalls).toBe(2)
    await dialog.rerender(
      task({
        status: 'killed',
        remoteStatus: 'cancelled',
        cancelRequested: true,
      }),
    )
    expect(dialog.text()).toContain('Remote task cancelled')

    await dialog.press('x')
    expect(killCalls).toBe(2)
    await dialog.press('\x1b[D')
    expect(backCalls).toBe(1)
    expect(killCalls).toBe(2)
  } finally {
    firstResponse.resolve(false)
    dialog.unmount()
  }
})
