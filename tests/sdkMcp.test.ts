import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import {
  createSdkMcpServer,
  tool,
} from '../src/entrypoints/agentSdkTypes.ts'

describe('SDK in-process MCP servers', () => {
  test('registers metadata and invokes tool handlers', async () => {
    const echo = tool(
      'echo',
      'Echo the provided text',
      { text: z.string() },
      async ({ text }) => ({
        content: [{ type: 'text', text }],
      }),
      { searchHint: 'echo text', alwaysLoad: true },
    )
    const server = createSdkMcpServer({ name: 'test-server', tools: [echo] })
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()

    try {
      await Promise.all([
        client.connect(clientTransport),
        server.instance.connect(serverTransport),
      ])

      const tools = await client.listTools()
      expect(tools.tools).toHaveLength(1)
      expect(tools.tools[0]?._meta).toEqual({
        'anthropic/searchHint': 'echo text',
        'anthropic/alwaysLoad': true,
      })

      const result = await client.callTool({
        name: 'echo',
        arguments: { text: 'SDK_MCP_OK' },
      })
      expect(result.content).toEqual([
        { type: 'text', text: 'SDK_MCP_OK' },
      ])
    } finally {
      await Promise.all([client.close(), server.instance.close()])
    }
  })
})
