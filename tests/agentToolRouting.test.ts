import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const moduleIsolationRoot = mkdtempSync(join(tmpdir(), 'agent-routing-config-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = join(moduleIsolationRoot, 'config')

const { getDefaultAppState } = await import('../src/state/AppStateStore.ts')
const { getEmptyToolPermissionContext } = await import('../src/Tool.ts')
const { GENERAL_PURPOSE_AGENT } = await import(
  '../src/tools/AgentTool/built-in/generalPurposeAgent.ts'
)
const { createAssistantMessage } = await import('../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import(
  '../src/utils/fileStateCache.ts'
)
const {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
} = await import('../src/utils/task/diskOutput.ts')
const { resetSdkEventQueueForTests } = await import('../src/utils/sdkEventQueue.ts')
const { resetCommandQueue } = await import('../src/utils/messageQueueManager.ts')

import type { CanUseToolFn } from '../src/hooks/useCanUseTool.ts'
import type { AppState } from '../src/state/AppState.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import type { Message } from '../src/types/message.ts'

type RunAgentOptions = Parameters<
  typeof import('../src/tools/AgentTool/runAgent.ts').runAgent
>[0]
type SpawnOptions = Record<string, unknown>
type RemoteRegistration = Record<string, unknown>

const runAgentCalls: RunAgentOptions[] = []
const spawnCalls: Array<{ input: SpawnOptions; context: ToolUseContext }> = []
const remoteRegistrations: RemoteRegistration[] = []
const teleportCalls: Array<Record<string, unknown>> = []
let spawnImplementation: () => Promise<{ data: Record<string, unknown> }>
let remoteEligibility: { eligible: boolean; errors: string[] }
let teleportImplementation: (options: Record<string, unknown>) => Promise<{
  id: string
  title: string
} | null>

mock.module('../src/tools/AgentTool/runAgent.ts', () => ({
  runAgent: (options: RunAgentOptions) => {
    runAgentCalls.push(options)
    return (async function* (): AsyncGenerator<Message, void> {
      yield createAssistantMessage({ content: 'unexpected model call' })
    })()
  },
}))
mock.module('../src/tools/shared/spawnMultiAgent.ts', () => ({
  spawnTeammate: async (input: SpawnOptions, context: ToolUseContext) => {
    spawnCalls.push({ input, context })
    return spawnImplementation()
  },
}))
mock.module('../src/tasks/RemoteAgentTask/RemoteAgentTask.tsx', () => ({
  checkRemoteAgentEligibility: async () => remoteEligibility,
  formatPreconditionError: (error: string) => `formatted:${error}`,
  getRemoteTaskSessionUrl: (sessionId: string) => `https://remote.invalid/${sessionId}`,
  registerRemoteAgentTask: (options: RemoteRegistration) => {
    remoteRegistrations.push(options)
    return { taskId: 'remote-task-1', sessionId: 'session-1' }
  },
}))
mock.module('../src/utils/teleport.tsx', () => ({
  teleportToRemote: async (options: Record<string, unknown>) => {
    teleportCalls.push(options)
    return teleportImplementation(options)
  },
}))

const { AgentTool } = await import('../src/tools/AgentTool/AgentTool.tsx')
const originalTempDir = process.env.CLAUDE_CODE_TMPDIR
const originalUserType = process.env.USER_TYPE
const originalAgentTeams = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
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
    toolUseId: 'tool-agent-routing',
  } as unknown as ToolUseContext
}

const canUseTool: CanUseToolFn = async () => ({
  behavior: 'allow',
  updatedInput: {},
})
const parentMessage = createAssistantMessage({ content: 'parent request' })

function input(overrides: Record<string, unknown> = {}) {
  return {
    description: 'offline routing',
    prompt: 'perform the routed task',
    subagent_type: GENERAL_PURPOSE_AGENT.agentType,
    run_in_background: false,
    ...overrides,
  }
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'agent-tool-routing-'))
  process.env.CLAUDE_CODE_TMPDIR = tempRoot
  delete process.env.USER_TYPE
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  _resetTaskOutputDirForTest()
  resetSdkEventQueueForTests()
  resetCommandQueue()
  state = getDefaultAppState()
  runAgentCalls.length = 0
  spawnCalls.length = 0
  remoteRegistrations.length = 0
  teleportCalls.length = 0
  spawnImplementation = async () => ({
    data: {
      teammate_id: 'teammate-1',
      agent_id: 'teammate-1',
      agent_type: GENERAL_PURPOSE_AGENT.agentType,
      model: 'opus',
      name: 'worker',
      color: 'blue',
      tmux_session_name: 'tmux-session',
      tmux_window_name: 'tmux-window',
      tmux_pane_id: 'pane-1',
      team_name: 'team-a',
      is_splitpane: true,
      plan_mode_required: true,
    },
  })
  remoteEligibility = { eligible: true, errors: [] }
  teleportImplementation = async () => ({ id: 'session-1', title: 'Offline remote' })
})

