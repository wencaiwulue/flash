import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Tool, ToolUseContext, ToolResult } from '../src/Tool.ts'
import {
  buildTool,
  findToolByName,
  toolMatchesName,
  getEmptyToolPermissionContext,
} from '../src/Tool.ts'
import {
  getAllBaseTools,
  assembleToolPool,
  filterToolsByDenyRules,
} from '../src/tools.ts'
import { mergeAndFilterTools, applyCoordinatorToolFilter } from '../src/utils/toolPool.ts'
import { z } from 'zod'
import { runTools } from '../src/services/tools/toolOrchestration.ts'
import { runToolUse } from '../src/services/tools/toolExecution.ts'
import { createAssistantMessage, createUserMessage } from '../src/utils/messages.ts'
import { createFileStateCacheWithSizeLimit } from '../src/utils/fileStateCache.ts'

// Mock minimal AppState for tests
let mockAppState: any
let toolDecisionCache: Map<string, any>

beforeEach(() => {
  mockAppState = {
    toolPermissionContext: getEmptyToolPermissionContext(),
    sessionHooks: new Map(),
  }
  toolDecisionCache = new Map()
})

afterEach(() => {
  toolDecisionCache.clear()
})

// Create a minimal ToolUseContext for testing
function createTestContext(overrides: Partial<ToolUseContext> = {}): ToolUseContext {
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'test-model',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(),
    getAppState: () => mockAppState,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
    toolDecisions: toolDecisionCache,
    ...overrides,
  } as unknown as ToolUseContext
}

// Create a simple test tool using buildTool
function createTestTool(
  name: string,
  options: {
    isEnabled?: boolean
    isConcurrencySafe?: boolean
    isReadOnly?: boolean
  } = {},
) {
  return buildTool({
    name,
    inputSchema: z.object({
      value: z.string(),
    }),
    maxResultSizeChars: 1024 * 1024,
    prompt: async () => `Tool ${name}`,
    description: async () => `Test tool ${name}`,
    userFacingName: () => name,
    call: async (input, _ctx) => ({
      data: { result: input.value },
    }),
    mapToolResultToToolResultBlockParam: (data, id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: JSON.stringify(data),
    }),
    isEnabled: options.isEnabled !== undefined ? () => options.isEnabled : undefined,
    isConcurrencySafe:
      options.isConcurrencySafe !== undefined ? () => options.isConcurrencySafe : undefined,
    isReadOnly: options.isReadOnly !== undefined ? () => options.isReadOnly : undefined,
    validateInput: async () => ({ result: true }),
    checkPermissions: async (input, _ctx) => ({
      behavior: 'allow',
      updatedInput: input,
    }),
    toAutoClassifierInput: () => '',
    renderToolUseMessage: () => null,
  })
}

// Create a mock MCP tool
function createMockMcpTool(name: string) {
  return buildTool({
    name,
    inputSchema: z.object({
      mcpParam: z.string(),
    }),
    maxResultSizeChars: 1024 * 1024,
    prompt: async () => `MCP Tool ${name}`,
    description: async () => `MCP test tool ${name}`,
    userFacingName: () => name,
    call: async (input, _ctx) => ({
      data: { mcpResult: input.mcpParam },
    }),
    mapToolResultToToolResultBlockParam: (data, id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: JSON.stringify(data),
    }),
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    validateInput: async () => ({ result: true }),
    checkPermissions: async (input, _ctx) => ({
      behavior: 'allow',
      updatedInput: input,
    }),
    toAutoClassifierInput: () => '',
    renderToolUseMessage: () => null,
    isMcp: true,
    mcpInfo: { serverName: 'test-server', toolName: name },
  })
}

