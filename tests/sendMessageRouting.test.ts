import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { createServer, type Server } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const moduleIsolationRoot = mkdtempSync(join(tmpdir(), 'send-message-config-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = join(moduleIsolationRoot, 'config')

let tempRoot = ''
let bridgeActive = false
const actualBootstrap = await import('../src/bootstrap/state.ts')
mock.module('../src/bootstrap/state.ts', () => ({
  ...actualBootstrap,
  getSessionProjectDir: () => tempRoot,
  isReplBridgeActive: () => bridgeActive,
}))
mock.module('../src/bridge/replBridgeHandle.ts', () => ({
  getReplBridgeHandle: () => (bridgeActive ? { kind: 'offline-bridge' } : undefined),
}))
const bridgeCalls: Array<{ target: string; message: string }> = []
let bridgeResult: { ok: boolean; error?: string }
mock.module('../src/bridge/peerSessions.ts', () => ({
  postInterClaudeMessage: async (target: string, message: string) => {
    bridgeCalls.push({ target, message })
    return bridgeResult
  },
}))
const resumeCalls: Array<Record<string, unknown>> = []
let resumeImplementation: () => Promise<{ outputFile: string }>
mock.module('../src/tools/AgentTool/resumeAgent.ts', () => ({
  resumeAgentBackground: async (options: Record<string, unknown>) => {
    resumeCalls.push(options)
    return resumeImplementation()
  },
}))

const { SendMessageTool } = await import('../src/tools/SendMessageTool/SendMessageTool.ts')
const { getDefaultAppState } = await import('../src/state/AppStateStore.ts')
const { GENERAL_PURPOSE_AGENT } = await import(
  '../src/tools/AgentTool/built-in/generalPurposeAgent.ts'
)
const { createAssistantMessage } = await import('../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import(
  '../src/utils/fileStateCache.ts'
)
const { createAgentId } = await import('../src/utils/uuid.ts')
const {
  killAsyncAgent,
  registerAsyncAgent,
} = await import('../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const {
  cleanupTeamDirectories,
  readTeamFileAsync,
  writeTeamFileAsync,
} = await import('../src/utils/swarm/teamHelpers.ts')
const { readMailbox } = await import('../src/utils/teammateMailbox.ts')
const {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
} = await import('../src/utils/task/diskOutput.ts')
const { resetSdkEventQueueForTests } = await import('../src/utils/sdkEventQueue.ts')
const { resetCommandQueue } = await import('../src/utils/messageQueueManager.ts')

import type { CanUseToolFn } from '../src/hooks/useCanUseTool.ts'
import type { AppState } from '../src/state/AppState.ts'
import type { ToolUseContext } from '../src/Tool.ts'

const originalTempDir = process.env.CLAUDE_CODE_TMPDIR
const featureTest = feature('UDS_INBOX') ? test : test.skip
let state: AppState
let udsServer: Server | undefined

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
    toolUseId: 'tool-send-message',
  } as unknown as ToolUseContext
}

const canUseTool: CanUseToolFn = async () => ({
  behavior: 'allow',
  updatedInput: {},
})
const parentMessage = {
  ...createAssistantMessage({ content: 'parent request' }),
  requestId: 'request-parent',
}

function registerAgent(name: string) {
  const agentId = createAgentId()
  registerAsyncAgent({
    agentId,
    description: 'offline local agent',
    prompt: 'initial task',
    selectedAgent: GENERAL_PURPOSE_AGENT,
    setAppState,
    toolUseId: 'tool-send-message',
  })
  setAppState(previous => {
    const agentNameRegistry = new Map(previous.agentNameRegistry)
    agentNameRegistry.set(name, agentId)
    return { ...previous, agentNameRegistry }
  })
  return agentId
}