afterEach(async () => {
  await _clearOutputsForTest()
  _resetTaskOutputDirForTest()
  resetSdkEventQueueForTests()
  resetCommandQueue()
  if (originalTempDir === undefined) delete process.env.CLAUDE_CODE_TMPDIR
  else process.env.CLAUDE_CODE_TMPDIR = originalTempDir
  if (originalUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = originalUserType
  if (originalAgentTeams === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = originalAgentTeams
  rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(moduleIsolationRoot, { recursive: true, force: true })
})

describe('AgentTool teammate routing', () => {
  test('rejects team spawning when the real external opt-in gate is off', async () => {
    await expect(
      AgentTool.call(
        input({ team_name: 'team-a', name: 'worker' }),
        context(),
        canUseTool,
        parentMessage,
      ),
    ).rejects.toThrow('Agent Teams is not yet available on your plan')
    expect(spawnCalls).toHaveLength(0)
    expect(runAgentCalls).toHaveLength(0)
    expect(state.tasks).toEqual({})
  })

  test('routes an opted-in teammate spawn with model, plan mode, and parent request', async () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    const requestMessage = { ...parentMessage, requestId: 'request-parent' }

    const result = await AgentTool.call(
      input({ team_name: 'team-a', name: 'worker', mode: 'plan', model: 'opus' }),
      context(),
      canUseTool,
      requestMessage,
    )

    expect(result.data.status).toBe('teammate_spawned')
    expect(result.data).toMatchObject({
      status: 'teammate_spawned',
      prompt: 'perform the routed task',
      teammate_id: 'teammate-1',
      name: 'worker',
      team_name: 'team-a',
      plan_mode_required: true,
    })
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]!.input).toMatchObject({
      name: 'worker',
      prompt: 'perform the routed task',
      description: 'offline routing',
      team_name: 'team-a',
      use_splitpane: true,
      plan_mode_required: true,
      model: 'opus',
      agent_type: GENERAL_PURPOSE_AGENT.agentType,
      invokingRequestId: 'request-parent',
    })
    expect(runAgentCalls).toHaveLength(0)
  })

  test('propagates a teammate spawn failure without falling back to runAgent', async () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    spawnImplementation = async () => {
      throw new Error('offline spawn failure')
    }

    await expect(
      AgentTool.call(
        input({ team_name: 'team-a', name: 'worker' }),
        context(),
        canUseTool,
        parentMessage,
      ),
    ).rejects.toThrow('offline spawn failure')
    expect(runAgentCalls).toHaveLength(0)
    expect(state.tasks).toEqual({})
  })
})

describe('AgentTool remote routing', () => {
  beforeEach(() => {
    process.env.USER_TYPE = 'ant'
  })

  test('coordinates an eligible remote launch without calling the local runner', async () => {
    const result = await AgentTool.call(
      input({ isolation: 'remote' }),
      context(),
      canUseTool,
      parentMessage,
    )

    expect(result.data).toMatchObject({
      status: 'remote_launched',
      taskId: 'remote-task-1',
      sessionUrl: 'https://remote.invalid/session-1',
      description: 'offline routing',
      prompt: 'perform the routed task',
    })
    expect(teleportCalls).toHaveLength(1)
    expect(teleportCalls[0]).toMatchObject({
      initialMessage: 'perform the routed task',
      description: 'offline routing',
    })
    expect(remoteRegistrations).toHaveLength(1)
    expect(remoteRegistrations[0]).toMatchObject({
      remoteTaskType: 'remote-agent',
      session: { id: 'session-1', title: 'Offline remote' },
      command: 'perform the routed task',
      toolUseId: 'tool-agent-routing',
    })
    expect(runAgentCalls).toHaveLength(0)
  })

  test('fails closed with formatted eligibility reasons before teleport', async () => {
    remoteEligibility = { eligible: false, errors: ['oauth-required'] }

    await expect(
      AgentTool.call(input({ isolation: 'remote' }), context(), canUseTool, parentMessage),
    ).rejects.toThrow('Cannot launch remote agent:\nformatted:oauth-required')
    expect(teleportCalls).toHaveLength(0)
    expect(remoteRegistrations).toHaveLength(0)
    expect(runAgentCalls).toHaveLength(0)
  })

  test('preserves a bundle failure hint when remote session creation fails', async () => {
    teleportImplementation = async options => {
      ;(options.onBundleFail as (message: string) => void)('bundle offline failure')
      return null
    }

    await expect(
      AgentTool.call(input({ isolation: 'remote' }), context(), canUseTool, parentMessage),
    ).rejects.toThrow('bundle offline failure')
    expect(remoteRegistrations).toHaveLength(0)
    expect(runAgentCalls).toHaveLength(0)
  })
})