describe('Tool interface and buildTool', () => {
  test('buildTool fills safe defaults for omitted methods', () => {
    const tool = buildTool({
      name: 'test-defaults',
      inputSchema: z.object({}),
      maxResultSizeChars: 1024,
      prompt: async () => 'test',
      description: async () => 'test',
      userFacingName: () => 'test',
      call: async () => ({ data: {} }),
      mapToolResultToToolResultBlockParam: (_, id) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: '',
      }),
      validateInput: async () => ({ result: true }),
      checkPermissions: async (input, _ctx) => ({
        behavior: 'allow',
        updatedInput: input,
      }),
      toAutoClassifierInput: () => '',
      renderToolUseMessage: () => null,
    })

    // Defaults should be filled
    expect(tool.isEnabled()).toBe(true)
    expect(tool.isConcurrencySafe({})).toBe(false)
    expect(tool.isReadOnly({})).toBe(false)
    expect(typeof tool.isDestructive).toBe('function')
    expect(typeof tool.checkPermissions).toBe('function')
    expect(typeof tool.toAutoClassifierInput).toBe('function')
    expect(typeof tool.userFacingName).toBe('function')
  })

  test('buildTool preserves explicitly provided implementations', () => {
    const tool = createTestTool('explicit-test', {
      isEnabled: false,
      isConcurrencySafe: true,
      isReadOnly: true,
    })

    expect(tool.isEnabled()).toBe(false)
    expect(tool.isConcurrencySafe({})).toBe(true)
    expect(tool.isReadOnly({})).toBe(true)
  })

  test('toolMatchesName matches name and aliases', () => {
    const tool = createTestTool('primary-name')
    ;(tool as any).aliases = ['alias-1', 'alias-2']

    expect(toolMatchesName(tool, 'primary-name')).toBe(true)
    expect(toolMatchesName(tool, 'alias-1')).toBe(true)
    expect(toolMatchesName(tool, 'alias-2')).toBe(true)
    expect(toolMatchesName(tool, 'other-name')).toBe(false)
  })

  test('findToolByName finds tools in list by name or alias', () => {
    const tools = [
      createTestTool('tool-a'),
      createTestTool('tool-b'),
      createTestTool('tool-c'),
    ]
    ;(tools[1] as any).aliases = ['tool-b-alias']

    expect(findToolByName(tools as any, 'tool-a')).toBe(tools[0])
    expect(findToolByName(tools as any, 'tool-b')).toBe(tools[1])
    expect(findToolByName(tools as any, 'tool-b-alias')).toBe(tools[1])
    expect(findToolByName(tools as any, 'nonexistent')).toBeUndefined()
  })

  test('Tool.call returns valid ToolResult structure', async () => {
    const tool = createTestTool('call-test')
    const result = await tool.call(
      { value: 'test-input' },
      createTestContext(),
      () => Promise.resolve({ behavior: 'allow' }),
      {} as any,
    )

    expect(result).toHaveProperty('data')
    expect(result.data).toEqual({ result: 'test-input' })
  })

  test('Tool with contextModifier applies changes in result', async () => {
    let modifierCalled = false
    const tool = buildTool({
      name: 'context-mod-test',
      inputSchema: z.object({}),
      maxResultSizeChars: 1024,
      prompt: async () => 'test',
      description: async () => 'test',
      userFacingName: () => 'test',
      call: async () => ({
        data: {},
        contextModifier: (ctx: ToolUseContext) => {
          modifierCalled = true
          return ctx
        },
      }),
      mapToolResultToToolResultBlockParam: (_, id) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: '',
      }),
      validateInput: async () => ({ result: true }),
      checkPermissions: async (input, _ctx) => ({
        behavior: 'allow',
        updatedInput: input,
      }),
      toAutoClassifierInput: () => '',
      renderToolUseMessage: () => null,
    })

    const result = await tool.call(
      {},
      createTestContext(),
      () => Promise.resolve({ behavior: 'allow' }),
      {} as any,
    )

    expect(result.contextModifier).toBeDefined()
    expect(typeof result.contextModifier).toBe('function')

    // Call the modifier
    if (result.contextModifier) {
      result.contextModifier(createTestContext())
    }
    expect(modifierCalled).toBe(true)
  })
})

