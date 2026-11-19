import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { stopTask } from '../src/tasks/stopTask.ts'
import { TaskCreateTool } from '../src/tools/TaskCreateTool/TaskCreateTool.ts'
import { TaskGetTool } from '../src/tools/TaskGetTool/TaskGetTool.ts'
import {
  blockTask,
  claimTask,
  createTask,
  deleteTask,
  getTask,
  getTaskPath,
  listTasks,
  sanitizePathComponent,
  updateTask,
} from '../src/utils/tasks.ts'
import { createTaskStateBase } from '../src/Task.ts'
import { getDefaultAppState } from '../src/state/AppStateStore.ts'
import { drainSdkEvents, resetSdkEventQueueForTests } from '../src/utils/sdkEventQueue.ts'

const actualBootstrap = await import('../src/bootstrap/state.ts')
mock.module('../src/bootstrap/state.ts', () => ({
  ...actualBootstrap,
  getIsNonInteractiveSession: () => true,
}))
const actualShellKill = await import('../src/tasks/LocalShellTask/killShellTasks.ts')
const killCalls: string[] = []
let killError: Error | null = null
mock.module('../src/tasks/LocalShellTask/killShellTasks.ts', () => ({
  killTask: async (taskId: string, setAppState: (update: (prev: any) => any) => void) => {
    if (killError) throw killError
    killCalls.push(taskId)
    setAppState(prev => ({
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: { ...prev.tasks[taskId], status: 'killed' },
      },
    }))
  },
}))

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalTaskListId = process.env.CLAUDE_CODE_TASK_LIST_ID
let tempRoot = ''

beforeEach(() => {
  mock.module('../src/bootstrap/state.ts', () => ({
    ...actualBootstrap,
    getIsNonInteractiveSession: () => true,
  }))
  mock.module('../src/tasks/LocalShellTask/killShellTasks.ts', () => ({
    killTask: async (taskId: string, setAppState: (update: (prev: any) => any) => void) => {
      if (taskId === 'b0000004') throw killError ?? new Error('kill failed')
      if (killError) throw killError
      killCalls.push(taskId)
      setAppState(prev => ({
        ...prev,
        tasks: {
          ...prev.tasks,
          [taskId]: { ...prev.tasks[taskId], status: 'killed' },
        },
      }))
    },
  }))
})

afterAll(() => {
  mock.restore()
})

function setup() {
  tempRoot = mkdtempSync(join(tmpdir(), 'todo-tasks-'))
  process.env.CLAUDE_CONFIG_DIR = tempRoot
  process.env.CLAUDE_CODE_TASK_LIST_ID = 'test-list'
  resetSdkEventQueueForTests()
  killCalls.length = 0
  killError = null
}

