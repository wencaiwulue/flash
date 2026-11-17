import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { QueryEngine } from '../src/QueryEngine.ts'
import { ContextCollapseSession } from '../src/services/contextCollapse/index.ts'
import { MicrocompactSession } from '../src/services/compact/microCompact.ts'
import type { Tools } from '../src/Tool.ts'
import type { AppState } from '../src/state/AppState.ts'
import { getEmptyToolPermissionContext } from '../src/Tool.ts'
import { createAbortController } from '../src/utils/abortController.ts'

const noop = () => {}

function createEmptyAppState(): AppState {
  return {
    toolPermissionContext: getEmptyToolPermissionContext(),
    fileHistory: { snapshots: [], currentId: 0 },
    attribution: { commits: [], currentId: 0 },
    fastMode: false,
    mcp: { clients: [], tools: [] },
    effortValue: undefined,
    advisorModel: undefined,
  }
}

function createMinimalQueryEngineConfig(
  overrides: Partial<ConstructorParameters<typeof QueryEngine>[0]> = {},
): ConstructorParameters<typeof QueryEngine>[0] {
  return {
    cwd: process.cwd(),
    tools: [] as Tools,
    commands: [],
    mcpClients: [],
    agents: [],
    canUseTool: async () => ({ behavior: 'allow' }),
    getAppState: () => createEmptyAppState(),
    setAppState: noop,
    initialMessages: [],
    readFileState: { entries: [], lru: [] },
    ...overrides,
  }
}

describe('compaction session isolation', () => {
  beforeEach(() => {
    // Clean up any global singleton state
    const { initContextCollapse, resetContextCollapse } =
      require('../src/services/contextCollapse/index.ts')
    initContextCollapse()
    resetContextCollapse()
  })

  test('each QueryEngine has its own ContextCollapseSession instance', async () => {
    const summarize1 = mock(async () => 'engine-1 summary')
    const summarize2 = mock(async () => 'engine-2 summary')

    const config1 = createMinimalQueryEngineConfig()
    const config2 = createMinimalQueryEngineConfig()

    const engine1 = new QueryEngine(config1)
    const engine2 = new QueryEngine(config2)

    // Access the private contextCollapseSession fields (using bracket notation)
    const session1 = (engine1 as any).contextCollapseSession as ContextCollapseSession
    const session2 = (engine2 as any).contextCollapseSession as ContextCollapseSession

    // Verify they are different instances
    expect(session1).not.toBe(session2)
    expect(session1).toBeInstanceOf(ContextCollapseSession)
    expect(session2).toBeInstanceOf(ContextCollapseSession)
  })

  test('each QueryEngine has its own MicrocompactSession instance', async () => {
    const config1 = createMinimalQueryEngineConfig({
      userSpecifiedModel: 'model-1',
    })
    const config2 = createMinimalQueryEngineConfig({
      userSpecifiedModel: 'model-2',
    })

    const engine1 = new QueryEngine(config1)
    const engine2 = new QueryEngine(config2)

    // Access the private microcompactSession fields (using bracket notation)
    const session1 = (engine1 as any).microcompactSession as MicrocompactSession
    const session2 = (engine2 as any).microcompactSession as MicrocompactSession

    // Verify they are different instances
    expect(session1).not.toBe(session2)
    expect(session1).toBeInstanceOf(MicrocompactSession)
    expect(session2).toBeInstanceOf(MicrocompactSession)
  })

  test('context collapse state does not leak between engines', async () => {
    const summarize = mock(async () => 'summary')
    const recordCommit1 = mock(async () => {})
    const recordCommit2 = mock(async () => {})

    // Create two engines
    const config1 = createMinimalQueryEngineConfig()
    const config2 = createMinimalQueryEngineConfig()

    const engine1 = new QueryEngine(config1)
    const engine2 = new QueryEngine(config2)

    // Get their sessions
    const session1 = (engine1 as any).contextCollapseSession as ContextCollapseSession
    const session2 = (engine2 as any).contextCollapseSession as ContextCollapseSession

    // Manually add a collapse to session 1
    // Use the private methods to simulate a collapse
    ;(session1 as any).state.committed.push({
      collapseId: '0000000000000001',
      summaryUuid: randomUUID(),
      summaryContent: '<collapsed id="0000000000000001">test summary</collapsed>',
      summary: 'test summary',
      firstArchivedUuid: randomUUID(),
      lastArchivedUuid: randomUUID(),
      summaryMessage: { type: 'user', message: { role: 'user', content: 'test' } },
      archived: [],
    })

    // Verify stats are isolated
    expect(session1.stats.collapsedSpans).toBe(1)
    expect(session2.stats.collapsedSpans).toBe(0)
  })

  test('microcompact state does not leak between engines', async () => {
    const config1 = createMinimalQueryEngineConfig()
    const config2 = createMinimalQueryEngineConfig()

    const engine1 = new QueryEngine(config1)
    const engine2 = new QueryEngine(config2)

    const session1 = (engine1 as any).microcompactSession as MicrocompactSession
    const session2 = (engine2 as any).microcompactSession as MicrocompactSession

    // Modify session 1's cached state
    session1.cachedState.registeredTools.add('tool-1')
    session1.cachedState.toolOrder.push('tool-1')
    session1.cachedState.deletedRefs.add('ref-1')

    // Verify state is isolated
    expect(session1.cachedState.registeredTools.size).toBe(1)
    expect(session2.cachedState.registeredTools.size).toBe(0)
    expect(session1.cachedState.toolOrder).toEqual(['tool-1'])
    expect(session2.cachedState.toolOrder).toEqual([])
  })
})
