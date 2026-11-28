import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { execFileSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const moduleIsolationRoot = mkdtempSync(join(tmpdir(), 'agent-isolation-config-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = join(moduleIsolationRoot, 'config')

const actualBootstrap = await import('../src/bootstrap/state.ts')
let sessionProjectDir = ''
let nonInteractive = false
mock.module('../src/bootstrap/state.ts', () => ({
  ...actualBootstrap,
  getIsNonInteractiveSession: () => nonInteractive,
  getSessionProjectDir: () => sessionProjectDir,
}))

const { getDefaultAppState } = await import('../src/state/AppStateStore.ts')
const { getEmptyToolPermissionContext } = await import('../src/Tool.ts')
const { GENERAL_PURPOSE_AGENT } = await import(
  '../src/tools/AgentTool/built-in/generalPurposeAgent.ts'
)
const { FORK_AGENT, buildForkedMessages } = await import(
  '../src/tools/AgentTool/forkSubagent.ts'
)
const { createAssistantMessage, createUserMessage } = await import(
  '../src/utils/messages.ts'
)
const { createFileStateCacheWithSizeLimit } = await import(
  '../src/utils/fileStateCache.ts'
)
const { getCwd, runWithCwdOverride } = await import('../src/utils/cwd.ts')
const { asSystemPrompt } = await import('../src/utils/systemPromptType.ts')
const { removeAgentWorktree } = await import('../src/utils/worktree.ts')
const {
  getPendingNotificationsSnapshot,
  resetCommandQueue,
} = await import('../src/utils/messageQueueManager.ts')
const { resetSdkEventQueueForTests } = await import('../src/utils/sdkEventQueue.ts')
const {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
} = await import('../src/utils/task/diskOutput.ts')
const { killAsyncAgent } = await import(
  '../src/tasks/LocalAgentTask/LocalAgentTask.tsx'
)

import type { CanUseToolFn } from '../src/hooks/useCanUseTool.ts'
import type { AppState } from '../src/state/AppState.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import type { Message } from '../src/types/message.ts'

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
const originalCoordinatorMode = process.env.CLAUDE_CODE_COORDINATOR_MODE
const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL
const originalGitConfigNoSystem = process.env.GIT_CONFIG_NOSYSTEM
const forkTest = feature('FORK_SUBAGENT') ? test : test.skip
let tempRoot = ''
let repo = ''
let state: AppState
const createdWorktrees: string[] = []

function setAppState(update: (previous: AppState) => AppState): void {
  state = update(state)
}

function context(overrides: {
  querySource?: string
  tools?: ToolUseContext['options']['tools']
  renderedSystemPrompt?: ToolUseContext['renderedSystemPrompt']
  messages?: Message[]
} = {}): ToolUseContext {
  return {
    options: {
      mainLoopModel: 'claude-sonnet-4-5',
      tools: overrides.tools ?? [],
      mcpClients: [],
      querySource: overrides.querySource,
      agentDefinitions: {
        activeAgents: [GENERAL_PURPOSE_AGENT, FORK_AGENT],
        allAgents: [GENERAL_PURPOSE_AGENT, FORK_AGENT],
      },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(),
    getAppState: () => state,
    setAppState,
    setAppStateForTasks: setAppState,
    setResponseLength: () => {},
    setToolJSX: () => {},
    messages: overrides.messages ?? [],
    renderedSystemPrompt: overrides.renderedSystemPrompt,
    toolUseId: 'tool-agent-isolation',
  } as unknown as ToolUseContext
}

const canUseTool: CanUseToolFn = async () => ({
  behavior: 'allow',
  updatedInput: {},
})

function parentMessage() {
  return createAssistantMessage({
    content: [
      { type: 'text', text: 'parent text' },
      {
        type: 'tool_use',
        id: 'tool-parent-1',
        name: 'Read',
        input: { file_path: 'README.md' },
      },
    ],
  })
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    description: 'offline isolation',
    prompt: 'perform the isolated task',
    subagent_type: GENERAL_PURPOSE_AGENT.agentType,
    run_in_background: false,
    ...overrides,
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(predicate()).toBe(true)
}

beforeEach(() => {
  nonInteractive = false
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tool-isolation-')))
  sessionProjectDir = tempRoot
  process.env.CLAUDE_CODE_TMPDIR = join(tempRoot, 'task-output')
  process.env.CLAUDE_CODE_COORDINATOR_MODE = '0'
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  repo = join(tempRoot, 'repo')
  mkdirSync(repo)
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.name', 'Offline Test'])
  git(repo, ['config', 'user.email', 'offline@example.invalid'])
  writeFileSync(join(repo, 'README.md'), 'parent\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-qm', 'initial'])
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
  for (const path of createdWorktrees.splice(0)) {
    if (existsSync(path)) await removeAgentWorktree(path, undefined, repo)
  }
  await new Promise(resolve => setTimeout(resolve, 20))
  await _clearOutputsForTest()
  _resetTaskOutputDirForTest()
  resetSdkEventQueueForTests()
  resetCommandQueue()
  runAgentCalls.length = 0
  if (originalTempDir === undefined) delete process.env.CLAUDE_CODE_TMPDIR
  else process.env.CLAUDE_CODE_TMPDIR = originalTempDir
  if (originalCoordinatorMode === undefined) delete process.env.CLAUDE_CODE_COORDINATOR_MODE
  else process.env.CLAUDE_CODE_COORDINATOR_MODE = originalCoordinatorMode
  if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal
  if (originalGitConfigNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  else process.env.GIT_CONFIG_NOSYSTEM = originalGitConfigNoSystem
  sessionProjectDir = ''
  rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
  repo = ''
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(moduleIsolationRoot, { recursive: true, force: true })
})

describe('fork cache prefix construction', () => {
  test('keeps assistant and placeholder tool results byte-identical across directives', () => {
    const parent = parentMessage()
    const originalUuid = parent.uuid
    const first = buildForkedMessages('first directive', parent)
    const second = buildForkedMessages('second directive', parent)

    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    expect(first[0]).not.toBe(parent)
    expect(first[0]!.uuid).not.toBe(originalUuid)
    expect(parent.uuid).toBe(originalUuid)
    expect(first[0]!.message.content).toEqual(parent.message.content)
    expect(second[0]!.message.content).toEqual(parent.message.content)
    const firstBlocks = first[1]!.message.content
    const secondBlocks = second[1]!.message.content
    expect(Array.isArray(firstBlocks)).toBe(true)
    expect(Array.isArray(secondBlocks)).toBe(true)
    if (!Array.isArray(firstBlocks) || !Array.isArray(secondBlocks)) return
    expect(firstBlocks.slice(0, -1)).toEqual(secondBlocks.slice(0, -1))
    expect(firstBlocks.at(-1)).not.toEqual(secondBlocks.at(-1))
    expect(JSON.stringify(firstBlocks.at(-1))).toContain('first directive')
    expect(JSON.stringify(secondBlocks.at(-1))).toContain('second directive')
  })
})

describe('AgentTool fork production path', () => {
  forkTest('inherits exact tools/system prompt/context and forces async execution', async () => {
    const parentTools = [{ name: 'ParentExactTool' }] as unknown as ToolUseContext['options']['tools']
    const renderedSystemPrompt = asSystemPrompt(['exact parent system prompt'])
    const history = [createUserMessage({ content: 'parent history' })]
    const parent = parentMessage()

    const result = await AgentTool.call(
      input({ subagent_type: undefined }),
      context({ tools: parentTools, renderedSystemPrompt, messages: history }),
      canUseTool,
      parent,
    )

    expect(result.data.status).toBe('async_launched')
    if (result.data.status !== 'async_launched') throw new Error('expected fork async result')
    expect(runAgentCalls).toHaveLength(1)
    expect(runAgentCalls[0]).toMatchObject({
      agentDefinition: FORK_AGENT,
      isAsync: true,
      useExactTools: true,
      model: undefined,
    })
    expect(runAgentCalls[0]!.availableTools).toBe(parentTools)
    expect(runAgentCalls[0]!.forkContextMessages).toBe(history)
    expect(runAgentCalls[0]!.override?.systemPrompt).toBe(renderedSystemPrompt)
    expect(runAgentCalls[0]!.promptMessages[0]?.message.content).toEqual(parent.message.content)
    await waitFor(() => state.tasks[result.data.agentId]?.status === 'completed')
    expect(getPendingNotificationsSnapshot()[0]?.value).toContain('<status>completed</status>')
  })

  forkTest('rejects recursive fork before starting another agent', async () => {
    await expect(
      AgentTool.call(
        input({ subagent_type: undefined }),
        context({ querySource: 'agent:builtin:fork' }),
        canUseTool,
        parentMessage(),
      ),
    ).rejects.toThrow('Fork is not available inside a forked worker')
    expect(runAgentCalls).toHaveLength(0)
    expect(state.tasks).toEqual({})
  })
})

describe('AgentTool worktree production path', () => {
  beforeEach(() => {
    nonInteractive = true
  })

  test('runs inside a real worktree and removes it when no changes were made', async () => {
    let worktreePath = ''
    agentStream = async function* (options) {
      worktreePath = realpathSync(options.worktreePath!)
      createdWorktrees.push(worktreePath)
      expect(realpathSync(getCwd())).toBe(worktreePath)
      expect(worktreePath).not.toBe(repo)
      yield createAssistantMessage({ content: 'clean worktree answer' })
    }

    const result = await runWithCwdOverride(repo, () =>
      AgentTool.call(input({ isolation: 'worktree' }), context(), canUseTool, parentMessage()),
    )

    expect(result.data.status).toBe('completed')
    if (result.data.status !== 'completed') throw new Error('expected sync result')
    expect(result.data.content).toEqual([{ type: 'text', text: 'clean worktree answer' }])
    expect(result.data.worktreePath).toBeUndefined()
    expect(worktreePath).toContain(join('.claude', 'worktrees', 'agent-'))
    expect(existsSync(worktreePath)).toBe(false)
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('parent\n')
  })

  test('preserves a changed worktree and does not modify the parent checkout', async () => {
    let worktreePath = ''
    agentStream = async function* (options) {
      worktreePath = realpathSync(options.worktreePath!)
      createdWorktrees.push(worktreePath)
      writeFileSync(join(getCwd(), 'agent-change.txt'), 'isolated change\n')
      yield createAssistantMessage({ content: 'changed worktree answer' })
    }

    const result = await runWithCwdOverride(repo, () =>
      AgentTool.call(input({ isolation: 'worktree' }), context(), canUseTool, parentMessage()),
    )

    expect(result.data.status).toBe('completed')
    if (result.data.status !== 'completed') throw new Error('expected sync result')
    expect(realpathSync(result.data.worktreePath!)).toBe(worktreePath)
    expect(result.data.worktreeBranch).toMatch(/^worktree-agent-/)
    expect(existsSync(join(worktreePath, 'agent-change.txt'))).toBe(true)
    expect(readFileSync(join(worktreePath, 'agent-change.txt'), 'utf8')).toBe('isolated change\n')
    expect(existsSync(join(repo, 'agent-change.txt'))).toBe(false)
  })

  test('cleans an unchanged worktree when the runner fails', async () => {
    let worktreePath = ''
    agentStream = async function* (options) {
      worktreePath = realpathSync(options.worktreePath!)
      createdWorktrees.push(worktreePath)
      throw new Error('offline worktree failure')
    }

    await expect(
      runWithCwdOverride(repo, () =>
        AgentTool.call(input({ isolation: 'worktree' }), context(), canUseTool, parentMessage()),
      ),
    ).rejects.toThrow('offline worktree failure')
    expect(worktreePath).not.toBe('')
    expect(existsSync(worktreePath)).toBe(false)
    expect(state.tasks).toEqual({})
  })
})