afterEach(() => {
  resetSdkEventQueueForTests()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalTaskListId === undefined) delete process.env.CLAUDE_CODE_TASK_LIST_ID
  else process.env.CLAUDE_CODE_TASK_LIST_ID = originalTaskListId
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

function taskData(subject = 'task') {
  return {
    subject,
    description: `${subject} description`,
    activeForm: `Running ${subject}`,
    status: 'pending' as const,
    blocks: [] as string[],
    blockedBy: [] as string[],
  }
}

describe('todo task files and high water mark', () => {
  test('creates, reads, updates, deletes and never reuses IDs', async () => {
    setup()
    expect(await createTask('test-list', taskData('first')).then(String)).toBe('1')
    expect(await createTask('test-list', taskData('second')).then(String)).toBe('2')
    expect((await getTask('test-list', '2'))?.subject).toBe('second')

    expect((await updateTask('test-list', '2', { status: 'in_progress' }))?.status).toBe('in_progress')
    expect((await listTasks('test-list')).map(task => task.id).sort()).toEqual(['1', '2'])

    expect(await deleteTask('test-list', '2')).toBe(true)
    expect(await getTask('test-list', '2')).toBeNull()
    expect(await createTask('test-list', taskData('third')).then(String)).toBe('3')
    expect(await deleteTask('test-list', 'missing')).toBe(false)
    expect(sanitizePathComponent('../bad/path')).toBe('---bad-path')
  })

  test('preserves high water mark after unlink failure without ID reuse', async () => {
    setup()
    expect(await createTask('test-list', taskData('first')).then(String)).toBe('1')
    const actualFs = await import('fs/promises')
    const actualUnlink = actualFs.unlink
    const path = getTaskPath('test-list', '1')
    mock.module('fs/promises', () => ({
      ...actualFs,
      unlink: async (target: Parameters<typeof actualFs.unlink>[0]) => {
        if (target === path) {
          const error = new Error('denied') as Error & { code: string }
          error.code = 'EACCES'
          throw error
        }
        return actualUnlink(target)
      },
    }))
    expect(await deleteTask('test-list', '1')).toBe(false)
    mock.restore()
    expect(readFileSync(join(tempRoot, 'tasks', 'test-list', '.highwatermark'), 'utf8')).toBe('1')
    expect((await getTask('test-list', '1'))?.subject).toBe('first')
    expect(await createTask('test-list', taskData('second')).then(String)).toBe('2')
  })

  test('returns null for corrupt JSON and invalid task schema', async () => {
    setup()
    mkdirSync(dirname(getTaskPath('test-list', 'bad')), { recursive: true })
    writeFileSync(getTaskPath('test-list', 'bad'), '{not json')
    expect(await getTask('test-list', 'bad')).toBeNull()
    writeFileSync(getTaskPath('test-list', 'invalid'), JSON.stringify({ id: 'invalid', status: 'pending' }))
    expect(await getTask('test-list', 'invalid')).toBeNull()
    expect(await listTasks('test-list')).toEqual([])
  })
})

describe('claim and block behavior', () => {
  test('allows only one concurrent claimant', async () => {
    setup()
    await createTask('test-list', taskData('claim'))
    const results = await Promise.all([
      claimTask('test-list', '1', 'agent-a'),
      claimTask('test-list', '1', 'agent-b'),
    ])
    expect(results.filter(result => result.success)).toHaveLength(1)
    expect(results.filter(result => result.reason === 'already_claimed')).toHaveLength(1)
    expect((await getTask('test-list', '1'))?.owner).toBe(results.find(result => result.success)?.task?.owner)
  })

  test('enforces agent busy and unresolved blockers', async () => {
    setup()
    await createTask('test-list', taskData('first'))
    await createTask('test-list', taskData('second'))
    expect((await claimTask('test-list', '1', 'agent-a')).success).toBe(true)
    const busy = await claimTask('test-list', '2', 'agent-a', { checkAgentBusy: true })
    expect(busy).toMatchObject({ success: false, reason: 'agent_busy', busyWithTasks: ['1'] })

    expect(await blockTask('test-list', '1', '2')).toBe(true)
    const blocked = await claimTask('test-list', '2', 'agent-b')
    expect(blocked).toMatchObject({ success: false, reason: 'blocked', blockedByTasks: ['1'] })
    expect((await updateTask('test-list', '1', { status: 'completed' }))?.status).toBe('completed')
    expect((await claimTask('test-list', '2', 'agent-b')).success).toBe(true)
    expect((await claimTask('test-list', '2', 'agent-b')).success).toBe(true)
    expect((await claimTask('test-list', 'missing', 'agent-c')).reason).toBe('task_not_found')
  })
})

describe('TaskCreateTool and TaskGetTool', () => {
  test('uses real tool entrypoints to create and retrieve a task', async () => {
    setup()
    const state = getDefaultAppState()
    const context = {
      getAppState: () => state,
      setAppState: (update: (previous: typeof state) => typeof state) => {
        Object.assign(state, update(state))
      },
      abortController: new AbortController(),
    }
    const created = await TaskCreateTool.call({
      subject: 'tool task',
      description: 'created through real tool',
      activeForm: 'Creating',
      metadata: { source: 'test' },
    }, context)
    expect(created.data.task.id).toBe('1')
    expect(state.expandedView).toBe('tasks')

    const fetched = await TaskGetTool.call({ taskId: '1' })
    expect(fetched.data.task).toMatchObject({ id: '1', subject: 'tool task', status: 'pending' })
    expect((await getTask('test-list', '1'))?.description).toBe('created through real tool')
  })
})

describe('stopTask', () => {
  test('kills a running local shell task, suppresses XML and emits stopped SDK', async () => {
    setup()
    const state = getDefaultAppState()
    Object.assign(state.tasks, {
      b0000001: {
        ...createTaskStateBase('b0000001', 'local_bash', 'shell task', 'tool-1'),
        status: 'running',
        command: 'sleep 100',
        completionStatusSentInAttachment: false,
        shellCommand: null,
        lastReportedTotalLines: 0,
        isBackgrounded: true,
      },
    })
    const setAppState = (update: (previous: typeof state) => typeof state) => {
      Object.assign(state, update(state))
    }
    const result = await stopTask('b0000001', { getAppState: () => state, setAppState })
    expect(result).toEqual({ taskId: 'b0000001', taskType: 'local_bash', command: 'sleep 100' })
    expect(killCalls).toEqual(['b0000001'])
    expect(state.tasks.b0000001?.notified).toBe(true)
    const stopped = drainSdkEvents().filter(event => event.subtype === 'task_notification')
    expect(stopped).toHaveLength(1)
    expect(stopped[0]).toMatchObject({ task_id: 'b0000001', status: 'stopped', tool_use_id: 'tool-1' })
  })

  test('returns typed errors for missing, non-running and unsupported tasks', async () => {
    setup()
    const state = getDefaultAppState()
    const setAppState = (update: (previous: typeof state) => typeof state) => {
      Object.assign(state, update(state))
    }
    await expect(stopTask('missing', { getAppState: () => state, setAppState })).rejects.toMatchObject({ code: 'not_found' })

    Object.assign(state.tasks, {
      b0000002: { ...createTaskStateBase('b0000002', 'local_bash', 'done'), status: 'completed' },
    })
    await expect(stopTask('b0000002', { getAppState: () => state, setAppState })).rejects.toMatchObject({ code: 'not_running' })

    Object.assign(state.tasks, {
      b0000003: { ...createTaskStateBase('b0000003', 'local_bash', 'unsupported'), status: 'running', type: 'unknown' },
    })
    await expect(stopTask('b0000003', { getAppState: () => state, setAppState })).rejects.toMatchObject({ code: 'unsupported_type' })
    expect(killCalls).toEqual([])
  })

  test('propagates kill failure without emitting stopped event', async () => {
    setup()
    const state = getDefaultAppState()
    Object.assign(state.tasks, {
      b0000004: {
        ...createTaskStateBase('b0000004', 'local_bash', 'kill failure'),
        status: 'running',
        command: 'bad',
        completionStatusSentInAttachment: false,
        shellCommand: null,
        lastReportedTotalLines: 0,
        isBackgrounded: true,
      },
    })
    const actualTasks = await import('../src/tasks.ts')
    mock.module('../src/tasks.ts', () => ({
      ...actualTasks,
      getTaskByType: (type: string) => ({
        name: 'LocalShellTask',
        type: 'local_bash',
        kill: async () => {
          throw new Error('kill failed')
        },
      }),
    }))
    const setAppState = (update: (previous: typeof state) => typeof state) => {
      Object.assign(state, update(state))
    }
    let thrown: unknown
    try {
      await stopTask('b0000004', { getAppState: () => state, setAppState })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('kill failed')
    expect(drainSdkEvents().filter(event => event.subtype === 'task_notification')).toHaveLength(0)
  })
})
