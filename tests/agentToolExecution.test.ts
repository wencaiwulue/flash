import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CanUseToolFn } from '../src/hooks/useCanUseTool.ts'
import type { AppState } from '../src/state/AppState.ts'
import { getDefaultAppState } from '../src/state/AppStateStore.ts'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../src/Tool.ts'
import { GENERAL_PURPOSE_AGENT } from '../src/tools/AgentTool/built-in/generalPurposeAgent.ts'
import type { Message } from '../src/types/message.ts'
import { AbortError } from '../src/utils/errors.ts'
import { createFileStateCacheWithSizeLimit } from '../src/utils/fileStateCache.ts'
import { createAssistantMessage } from '../src/utils/messages.ts'
import {
  getPendingNotificationsSnapshot,
  resetCommandQueue,
} from '../src/utils/messageQueueManager.ts'
import { drainSdkEvents, resetSdkEventQueueForTests } from '../src/utils/sdkEventQueue.ts'
import {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
} from '../src/utils/task/diskOutput.ts'
import { killAsyncAgent } from '../src/tasks/LocalAgentTask/LocalAgentTask.tsx'

type RunAgentOptions = Parameters<
  typeof import('../src/tools/AgentTool/runAgent.ts').runAgent
>[0]
type AgentStream = (options: RunAgentOptions) => AsyncGenerator<Message, void>

const runAgentCalls: RunAgentOptions[] = []
let agentStream: AgentStream = async function* () {}

mock.module('../src/tools/AgentTool/runAgent.ts', () => ({
  runAgent: (options: RunAgentOptions) => {
    runAgentCalls.push(options)
    return agentStream(options)
  },
}))

const { AgentTool } = await import('../src/tools/AgentTool/AgentTool.tsx')
const originalTempDir = process.env.CLAUDE_CODE_TMPDIR
let tempRoot = ''
let state: AppState

function setAppState(update: (previous: AppState) => AppState): void {
  state = update(state)
}

function context(): ToolUseContext {
  return {
    options: {
      mainLoopModel: 'claude-sonnet-4-5',
      tools: [],
      mcpClients: [],
      agentDefinitions: {
        activeAgents: [GENERAL_PURPOSE_AGENT],
        allAgents: [GENERAL_PURPOSE_AGENT],
      },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(),
    getAppState: () => state,
    setAppState,
    setAppStateForTasks: setAppState,
    setResponseLength: () => {},
    setToolJSX: () => {},
    messages: [],
    toolUseId: 'tool-agent-test',
  } as unknown as ToolUseContext
}

const canUseTool: CanUseToolFn = async () => ({
  behavior: 'allow',
  updatedInput: {},
})
const parentMessage = createAssistantMessage({ content: 'parent request' })

function input(runInBackground = false) {
  return {
    description: 'offline execution',
    prompt: 'perform the offline task',
    subagent_type: GENERAL_PURPOSE_AGENT.agentType,
    run_in_background: runInBackground,
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(res => {
    resolve = res
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(predicate()).toBe(true)
}

async function waitWithAbort(options: RunAgentOptions, gate: Promise<void>) {
  const signal = options.override?.abortController?.signal
  if (!signal) return gate
  if (signal.aborted) throw new AbortError()
  let onAbort: () => void
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = () => reject(new AbortError())
      signal.addEventListener('abort', onAbort, { once: true })
      gate.then(resolve, reject)
    })
  } finally {
    signal.removeEventListener('abort', onAbort!)
  }
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'agent-tool-execution-'))
  process.env.CLAUDE_CODE_TMPDIR = tempRoot
  _resetTaskOutputDirForTest()
  resetSdkEventQueueForTests()
  resetCommandQueue()
  state = getDefaultAppState()
  runAgentCalls.length = 0
  agentStream = async function* () {
    yield createAssistantMessage({ content: 'offline answer' })
  }
})