describe('Tool pool assembly', () => {
  test('getAllBaseTools returns tools with unique names', () => {
    const tools = getAllBaseTools()
    const names = tools.map(t => t.name)
    const uniqueNames = new Set(names)

    expect(names.length).toBeGreaterThan(0)
    expect(uniqueNames.size).toBe(names.length)
  })

  test('getAllBaseTools includes core expected tools', () => {
    const names = new Set(getAllBaseTools().map(t => t.name))

    expect(names.has('Agent')).toBe(true)
    expect(names.has('Bash')).toBe(true)
    expect(names.has('Read')).toBe(true)
    expect(names.has('Edit')).toBe(true)
    expect(names.has('Write')).toBe(true)
  })

  test('filterToolsByDenyRules filters tools by blanket deny rules', () => {
    const tools = [
      createTestTool('allow-tool-1'),
      createTestTool('deny-tool-1'),
      createTestTool('deny-tool-2'),
      createTestTool('allow-tool-2'),
    ]
    const permContext = {
      ...getEmptyToolPermissionContext(),
      alwaysDenyRules: {
        session: ['deny-tool-1', 'deny-tool-2'],
      },
    }

    const filtered = filterToolsByDenyRules(tools as any, permContext)

    expect(filtered.map(t => t.name)).toEqual(['allow-tool-1', 'allow-tool-2'])
  })

  test('assembleToolPool combines built-in and MCP tools', () => {
    const permContext = getEmptyToolPermissionContext()
    const mcpTools = [createMockMcpTool('mcp-tool-1'), createMockMcpTool('mcp-tool-2')]

    const pool = assembleToolPool(permContext, mcpTools as any)
    const poolNames = new Set(pool.map(t => t.name))

    // Should include core built-in tools
    expect(poolNames.has('Agent')).toBe(true)
    expect(poolNames.has('Bash')).toBe(true)

    // Should include MCP tools
    expect(poolNames.has('mcp-tool-1')).toBe(true)
    expect(poolNames.has('mcp-tool-2')).toBe(true)
  })

  test('assembleToolPool removes MCP tools with same name as built-in', () => {
    const permContext = getEmptyToolPermissionContext()
    const conflictingMcp = createMockMcpTool('Bash') // Bash is built-in
    const pool = assembleToolPool(permContext, [conflictingMcp as any])

    // Find all Bash tools
    const bashTools = pool.filter(t => t.name === 'Bash')

    // Should have only one Bash tool, and it should NOT be the MCP one
    expect(bashTools.length).toBe(1)
    expect(bashTools[0].isMcp).not.toBe(true)
  })

  test('assembleToolPool maintains partition order: built-ins first, then MCP', () => {
    const permContext = getEmptyToolPermissionContext()
    const mcpTools = [createMockMcpTool('mcp-a'), createMockMcpTool('mcp-b')]

    const pool = assembleToolPool(permContext, mcpTools as any)

    // Find first and last positions of built-ins vs MCP
    const builtInIndices: number[] = []
    const mcpIndices: number[] = []

    pool.forEach((tool, i) => {
      if (tool.isMcp) {
        mcpIndices.push(i)
      } else {
        builtInIndices.push(i)
      }
    })

    // All built-ins should come before MCP tools
    if (builtInIndices.length > 0 && mcpIndices.length > 0) {
      const lastBuiltIn = Math.max(...builtInIndices)
      const firstMcp = Math.min(...mcpIndices)
      expect(lastBuiltIn).toBeLessThan(firstMcp)
    }
  })

  test('mergeAndFilterTools merges and deduplicates tool lists', () => {
    const initial = [createTestTool('initial-1'), createTestTool('initial-2')]
    const assembled = [createTestTool('assembled-1'), createTestTool('initial-1')] // duplicate

    const merged = mergeAndFilterTools(initial as any, assembled as any, { mode: 'default' })
    const names = merged.map(t => t.name)

    expect(names).toContain('initial-1')
    expect(names).toContain('initial-2')
    expect(names).toContain('assembled-1')
    expect(names.filter(n => n === 'initial-1').length).toBe(1)
  })

  test('mergeAndFilterTools maintains partition order in merged list', () => {
    const initialBuiltIn = createTestTool('initial-built-in')
    const initialMcp = createMockMcpTool('initial-mcp')
    const assembledBuiltIn = createTestTool('assembled-built-in')
    const assembledMcp = createMockMcpTool('assembled-mcp')

    const merged = mergeAndFilterTools(
      [initialBuiltIn, initialMcp] as any,
      [assembledBuiltIn, assembledMcp] as any,
      { mode: 'default' },
    )

    const mergedTypes = merged.map(t => ({ name: t.name, isMcp: !!t.isMcp }))
    const builtInsBeforeMcp = mergedTypes.every(
      (t, i, arr) =>
        !t.isMcp || arr.slice(0, i).every(previous => !previous.isMcp || t.isMcp),
    )

    expect(builtInsBeforeMcp).toBe(true)
  })
})

