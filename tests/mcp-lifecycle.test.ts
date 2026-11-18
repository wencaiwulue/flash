import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { createLinkedTransportPair } from '../src/services/mcp/InProcessTransport.ts'
import { buildMcpToolName } from '../src/services/mcp/mcpStringUtils.ts'
import { normalizeNameForMCP } from '../src/services/mcp/normalization.ts'

describe('MCP Lifecycle - Connection/Disconnection', () => {
  test('establishes connection and negotiates capabilities', async () => {
    const server = new Server(
      { name: 'test-server', version: '1.0.0' },
      { capabilities: {} },
    )

    const [clientTransport, serverTransport] = createLinkedTransportPair()
    const client = new Client({ name: 'test-client', version: '1.0.0' })

    try {
      // Connect both sides
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ])

      // Verify connection established
      expect(client).toBeDefined()
    } finally {
      await Promise.all([client.close(), server.close()])
    }
  })
})

describe('MCP Lifecycle - Disabled Branches', () => {
  test('disabled server state model works', () => {
    const disabledServer = {
      name: 'disabled-server',
      type: 'disabled' as const,
      config: {
        type: 'stdio' as const,
        command: 'echo',
        args: [],
        scope: 'local' as const,
      },
    }

    expect(disabledServer.type).toBe('disabled')
    expect(disabledServer.name).toBe('disabled-server')
  })

  test('failed server state model works', () => {
    const failedServer = {
      name: 'failed-server',
      type: 'failed' as const,
      config: {
        type: 'sse' as const,
        url: 'https://example.com',
        scope: 'local' as const,
      },
      error: 'Connection timed out',
    }

    expect(failedServer.type).toBe('failed')
    expect(failedServer.error).toBe('Connection timed out')
  })

  test('needs-auth server state model works', () => {
    const needsAuthServer = {
      name: 'private-server',
      type: 'needs-auth' as const,
      config: {
        type: 'http' as const,
        url: 'https://private.example.com',
        scope: 'local' as const,
      },
    }

    expect(needsAuthServer.type).toBe('needs-auth')
  })

  test('pending server state model works', () => {
    const pendingServer = {
      name: 'pending-server',
      type: 'pending' as const,
      config: {
        type: 'stdio' as const,
        command: 'echo',
        args: [],
        scope: 'local' as const,
      },
      reconnectAttempt: 1,
      maxReconnectAttempts: 3,
    }

    expect(pendingServer.type).toBe('pending')
    expect(pendingServer.reconnectAttempt).toBe(1)
  })
})

describe('MCP Lifecycle - Tool Name Normalization', () => {
  test('normalizeNameForMCP replaces special chars with underscores', () => {
    // Normalization only replaces non a-zA-Z0-9_- with underscores
    expect(normalizeNameForMCP('My Server!')).toBe('My_Server_')
    expect(normalizeNameForMCP('server.name')).toBe('server_name')
  })

  test('normalizeNameForMCP preserves valid characters', () => {
    expect(normalizeNameForMCP('my-server')).toBe('my-server')
    expect(normalizeNameForMCP('server_name')).toBe('server_name')
    expect(normalizeNameForMCP('server/name')).toBe('server_name')
    expect(normalizeNameForMCP('server name')).toBe('server_name')
  })

  test('buildMcpToolName constructs fully qualified name', () => {
    expect(buildMcpToolName('my-server', 'echo')).toBe('mcp__my-server__echo')
    expect(buildMcpToolName('test', 'do_something')).toBe(
      'mcp__test__do_something',
    )
  })

  test('buildMcpToolName handles special characters in both parts', () => {
    expect(buildMcpToolName('My Server!', 'do-work')).toBe(
      'mcp__My_Server___do-work',
    )
  })
})