async function seedTeam() {
  const now = Date.now()
  await writeTeamFileAsync('message-team', {
    name: 'message-team',
    createdAt: now,
    leadAgentId: 'team-lead@message-team',
    leadSessionId: 'session-1',
    members: [
      {
        agentId: 'team-lead@message-team',
        name: 'team-lead',
        agentType: 'team-lead',
        joinedAt: now,
        tmuxPaneId: '',
        cwd: tempRoot,
        subscriptions: [],
      },
      {
        agentId: 'worker@message-team',
        name: 'worker',
        agentType: 'general-purpose',
        joinedAt: now,
        tmuxPaneId: '',
        cwd: tempRoot,
        subscriptions: [],
      },
      {
        agentId: 'researcher@message-team',
        name: 'researcher',
        agentType: 'general-purpose',
        joinedAt: now,
        tmuxPaneId: '',
        cwd: tempRoot,
        subscriptions: [],
      },
    ],
  })
  setAppState(previous => ({
    ...previous,
    teamContext: {
      teamName: 'message-team',
      teamFilePath: join(tempRoot, 'team.json'),
      leadAgentId: 'team-lead@message-team',
      teammates: {
        'worker@message-team': {
          name: 'worker',
          agentType: 'general-purpose',
          color: 'blue',
          tmuxSessionName: '',
          tmuxPaneId: '',
          cwd: tempRoot,
          spawnedAt: now,
        },
      },
    },
  }))
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'send-message-routing-'))
  process.env.CLAUDE_CODE_TMPDIR = join(tempRoot, 'task-output')
  process.env.CLAUDE_CONFIG_DIR = join(tempRoot, 'config')
  _resetTaskOutputDirForTest()
  resetSdkEventQueueForTests()
  resetCommandQueue()
  state = getDefaultAppState()
  bridgeActive = false
  bridgeCalls.length = 0
  bridgeResult = { ok: true }
  resumeCalls.length = 0
  resumeImplementation = async () => ({ outputFile: join(tempRoot, 'resume.output') })
  udsServer = undefined
})

afterEach(async () => {
  for (const task of Object.values(state.tasks)) {
    if (task.type === 'local_agent' && task.status === 'running') {
      killAsyncAgent(task.id, setAppState)
    }
  }
  if (udsServer) {
    await new Promise<void>(resolve => udsServer!.close(() => resolve()))
    udsServer = undefined
  }
  await cleanupTeamDirectories('message-team')
  await _clearOutputsForTest()
  _resetTaskOutputDirForTest()
  resetSdkEventQueueForTests()
  resetCommandQueue()
  if (originalTempDir === undefined) delete process.env.CLAUDE_CODE_TMPDIR
  else process.env.CLAUDE_CODE_TMPDIR = originalTempDir
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(moduleIsolationRoot, { recursive: true, force: true })
})

describe('SendMessage local agent routing', () => {
  test('queues a message on the real running local agent task', async () => {
    const agentId = registerAgent('worker')

    const result = await SendMessageTool.call(
      { to: 'worker', message: 'next task', summary: 'next work' },
      context(),
      canUseTool,
      parentMessage,
    )

    expect(result.data).toEqual({
      success: true,
      message: 'Message queued for delivery to worker at its next tool round.',
    })
    expect(state.tasks[agentId]).toMatchObject({
      status: 'running',
      pendingMessages: ['next task'],
    })
    expect(resumeCalls).toHaveLength(0)
  })

  test('resumes a stopped local agent with prompt and parent request ID', async () => {
    const agentId = registerAgent('worker')
    killAsyncAgent(agentId, setAppState)

    const result = await SendMessageTool.call(
      { to: 'worker', message: 'resume task', summary: 'resume work' },
      context(),
      canUseTool,
      parentMessage,
    )

    expect(result.data.success).toBe(true)
    expect(result.data.message).toContain('resumed it in the background')
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0]).toMatchObject({
      agentId,
      prompt: 'resume task',
      invokingRequestId: 'request-parent',
    })
  })

  test('returns resume failure without writing a teammate mailbox', async () => {
    const agentId = registerAgent('worker')
    killAsyncAgent(agentId, setAppState)
    resumeImplementation = async () => {
      throw new Error('offline resume failure')
    }

    const result = await SendMessageTool.call(
      { to: 'worker', message: 'resume task', summary: 'resume work' },
      context(),
      canUseTool,
      parentMessage,
    )

    expect(result.data).toEqual({
      success: false,
      message: 'Agent "worker" is stopped (killed) and could not be resumed: offline resume failure',
    })
    expect(await readMailbox('worker', 'message-team')).toEqual([])
  })
})