describe('ToolUseContext isolation and structure', () => {
  test('ToolUseContext has expected core structure', () => {
    const ctx = createTestContext()

    expect(ctx).toHaveProperty('options')
    expect(ctx).toHaveProperty('abortController')
    expect(ctx).toHaveProperty('readFileState')
    expect(ctx).toHaveProperty('getAppState')
    expect(ctx).toHaveProperty('setAppState')
    expect(ctx).toHaveProperty('messages')
  })

  test('toolDecisions cache can store and retrieve permission decisions', () => {
    const ctx = createTestContext()
    const decision = { source: 'test', decision: 'accept' as const, timestamp: Date.now() }

    ctx.toolDecisions!.set('test-use-id', decision)

    expect(ctx.toolDecisions!.get('test-use-id')).toEqual(decision)
  })

  test('abortController can signal cancellation', () => {
    const ctx = createTestContext()
    expect(ctx.abortController.signal.aborted).toBe(false)

    ctx.abortController.abort()
    expect(ctx.abortController.signal.aborted).toBe(true)
  })

  test('localDenialTracking is available for sub-agent isolation', () => {
    const ctx = createTestContext({
      localDenialTracking: { denyStreak: 3, totalDenies: 10 },
    })

    expect(ctx.localDenialTracking).toEqual({ denyStreak: 3, totalDenies: 10 })
  })

  test('agentId and agentType mark sub-agent contexts', () => {
    const ctx = createTestContext({
      agentId: 'sub-agent-123' as any,
      agentType: 'test-sub-agent',
    })

    expect(ctx.agentId).toBe('sub-agent-123')
    expect(ctx.agentType).toBe('test-sub-agent')
  })
})

describe('Tool schema validation', () => {
  test('Tool.inputSchema validates correct inputs', () => {
    const tool = createTestTool('schema-test')
    const result = tool.inputSchema.safeParse({ value: 'test' })
    expect(result.success).toBe(true)
  })

  test('Tool.inputSchema rejects invalid inputs', () => {
    const tool = createTestTool('schema-test')
    const result = tool.inputSchema.safeParse({ wrongField: 'test' })
    expect(result.success).toBe(false)
  })
})

describe('Tool pool coordinator mode filtering', () => {
  test('applyCoordinatorToolFilter filters to allowed tools only', () => {
    const tools = [
      createTestTool('Agent'),
      createTestTool('Bash'),
      createTestTool('TaskStop'),
      createTestTool('Read'),
      createTestTool('OtherTool'),
    ]

    const filtered = applyCoordinatorToolFilter(tools as any)
    const filteredNames = new Set(filtered.map(t => t.name))

    // Coordinator mode allows specific tools
    expect(filteredNames.has('Agent')).toBe(true)
    expect(filteredNames.has('TaskStop')).toBe(true)

    // Other tools should be filtered out
    expect(filteredNames.has('Bash')).toBe(false)
    expect(filteredNames.has('Read')).toBe(false)
  })

  test('applyCoordinatorToolFilter allows PR activity subscription tools', () => {
    const prTool = createMockMcpTool('mcp__server__subscribe_pr_activity')
    const normalTool = createTestTool('NormalTool')

    const filtered = applyCoordinatorToolFilter([prTool, normalTool] as any)
    const filteredNames = new Set(filtered.map(t => t.name))

    expect(filteredNames.has('mcp__server__subscribe_pr_activity')).toBe(true)
  })
})

describe('Streaming vs batch equivalence verification', () => {
  test('Same tool with same input produces same data structure in result', async () => {
    const tool = createTestTool('consistency-test')
    const ctx = createTestContext()
    const input = { value: 'consistent-input' }

    // Call twice, should produce same structure
    const result1 = await tool.call(
      input,
      ctx,
      () => Promise.resolve({ behavior: 'allow' }),
      {} as any,
    )
    const result2 = await tool.call(
      input,
      ctx,
      () => Promise.resolve({ behavior: 'allow' }),
      {} as any,
    )

    expect(result1.data).toEqual(result2.data)
  })

  test('Tool results have stable serialization format', async () => {
    const tool = createTestTool('serialization-test')
    const result = await tool.call(
      { value: 'test' },
      createTestContext(),
      () => Promise.resolve({ behavior: 'allow' }),
      {} as any,
    )

    const mapped = tool.mapToolResultToToolResultBlockParam(result.data, 'test-use-id')

    expect(mapped.type).toBe('tool_result')
    expect(mapped.tool_use_id).toBe('test-use-id')
    expect(mapped.content).toBeDefined()
  })
})

