import { afterEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  isMcpServerDisabled,
  setMcpServerEnabled,
} from '../src/services/mcp/config.ts'
import { buildMcpToolName } from '../src/services/mcp/mcpStringUtils.ts'
import { normalizeNameForMCP } from '../src/services/mcp/normalization.ts'

const connections: Array<{ client: Client; server: Server }> = []
const disabledFixture = 'mcp-lifecycle-disabled-fixture'

afterEach(async () => {
  const openConnections = connections.splice(0)
  await Promise.allSettled(openConnections.map(({ client }) => client.close()))
  await Promise.allSettled(openConnections.map(({ server }) => server.close()))
  setMcpServerEnabled(disabledFixture, true)
})

function createTestServer(name: string, empty = false) {
  const server = new Server(
    { name, version: '1.2.3' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  )
  let callCount = 0

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: empty
      ? []
      : [
          {
            name: 'echo',
            description: 'Echo a value',
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
            },
            _meta: { source: name, capability: 'tools/list' },
          },
        ],
  }))
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: empty
      ? []
      : [
          {
            uri: `${name}://readme`,
            name: 'Readme',
            mimeType: 'text/plain',
          },
        ],
  }))
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: empty
      ? []
      : [
          {
            name: 'greeting',
            description: 'Create a greeting',
            arguments: [{ name: 'name', required: true }],
          },
        ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name === 'explode') {
      throw new Error(`intentional ${name} handler failure`)
    }
    if (request.params.name === 'tool-error') {
      return {
        content: [{ type: 'text', text: 'recoverable tool failure' }],
        isError: true,
        _meta: { source: name, outcome: 'tool-error' },
      }
    }

    callCount += 1
    const value = String(request.params.arguments?.value ?? '')
    return {
      content: [{ type: 'text', text: `${name}:${value}` }],
      structuredContent: { value, callCount },
      _meta: { source: name, outcome: 'success' },
    }
  })

  return {
    server,
    callCount: () => callCount,
  }
}

async function connect(server: Server): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'lifecycle-client', version: '1.0.0' })
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ])
  connections.push({ client, server })
  return client
}

function callTool(client: Client, name: string, value: string) {
  return client.request(
    {
      method: 'tools/call',
      params: { name, arguments: { value } },
    },
    CallToolResultSchema,
  )
}

