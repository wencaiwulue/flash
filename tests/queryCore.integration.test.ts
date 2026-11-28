import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { QueryEngineConfig } from '../src/QueryEngine.ts'
import type { AppState } from '../src/state/AppState.ts'
import { getEmptyToolPermissionContext } from '../src/Tool.ts'
import { createFileStateCacheWithSizeLimit } from '../src/utils/fileStateCache.ts'
import {
  flushSessionStorage,
  loadTranscriptFile,
  resetProjectForTesting,
} from '../src/utils/sessionStorage.ts'
import { resetStateForTests, switchSession } from '../src/bootstrap/state.ts'

let tempDir: string
let projectDir: string
let previousConfig: string | undefined
let previousPersistence: string | undefined

beforeEach(async () => {
  previousConfig = process.env.CLAUDE_CONFIG_DIR
  previousPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  tempDir = await mkdtemp(join(tmpdir(), 'flash-query-core-'))
  projectDir = join(tempDir, 'project')
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  const { mkdir } = await import('fs/promises')
  await mkdir(projectDir, { recursive: true })
})

afterEach(async () => {
  resetStateForTests()
  resetProjectForTesting()
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  if (previousPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = previousPersistence
  await rm(tempDir, { recursive: true, force: true })
})

function appState(): AppState {
  return {
    toolPermissionContext: getEmptyToolPermissionContext(),
    fileHistory: { snapshots: [], currentId: 0 },
    attribution: { commits: [], currentId: 0 },
    fastMode: false,
    mcp: { clients: [], tools: [] },
    effortValue: undefined,
    advisorModel: undefined,
    sessionHooks: new Map(),
  }
}

function config(overrides: Partial<QueryEngineConfig> = {}): QueryEngineConfig {
  return {
    cwd: projectDir,
    userSpecifiedModel: 'offline-test-model',
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    canUseTool: async () => ({ behavior: 'allow' }),
    getAppState: appState,
    setAppState: () => {},
    initialMessages: [],
    readFileCache: createFileStateCacheWithSizeLimit(),
    ...overrides,
  }
}

async function engineWithFakeModel() {
  const api = await import('../src/services/api/claude.ts')
  const { createAssistantMessage } = await import('../src/utils/messages.ts')
  let calls = 0
  mock.module('../src/services/api/claude.ts', () => ({
    ...api,
    async *queryModelWithStreaming() {
      calls++
      yield createAssistantMessage({ content: `offline-response-${calls}` })
    },
  }))
  const { QueryEngine } = await import('../src/QueryEngine.ts')
  return { engine: new QueryEngine(config()), calls: () => calls }
}

async function drain(engine: any, prompt: string) {
  const events: any[] = []
  for await (const event of engine.submitMessage(prompt)) events.push(event)
  await flushSessionStorage()
  return events
}

describe('query-core offline integration', () => {
  test('multi-turn persistence, reload and engine isolation preserve independent chains', async () => {
    const firstSession = randomUUID()
    const secondSession = randomUUID()
    switchSession(firstSession as any, projectDir)
    const first = await engineWithFakeModel()
    await drain(first.engine, 'first user')
    await drain(first.engine, 'second user')
    const firstPath = (await import('../src/utils/sessionStorage.ts')).getTranscriptPath()

    switchSession(secondSession as any, projectDir)
    const second = await engineWithFakeModel()
    await drain(second.engine, 'other engine user')
    const secondPath = (await import('../src/utils/sessionStorage.ts')).getTranscriptPath()

    expect(firstPath).not.toBe(secondPath)
    const firstLog = await loadTranscriptFile(firstPath)
    const secondLog = await loadTranscriptFile(secondPath)
    const firstMessages = [...firstLog.messages.values()]
    const secondMessages = [...secondLog.messages.values()]
    const firstUsers = firstMessages.filter(message => message.type === 'user')
    const firstAssistants = firstMessages.filter(message => message.type === 'assistant')

    expect(firstUsers.map(message => message.message.content)).toEqual(['first user', 'second user'])
    expect(firstAssistants).toHaveLength(2)
    expect(new Set(firstMessages.map(message => message.uuid)).size).toBe(firstMessages.length)
    expect(firstMessages.every(message => message.sessionId === firstSession)).toBe(true)
    expect(secondMessages.every(message => message.sessionId === secondSession)).toBe(true)
    expect(secondMessages.some(message => message.message.content === 'first user')).toBe(false)
    expect(secondMessages.some(message => message.message.content === 'second user')).toBe(false)

    const chained = firstMessages.filter(message => message.type !== 'system' || message.subtype !== 'compact_boundary')
    for (let index = 1; index < chained.length; index++) {
      expect(chained[index].parentUuid).toBe(chained[index - 1].uuid)
    }
  })

  test('compact boundaries persist before following messages without duplicate replay', async () => {
    const sessionId = randomUUID()
    switchSession(sessionId as any, projectDir)
    const { recordTranscript, getTranscriptPath } = await import('../src/utils/sessionStorage.ts')
    const { createAssistantMessage, createUserMessage } = await import('../src/utils/messages.ts')
    const first = createUserMessage({ content: 'before compact' })
    const boundary = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    } as const
    const summary = createUserMessage({ content: 'compact summary', isMeta: true })
    const response = createAssistantMessage({ content: 'after compact' })

    await recordTranscript([first, boundary, summary, response])
    await recordTranscript([first, boundary, summary, response])
    await flushSessionStorage()

    const { messages } = await loadTranscriptFile(getTranscriptPath())
    const reloaded = [...messages.values()]
    expect(reloaded).toHaveLength(4)
    expect(reloaded.map(message => message.type)).toEqual(['user', 'system', 'user', 'assistant'])
    expect(reloaded[1].subtype).toBe('compact_boundary')
    expect(reloaded[2].message.content).toBe('compact summary')
    expect(reloaded[3].message.content[0].text).toBe('after compact')
    expect(reloaded[2].parentUuid).toBe(reloaded[1].uuid)
    expect(reloaded[3].parentUuid).toBe(reloaded[2].uuid)
  })
})