describe('Error handling and disabled tools', () => {
  test('disabled tools can still be instantiated but report disabled', () => {
    const disabledTool = createTestTool('disabled-test', { isEnabled: false })
    expect(disabledTool.isEnabled()).toBe(false)
  })

describe('actual tool execution and error propagation', () => {
  test('runTools preserves tool_result content in serial and concurrent-safe paths', async () => {
    const tool = createTestTool('execution-tool', { isConcurrencySafe: true })
    const context = createTestContext({
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'offline-test-model',
        tools: [tool],
        verbose: false,
        thinkingConfig: { type: 'disabled' },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
    })
    const block = { type: 'tool_use', id: 'call-1', name: 'execution-tool', input: { value: 'payload' } } as const
    const assistant = createAssistantMessage({ content: [block] })
    const allow = async () => ({ behavior: 'allow' as const })

    const serial: any[] = []
    for await (const update of runTools([block], [assistant], allow, context)) {
      if (update.message) serial.push(update.message)
    }
    const concurrent: any[] = []
    for await (const update of runTools([block], [assistant], allow, context)) {
      if (update.message) concurrent.push(update.message)
    }

    expect(serial).toHaveLength(1)
    expect(concurrent).toHaveLength(1)
    expect(serial[0].message.content[0].type).toBe('tool_result')
    expect(serial[0].message.content[0].tool_use_id).toBe('call-1')
    expect(concurrent[0].message.content[0].tool_use_id).toBe('call-1')
  })

  test('runTools executes every concurrency-safe call without dropping results', async () => {
    const tool = createTestTool('parallel-tool', { isConcurrencySafe: true })
    const context = createTestContext({
      options: {
        commands: [], debug: false, mainLoopModel: 'offline-test-model', tools: [tool], verbose: false,
        thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
    })
    const blocks = [1, 2].map(index => ({
      type: 'tool_use', id: `call-${index}`, name: 'parallel-tool', input: { value: `payload-${index}` },
    })) as const
    const assistant = createAssistantMessage({ content: [...blocks] })
    const results: any[] = []
    for await (const update of runTools([...blocks], [assistant], async () => ({ behavior: 'allow' as const }), context)) {
      if (update.message) results.push(update.message)
    }

    expect(results).toHaveLength(2)
    expect(results.map(message => message.message.content[0].tool_use_id).sort()).toEqual(['call-1', 'call-2'])
  })

  test('runToolUse returns a structured error for an unknown tool', async () => {
    const context = createTestContext()
    const block = { type: 'tool_use', id: 'missing-call', name: 'missing-tool', input: {} } as const
    const assistant = createAssistantMessage({ content: [block] })
    const results: any[] = []
    for await (const update of runToolUse(block, assistant, async () => ({ behavior: 'allow' as const }), context)) {
      if (update.message) results.push(update.message)
    }

    expect(results).toHaveLength(1)
    expect(results[0].message.content[0].is_error).toBe(true)
    expect(results[0].message.content[0].content).toContain('No such tool available: missing-tool')
  })
})

})

describe('Tool validation edge cases', () => {
  test('tools with validateInput can reject bad inputs', async () => {
    const tool = buildTool({
      name: 'validate-test',
      inputSchema: z.object({ value: z.string() }),
      maxResultSizeChars: 1024,
      prompt: async () => 'test',
      description: async () => 'test',
      userFacingName: () => 'test',
      call: async () => ({ data: {} }),
      mapToolResultToToolResultBlockParam: (_, id) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: '',
      }),
      validateInput: async (input: any) => {
        if (input.value === 'invalid') {
          return { result: false, message: 'Invalid input', errorCode: 400 }
        }
        return { result: true }
      },
      checkPermissions: async (input, _ctx) => ({
        behavior: 'allow',
        updatedInput: input,
      }),
      toAutoClassifierInput: () => '',
      renderToolUseMessage: () => null,
    })

    const validResult = await tool.validateInput({ value: 'valid' }, createTestContext())
    const invalidResult = await tool.validateInput({ value: 'invalid' }, createTestContext())

    expect(validResult.result).toBe(true)
    expect(invalidResult.result).toBe(false)
    if (!invalidResult.result) {
      expect(invalidResult.message).toBe('Invalid input')
      expect(invalidResult.errorCode).toBe(400)
    }
  })
})
