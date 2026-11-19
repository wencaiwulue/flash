import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createTaskStateBase,
  generateTaskId,
  isTerminalTaskStatus,
  type TaskType,
} from '../src/Task.ts'
import {
  applyTaskOffsetsAndEvictions,
  evictTerminalTask,
  generateTaskAttachments,
  getRunningTasks,
  pollTasks,
  registerTask,
  updateTaskState,
} from '../src/utils/task/framework.ts'
import {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
  appendTaskOutput,
  cleanupTaskOutput,
  evictTaskOutput,
  flushTaskOutput,
  getTaskOutput,
  getTaskOutputDelta,
  getTaskOutputPath,
  getTaskOutputSize,
  initTaskOutput,
} from '../src/utils/task/diskOutput.ts'
import { getDefaultAppState } from '../src/state/AppStateStore.ts'
import { drainSdkEvents, resetSdkEventQueueForTests } from '../src/utils/sdkEventQueue.ts'
import type { LocalShellTaskState } from '../src/tasks/LocalShellTask/guards.ts'

const actualBootstrap = await import('../src/bootstrap/state.ts')
mock.module('../src/bootstrap/state.ts', () => ({
  ...actualBootstrap,
  getIsNonInteractiveSession: () => true,
}))

const originalTempDir = process.env.CLAUDE_CODE_TMPDIR
let tempRoot = ''

function setup() {
  tempRoot = mkdtempSync(join(tmpdir(), 'task-framework-'))
  process.env.CLAUDE_CODE_TMPDIR = tempRoot
  _resetTaskOutputDirForTest()
  resetSdkEventQueueForTests()
}