afterEach(async () => {
  for (const task of Object.values(state.tasks)) {
    if (task.type === 'local_agent' && task.status === 'running') {
      task.abortController?.abort()
      killAsyncAgent(task.id, setAppState)
    }
  }
  await new Promise(resolve => setTimeout(resolve, 0))
  await _clearOutputsForTest()
  _resetTaskOutputDirForTest()
  resetSdkEventQueueForTests()
  resetCommandQueue()
  runAgentCalls.length = 0
  if (originalTempDir === undefined) delete process.env.CLAUDE_CODE_TMPDIR
  else process.env.CLAUDE_CODE_TMPDIR = originalTempDir
  rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

describe('AgentTool real synchronous execution', () => {
  test('runs the selected agent, finalizes output, and unregisters its foreground task', async () => {
    const result = await AgentTool.call(input(), context(), canUseTool, parentMessage)

    expect(result.data.status).toBe('completed')
    if (result.data.status !== 'completed') throw new Error('expected sync result')
    expect(result.data.content).toEqual([{ type: 'text', text: 'offline answer' }])
    expect(result.data.prompt).toBe('perform the offline task')
    expect(runAgentCalls).toHaveLength(1)
    expect(runAgentCalls[0]).toMatchObject({
      agentDefinition: GENERAL_PURPOSE_AGENT,
      description: 'offline execution',
      isAsync: false,
      querySource: 'agent:builtin:general-purpose',
    })
    expect(runAgentCalls[0]!.promptMessages[0]).toMatchObject({
      type: 'user',
      message: { content: 'perform the offline task' },
    })
    expect(state.tasks).toEqual({})
    expect(drainSdkEvents()).toContainEqual(
      expect.objectContaining({ subtype: 'task_notification', status: 'completed' }),
    )
  })

  test('rethrows a runner failure with no assistant output and cleans the foreground task', async () => {
    agentStream = async function* () {
      throw new Error('offline sync failure')
    }

    await expect(
      AgentTool.call(input(), context(), canUseTool, parentMessage),
    ).rejects.toThrow('offline sync failure')
    expect(state.tasks).toEqual({})
    expect(drainSdkEvents()).toContainEqual(
      expect.objectContaining({ subtype: 'task_notification', status: 'failed' }),
    )
  })

  test('returns partial assistant output when the runner fails after yielding', async () => {
    agentStream = async function* () {
      yield createAssistantMessage({ content: 'partial answer' })
      throw new Error('late sync failure')
    }

    const result = await AgentTool.call(input(), context(), canUseTool, parentMessage)
    expect(result.data.status).toBe('completed')
    if (result.data.status !== 'completed') throw new Error('expected partial result')
    expect(result.data.content).toEqual([{ type: 'text', text: 'partial answer' }])
    expect(state.tasks).toEqual({})
    expect(drainSdkEvents()).toContainEqual(
      expect.objectContaining({ subtype: 'task_notification', status: 'failed' }),
    )
  })
})

describe('AgentTool real asynchronous execution', () => {
  test('returns before the runner finishes, then completes the registered task', async () => {
    const gate = deferred()
    agentStream = async function* (options) {
      await waitWithAbort(options, gate.promise)
      yield createAssistantMessage({ content: 'background answer' })
    }

    const result = await AgentTool.call(input(true), context(), canUseTool, parentMessage)
    expect(result.data.status).toBe('async_launched')
    if (result.data.status !== 'async_launched') throw new Error('expected async result')
    expect(state.tasks[result.data.agentId]).toMatchObject({
      type: 'local_agent',
      status: 'running',
      isBackgrounded: true,
      prompt: 'perform the offline task',
    })
    expect(runAgentCalls[0]?.isAsync).toBe(true)
    expect(result.data.canReadOutputFile).toBe(false)

    gate.resolve()
    await waitFor(() => state.tasks[result.data.agentId]?.status === 'completed')
    expect(state.tasks[result.data.agentId]).toMatchObject({
      status: 'completed',
      notified: true,
      abortController: undefined,
      result: { content: [{ type: 'text', text: 'background answer' }] },
    })
    expect(getPendingNotificationsSnapshot()[0]?.value).toContain('<status>completed</status>')
  })

  test('marks the registered task failed and emits a failure notification', async () => {
    agentStream = async function* () {
      throw new Error('offline async failure')
    }

    const result = await AgentTool.call(input(true), context(), canUseTool, parentMessage)
    if (result.data.status !== 'async_launched') throw new Error('expected async result')
    await waitFor(() => state.tasks[result.data.agentId]?.status === 'failed')

    expect(state.tasks[result.data.agentId]).toMatchObject({
      status: 'failed',
      error: 'offline async failure',
      notified: true,
      abortController: undefined,
    })
    expect(getPendingNotificationsSnapshot()[0]?.value).toContain('<status>failed</status>')
    expect(getPendingNotificationsSnapshot()[0]?.value).toContain('offline async failure')
  })

  test('kills the task when the background runner is aborted', async () => {
    const gate = deferred()
    agentStream = async function* (options) {
      await waitWithAbort(options, gate.promise)
      yield createAssistantMessage({ content: 'unreachable' })
    }

    const result = await AgentTool.call(input(true), context(), canUseTool, parentMessage)
    if (result.data.status !== 'async_launched') throw new Error('expected async result')
    const task = state.tasks[result.data.agentId]
    expect(task?.status).toBe('running')
    task?.abortController?.abort()
    await waitFor(() => state.tasks[result.data.agentId]?.status === 'killed')

    expect(state.tasks[result.data.agentId]).toMatchObject({
      status: 'killed',
      notified: true,
      abortController: undefined,
    })
    expect(getPendingNotificationsSnapshot()[0]?.value).toContain('<status>killed</status>')
  })
})