describe('MCP SDK protocol lifecycle', () => {
  test('negotiates capabilities and enumerates tools, resources, and prompts', async () => {
    const fixture = createTestServer('alpha')
    const client = await connect(fixture.server)

    expect(client.getServerVersion()).toEqual({
      name: 'alpha',
      version: '1.2.3',
    })
    expect(client.getServerCapabilities()).toEqual({
      tools: {},
      resources: {},
      prompts: {},
    })

    const tools = await client.listTools()
    expect(tools.tools).toHaveLength(1)
    expect(tools.tools[0]).toMatchObject({
      name: 'echo',
      _meta: { source: 'alpha', capability: 'tools/list' },
    })

    const resources = await client.listResources()
    expect(resources.resources).toEqual([
      {
        uri: 'alpha://readme',
        name: 'Readme',
        mimeType: 'text/plain',
      },
    ])

    const prompts = await client.listPrompts()
    expect(prompts.prompts).toEqual([
      {
        name: 'greeting',
        description: 'Create a greeting',
        arguments: [{ name: 'name', required: true }],
      },
    ])
  })

  test('enumerates empty capability sets without fabricating entries', async () => {
    const client = await connect(createTestServer('empty', true).server)

    expect((await client.listTools()).tools).toEqual([])
    expect((await client.listResources()).resources).toEqual([])
    expect((await client.listPrompts()).prompts).toEqual([])
  })

  test('returns structured tool output and response metadata', async () => {
    const fixture = createTestServer('alpha')
    const client = await connect(fixture.server)

    const result = await callTool(client, 'echo', 'hello')

    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: 'alpha:hello' }])
    expect(result.structuredContent).toEqual({ value: 'hello', callCount: 1 })
    expect(result._meta).toEqual({ source: 'alpha', outcome: 'success' })
    expect(fixture.callCount()).toBe(1)
  })

  test('preserves isError and metadata for a recoverable tool failure', async () => {
    const client = await connect(createTestServer('alpha').server)

    const result = await callTool(client, 'tool-error', 'ignored')

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      { type: 'text', text: 'recoverable tool failure' },
    ])
    expect(result._meta).toEqual({ source: 'alpha', outcome: 'tool-error' })
  })

  test('rejects initialization when the transport peer is already closed', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await serverTransport.close()
    const client = new Client({ name: 'closed-peer-client', version: '1.0.0' })

    try {
      await expect(client.connect(clientTransport)).rejects.toThrow()
    } finally {
      await client.close()
    }
  })

  test('reconnects a fresh client to the same server without losing server state', async () => {
    const fixture = createTestServer('reconnectable')
    const first = await connect(fixture.server)
    expect((await callTool(first, 'echo', 'before')).structuredContent).toEqual({
      value: 'before',
      callCount: 1,
    })

    await first.close()
    await expect(callTool(first, 'echo', 'closed')).rejects.toThrow()

    const second = await connect(fixture.server)
    expect((await second.listTools()).tools.map(tool => tool.name)).toEqual([
      'echo',
    ])
    expect((await callTool(second, 'echo', 'after')).structuredContent).toEqual({
      value: 'after',
      callCount: 2,
    })
    expect(fixture.callCount()).toBe(2)
  })

  test('closes both request paths and tolerates repeated cleanup', async () => {
    const fixture = createTestServer('closable')
    const client = await connect(fixture.server)
    expect((await callTool(client, 'echo', 'open')).isError).toBeUndefined()

    await client.close()
    await client.close()
    await fixture.server.close()

    await expect(callTool(client, 'echo', 'closed')).rejects.toThrow()
  })

  test('isolates concurrent servers and recovers after a handler exception', async () => {
    const healthy = createTestServer('healthy')
    const flaky = createTestServer('flaky')
    const [healthyClient, flakyClient] = await Promise.all([
      connect(healthy.server),
      connect(flaky.server),
    ])

    const [failed, succeeded] = await Promise.allSettled([
      callTool(flakyClient, 'explode', 'failure'),
      callTool(healthyClient, 'echo', 'still-running'),
    ])

    expect(failed.status).toBe('rejected')
    expect(succeeded.status).toBe('fulfilled')
    if (succeeded.status === 'fulfilled') {
      expect(succeeded.value._meta).toEqual({
        source: 'healthy',
        outcome: 'success',
      })
    }

    const recovered = await callTool(flakyClient, 'echo', 'recovered')
    expect(recovered.isError).toBeUndefined()
    expect(recovered._meta).toEqual({ source: 'flaky', outcome: 'success' })
  })
})

describe('MCP production configuration and naming', () => {
  test('toggles the real disabled-server configuration branch', () => {
    expect(process.env.NODE_ENV).toBe('test')
    expect(isMcpServerDisabled(disabledFixture)).toBe(false)

    setMcpServerEnabled(disabledFixture, false)
    expect(isMcpServerDisabled(disabledFixture)).toBe(true)

    setMcpServerEnabled(disabledFixture, true)
    expect(isMcpServerDisabled(disabledFixture)).toBe(false)
  })

  test('normalizes server and tool names for qualified MCP identifiers', () => {
    expect(normalizeNameForMCP('My Server!')).toBe('My_Server_')
    expect(normalizeNameForMCP('server.name')).toBe('server_name')
    expect(normalizeNameForMCP('my-server')).toBe('my-server')
    expect(buildMcpToolName('My Server!', 'do-work')).toBe(
      'mcp__My_Server___do-work',
    )
  })
})