describe('SendMessage team mailbox routing', () => {
  test('writes direct and broadcast messages to real teammate inboxes', async () => {
    await seedTeam()

    const direct = await SendMessageTool.call(
      { to: 'worker', message: 'direct message', summary: 'direct summary' },
      context(),
      canUseTool,
      parentMessage,
    )
    expect(direct.data).toMatchObject({
      success: true,
      message: "Message sent to worker's inbox",
      routing: {
        sender: 'team-lead',
        target: '@worker',
        targetColor: 'blue',
        summary: 'direct summary',
        content: 'direct message',
      },
    })

    const broadcast = await SendMessageTool.call(
      { to: '*', message: 'broadcast message', summary: 'broadcast summary' },
      context(),
      canUseTool,
      parentMessage,
    )
    expect(broadcast.data).toMatchObject({
      success: true,
      recipients: ['worker', 'researcher'],
      routing: { sender: 'team-lead', target: '@team' },
    })

    const workerMessages = await readMailbox('worker', 'message-team')
    expect(workerMessages).toHaveLength(2)
    expect(workerMessages.map(message => message.text)).toEqual([
      'direct message',
      'broadcast message',
    ])
    const researcherMessages = await readMailbox('researcher', 'message-team')
    expect(researcherMessages).toHaveLength(1)
    expect(researcherMessages[0]?.text).toBe('broadcast message')
    for (const message of [...workerMessages, ...researcherMessages]) {
      expect(message.from).toBe('team-lead')
      expect(message.read).toBe(false)
    }
    expect(await readTeamFileAsync('message-team')).not.toBeNull()
  })
})

describe('SendMessage UDS and bridge routing', () => {
  featureTest('delivers through a real Unix socket and returns connection failures', async () => {
    const socketPath = join(tempRoot, 'message.sock')
    let received = ''
    udsServer = createServer(socket => {
      socket.on('data', chunk => {
        received += chunk.toString()
        socket.end('{"ok":true}\n')
      })
    })
    await new Promise<void>(resolve => udsServer!.listen(socketPath, resolve))

    const sent = await SendMessageTool.call(
      { to: `uds:${socketPath}`, message: 'hello uds', summary: 'uds summary' },
      context(),
      canUseTool,
      parentMessage,
    )
    expect(sent.data).toEqual({ success: true, message: '“uds summary” → uds:' + socketPath })
    expect(received).toBe('hello uds\n')
    await new Promise<void>(resolve => udsServer!.close(() => resolve()))
    udsServer = undefined

    const failed = await SendMessageTool.call(
      { to: `uds:${join(tempRoot, 'missing.sock')}`, message: 'hello uds', summary: 'uds summary' },
      context(),
      canUseTool,
      parentMessage,
    )
    expect(failed.data.success).toBe(false)
    expect(failed.data.message).toContain('Failed to send to uds:')
  })

  featureTest('uses the offline bridge only while connected and rechecks before send', async () => {
    bridgeActive = true
    const sent = await SendMessageTool.call(
      { to: 'bridge:session-1', message: 'hello bridge', summary: 'bridge summary' },
      context(),
      canUseTool,
      parentMessage,
    )
    expect(sent.data).toEqual({ success: true, message: '“bridge summary” → bridge:session-1' })
    expect(bridgeCalls).toEqual([{ target: 'session-1', message: 'hello bridge' }])

    bridgeActive = false
    const disconnected = await SendMessageTool.call(
      { to: 'bridge:session-1', message: 'hello bridge', summary: 'bridge summary' },
      context(),
      canUseTool,
      parentMessage,
    )
    expect(disconnected.data).toEqual({
      success: false,
      message: 'Remote Control disconnected before send — cannot deliver to bridge:session-1',
    })
    expect(bridgeCalls).toHaveLength(1)
  })
})
