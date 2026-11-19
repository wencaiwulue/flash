import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const moduleIsolationRoot = mkdtempSync(join(tmpdir(), 'worker-crash-config-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = join(moduleIsolationRoot, 'config')

const { getDefaultAppState } = await import('../src/state/AppStateStore.ts')
const { GENERAL_PURPOSE_AGENT } = await import(
  '../src/tools/AgentTool/built-in/generalPurposeAgent.ts'
)
const { createFileStateCacheWithSizeLimit } = await import(
  '../src/utils/fileStateCache.ts'
)
const { createAssistantMessage } = await import('../src/utils/messages.ts')
const {
  cleanupTeamDirectories,
  getTeamFilePath,
  readTeamFile,
  writeTeamFileAsync,
} = await import('../src/utils/swarm/teamHelpers.ts')
const {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
} = await import('../src/utils/task/diskOutput.ts')
const { drainSdkEvents, resetSdkEventQueueForTests } = await import('../src/utils/sdkEventQueue.ts')
const { resetCommandQueue } = await import('../src/utils/messageQueueManager.ts')

import type { AppState } from '../src/state/AppState.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import type { Message } from '../src/types/message.ts'
import type { TeammateIdentity } from '../src/tasks/InProcessTeammateTask/types.ts'
import type { PaneBackend } from '../src/utils/swarm/backends/types.ts'

type RunAgentOptions = Parameters<
  typeof import('../src/tools/AgentTool/runAgent.ts').runAgent
>[0]
let stream: (options: RunAgentOptions) => AsyncGenerator<Message, void> =
  async function* () {}
mock.module('../src/tools/AgentTool/runAgent.ts', () => ({
  runAgent: (options: RunAgentOptions) => stream(options),
}))
const { spawnInProcessTeammate } = await import(
  '../src/utils/swarm/spawnInProcess.ts'
)
const { runInProcessTeammate } = await import(
  '../src/utils/swarm/inProcessRunner.ts'
)
const { InProcessBackend } = await import(
  '../src/utils/swarm/backends/InProcessBackend.ts'
)
const { PaneBackendExecutor } = await import(
  '../src/utils/swarm/backends/PaneBackendExecutor.ts'
)

const originalTempDir = process.env.CLAUDE_CODE_TMPDIR
let tempRoot = ''
let state: AppState

function setAppState(update: (previous: AppState) => AppState): void {
  state = update(state)
}

function context(abortController: AbortController): ToolUseContext {
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
    abortController,
    readFileState: createFileStateCacheWithSizeLimit(),
    getAppState: () => state,
    setAppState,
    setAppStateForTasks: setAppState,
    setResponseLength: () => {},
    setToolJSX: () => {},
    messages: [],
    toolUseId: 'tool-worker-crash',
  } as unknown as ToolUseContext
}

async function seedTeam() {
  const now = Date.now()
  await writeTeamFileAsync('crash-team', {
    name: 'crash-team',
    createdAt: now,
    leadAgentId: 'team-lead@crash-team',
    leadSessionId: 'session-1',
    members: [
      {
        agentId: 'team-lead@crash-team',
        name: 'team-lead',
        agentType: 'team-lead',
        joinedAt: now,
        tmuxPaneId: '',
        cwd: tempRoot,
        subscriptions: [],
      },
      {
        agentId: 'worker@crash-team',
        name: 'worker',
        agentType: 'general-purpose',
        joinedAt: now,
        tmuxPaneId: '',
        cwd: tempRoot,
        subscriptions: [],
        isActive: true,
      },
    ],
  })
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'worker-crash-'))
  process.env.CLAUDE_CODE_TMPDIR = join(tempRoot, 'task-output')
  process.env.CLAUDE_CONFIG_DIR = join(tempRoot, 'config')
  _resetTaskOutputDirForTest()
  resetSdkEventQueueForTests()
  resetCommandQueue()
  state = getDefaultAppState()
})