afterEach(async () => {
  await _clearOutputsForTest()
  _resetTaskOutputDirForTest()
  resetSdkEventQueueForTests()
  if (originalTempDir === undefined) delete process.env.CLAUDE_CODE_TMPDIR
  else process.env.CLAUDE_CODE_TMPDIR = originalTempDir
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

function shellTask(id: string, overrides: Partial<LocalShellTaskState> = {}): LocalShellTaskState {
  return {
    ...createTaskStateBase(id, 'local_bash', 'test task', `tool-${id}`),
    command: 'echo test',
    completionStatusSentInAttachment: false,
    shellCommand: null,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    ...overrides,
  }
}

describe('task core and framework registration', () => {
  test('generates typed IDs and terminal states', () => {
    setup()
    const types: Array<[TaskType, string]> = [
      ['local_bash', 'b'],
      ['local_agent', 'a'],
      ['remote_agent', 'r'],
      ['in_process_teammate', 't'],
      ['local_workflow', 'w'],
      ['monitor_mcp', 'm'],
      ['dream', 'd'],
    ]
    for (const [type, prefix] of types) {
      expect(generateTaskId(type)).toMatch(new RegExp(`^${prefix}[0-9a-z]{8}$`))
    }
    expect(isTerminalTaskStatus('completed')).toBe(true)
    expect(isTerminalTaskStatus('failed')).toBe(true)
    expect(isTerminalTaskStatus('killed')).toBe(true)
    expect(isTerminalTaskStatus('running')).toBe(false)
    expect(isTerminalTaskStatus('pending')).toBe(false)
    const base = createTaskStateBase('b12345678', 'local_bash', 'demo')
    expect(base.status).toBe('pending')
    expect(base.outputOffset).toBe(0)
    expect(base.notified).toBe(false)
    expect(base.outputFile).toContain('b12345678.output')
  })

  test('registers, updates and preserves resume UI state without double task_started', () => {
    setup()
    const state = getDefaultAppState()
    const setAppState = (update: (previous: typeof state) => typeof state) => {
      Object.assign(state, update(state))
    }
    const task = shellTask('b0000001')
    registerTask(task, setAppState)
    expect(state.tasks.b0000001?.id).toBe('b0000001')
    expect(drainSdkEvents().filter(event => event.subtype === 'task_started')).toHaveLength(1)

    const original = state.tasks.b0000001!
    const unchanged = updateTaskState('b0000001', setAppState, task => task)
    expect(unchanged).toBeUndefined()
    expect(state.tasks.b0000001).toBe(original)

    updateTaskState('b0000001', setAppState, task => ({ ...task, status: 'running' }))
    expect(state.tasks.b0000001?.status).toBe('running')

    Object.assign(state.tasks.b0000001!, {
      retain: 'last',
      startTime: 42,
      messages: ['existing'],
      diskLoaded: true,
      pendingMessages: ['pending'],
    })
    registerTask(shellTask('b0000001'), setAppState)
    expect(state.tasks.b0000001).toMatchObject({
      retain: 'last',
      startTime: 42,
      messages: ['existing'],
      diskLoaded: true,
      pendingMessages: ['pending'],
    })
    expect(drainSdkEvents().filter(event => event.subtype === 'task_started')).toHaveLength(0)
  })

  test('evicts only terminal notified tasks and respects retain grace', () => {
    setup()
    const state = getDefaultAppState()
    const setAppState = (update: (previous: typeof state) => typeof state) => {
      Object.assign(state, update(state))
    }
    Object.assign(state.tasks, {
      b0000002: shellTask('b0000002', { status: 'completed', notified: true }),
      b0000003: shellTask('b0000003', { status: 'running', notified: true }),
      b0000004: shellTask('b0000004', { status: 'failed', notified: false }),
      b0000005: { ...shellTask('b0000005', { status: 'killed', notified: true }), retain: 'last', evictAfter: Date.now() + 60_000 },
    })
    evictTerminalTask('b0000002', setAppState)
    evictTerminalTask('b0000003', setAppState)
    evictTerminalTask('b0000004', setAppState)
    evictTerminalTask('b0000005', setAppState)
    expect(Object.keys(state.tasks)).toEqual(['b0000003', 'b0000004', 'b0000005'])
    expect(getRunningTasks(state).map(task => task.id)).toEqual(['b0000003'])
  })
})

describe('disk output', () => {
  test('appends, reads exact deltas and omits only older tail content', async () => {
    setup()
    appendTaskOutput('b0000010', 'first')
    await flushTaskOutput('b0000010')
    expect(getTaskOutputDelta('b0000010', 0)).resolves.toEqual({ content: 'first', newOffset: 5 })
    expect(getTaskOutputDelta('b0000010', 5)).resolves.toEqual({ content: '', newOffset: 5 })

    appendTaskOutput('b0000010', '-second')
    await flushTaskOutput('b0000010')
    expect(getTaskOutputDelta('b0000010', 5)).resolves.toEqual({ content: '-second', newOffset: 12 })
    expect(await getTaskOutputSize('b0000010')).toBe(12)
    expect(await getTaskOutput('b0000010', 4)).toContain('KB of earlier output omitted')
    expect(getTaskOutputDelta('missing', 9)).resolves.toEqual({ content: '', newOffset: 9 })
    await cleanupTaskOutput('b0000010')
    expect(await getTaskOutput('b0000010')).toBe('')
  })

  test('serializes concurrent appends in call order', async () => {
    setup()
    for (let i = 0; i < 40; i++) {
      appendTaskOutput('b0000011', `${i},`)
    }
    await flushTaskOutput('b0000011')
    const content = readFileSync(getTaskOutputPath('b0000011'), 'utf8')
    expect(content).toBe(`${Array.from({ length: 40 }, (_, i) => `${i},`).join('')}`)
  })

  test('fails O_EXCL and never follows an existing symlink', async () => {
    setup()
    const path = getTaskOutputPath('b0000012')
    const target = join(tempRoot, 'target.txt')
    writeFileSync(target, 'original')
    symlinkSync(target, path)
    await expect(initTaskOutput('b0000012')).rejects.toThrow()
    expect(readFileSync(target, 'utf8')).toBe('original')
    await expect(initTaskOutput('b0000012')).rejects.toThrow()
  })

  test('retries a transient open failure without losing existing output', async () => {
    setup()
    const actualFs = await import('fs/promises')
    const actualOpen = actualFs.open
    const path = getTaskOutputPath('b0000013')
    writeFileSync(path, 'original')
    let injected = false
    mock.module('fs/promises', () => ({
      ...actualFs,
      open: async (...args: Parameters<typeof actualFs.open>) => {
        if (!injected && args[0] === path) {
          injected = true
          const error = new Error('busy') as Error & { code: string }
          error.code = 'EMFILE'
          throw error
        }
        return actualOpen(...args)
      },
    }))
    appendTaskOutput('b0000013', '-new')
    await flushTaskOutput('b0000013')
    mock.restore()
    expect(readFileSync(path, 'utf8')).toBe('original-new')
  })

  test('evicts in-memory output without deleting the disk file', async () => {
    setup()
    appendTaskOutput('b0000014', 'content')
    await evictTaskOutput('b0000014')
    expect(readFileSync(getTaskOutputPath('b0000014'), 'utf8')).toBe('content')
  })
})

describe('attachments and polling', () => {
  test('applies only fresh running offsets and evicts terminal notified tasks', async () => {
    setup()
    const state = getDefaultAppState()
    const setAppState = (update: (previous: typeof state) => typeof state) => {
      Object.assign(state, update(state))
    }
    Object.assign(state.tasks, {
      b0000020: shellTask('b0000020', { status: 'running', outputOffset: 0 }),
    })
    appendTaskOutput('b0000020', 'delta')
    await flushTaskOutput('b0000020')

    const generated = await generateTaskAttachments(state)
    expect(generated.attachments).toEqual([])
    expect(generated.updatedTaskOffsets).toEqual({ b0000020: 5 })
    expect(generated.evictedTaskIds).toEqual([])
    applyTaskOffsetsAndEvictions(setAppState, generated.updatedTaskOffsets, generated.evictedTaskIds)
    expect(state.tasks.b0000020?.outputOffset).toBe(5)

    Object.assign(state.tasks.b0000020!, { status: 'completed', notified: true })
    applyTaskOffsetsAndEvictions(setAppState, { b0000020: 99 }, [])
    expect(state.tasks.b0000020?.outputOffset).toBe(5)

    const completed = await generateTaskAttachments(state)
    expect(completed.evictedTaskIds).toEqual(['b0000020'])
    applyTaskOffsetsAndEvictions(setAppState, completed.updatedTaskOffsets, completed.evictedTaskIds)
    expect(state.tasks.b0000020).toBeUndefined()
  })

  test('pollTasks consumes each output delta once without duplicate completion attachments', async () => {
    setup()
    const state = getDefaultAppState()
    const setAppState = (update: (previous: typeof state) => typeof state) => {
      Object.assign(state, update(state))
    }
    Object.assign(state.tasks, {
      b0000021: shellTask('b0000021', { status: 'running', outputOffset: 0 }),
    })
    appendTaskOutput('b0000021', 'one')
    await flushTaskOutput('b0000021')
    await pollTasks(() => state, setAppState)
    expect(state.tasks.b0000021?.outputOffset).toBe(3)

    appendTaskOutput('b0000021', 'two')
    await flushTaskOutput('b0000021')
    await pollTasks(() => state, setAppState)
    expect(state.tasks.b0000021?.outputOffset).toBe(6)
    expect(drainSdkEvents().filter(event => event.subtype === 'task_notification')).toHaveLength(0)
  })
})