afterEach(async () => {
  await cleanupTeamDirectories('crash-team')
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

describe('in-process worker failure lifecycle', () => {
  test('marks both task and TeamFile member inactive after a runner failure', async () => {
    await seedTeam()
    stream = async function* () {
      throw new Error('offline worker crash')
    }
    const spawned = await spawnInProcessTeammate(
      { name: 'worker', teamName: 'crash-team', prompt: 'work', planModeRequired: false },
      { setAppState, toolUseId: 'tool-worker-crash' },
    )
    expect(spawned.success).toBe(true)
    if (!spawned.success || !spawned.taskId || !spawned.abortController || !spawned.teammateContext) {
      throw new Error('spawn failed')
    }
    const identity = spawned.teammateContext as TeammateIdentity
    const toolContext = context(spawned.abortController)
    const backend = new InProcessBackend()
    backend.setContext(toolContext)
    expect(await backend.isActive('worker@crash-team')).toBe(true)

    const result = await runInProcessTeammate({
      identity,
      taskId: spawned.taskId,
      prompt: 'work',
      teammateContext: spawned.teammateContext,
      toolUseContext: toolContext,
      abortController: spawned.abortController,
      systemPromptMode: 'replace',
      systemPrompt: 'offline worker prompt',
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('offline worker crash')
    expect(state.tasks[spawned.taskId]).toBeUndefined()
    expect(drainSdkEvents()).toContainEqual(
      expect.objectContaining({
        subtype: 'task_notification',
        task_id: spawned.taskId,
        status: 'failed',
      }),
    )
    expect(readTeamFile('crash-team')?.members.find(member => member.name === 'worker')?.isActive).toBe(false)
    expect(await backend.isActive('worker@crash-team')).toBe(false)
    expect(await backend.isActive('missing@crash-team')).toBe(false)
    expect(getTeamFilePath('crash-team')).toContain('crash-team')
  })

  test('marks the TeamFile member inactive after a normal aborted completion', async () => {
    await seedTeam()
    const spawned = await spawnInProcessTeammate(
      { name: 'worker', teamName: 'crash-team', prompt: 'work', planModeRequired: false },
      { setAppState, toolUseId: 'tool-worker-crash' },
    )
    if (!spawned.success || !spawned.taskId || !spawned.abortController || !spawned.teammateContext) {
      throw new Error('spawn failed')
    }
    stream = async function* () {
      yield createAssistantMessage({ content: 'finished work' })
      spawned.abortController!.abort()
    }

    const result = await runInProcessTeammate({
      identity: spawned.teammateContext as TeammateIdentity,
      taskId: spawned.taskId,
      prompt: 'work',
      teammateContext: spawned.teammateContext,
      toolUseContext: context(spawned.abortController),
      abortController: spawned.abortController,
      systemPromptMode: 'replace',
      systemPrompt: 'offline worker prompt',
    })

    expect(result.success).toBe(true)
    expect(state.tasks[spawned.taskId]).toBeUndefined()
    expect(drainSdkEvents()).toContainEqual(
      expect.objectContaining({
        subtype: 'task_notification',
        task_id: spawned.taskId,
        status: 'completed',
      }),
    )
    expect(readTeamFile('crash-team')?.members.find(member => member.name === 'worker')?.isActive).toBe(false)
  })
})

describe('pane worker crash detection boundary', () => {
  test('documents that isActive is registry-only and cannot observe an external pane crash', async () => {
    const backend = {
      type: 'tmux',
      createTeammatePaneInSwarmView: async () => ({ paneId: 'pane-1', isFirstTeammate: false }),
      sendCommandToPane: async () => {},
      killPane: async () => true,
    } as unknown as PaneBackend
    const executor = new PaneBackendExecutor(backend)
    executor.setContext(context(new AbortController()))

    expect(await executor.isActive('worker@crash-team')).toBe(false)
    const spawned = await executor.spawn({
      name: 'worker',
      teamName: 'crash-team',
      prompt: 'work',
      cwd: tempRoot,
      parentSessionId: 'session-1',
      planModeRequired: false,
    })
    expect(spawned.success).toBe(true)
    expect(await executor.isActive('worker@crash-team')).toBe(true)

    await backend.killPane('pane-1')
    expect(await executor.isActive('worker@crash-team')).toBe(true)
  })
})
