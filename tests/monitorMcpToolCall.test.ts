import { afterEach, beforeAll, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  CancelTaskRequestSchema,
  CreateTaskResultSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import { createLinkedTransportPair } from '../src/services/mcp/InProcessTransport.ts'
import type { ConnectedMCPServer } from '../src/services/mcp/types.ts'
import { getDefaultAppState } from '../src/state/AppStateStore.ts'
import type { AppState } from '../src/state/AppState.ts'
import { resetCommandQueue } from '../src/utils/messageQueueManager.ts'

let callTool: typeof import('../src/services/mcp/client.ts').callMCPToolWithUrlElicitationRetry
let cleanup = async () => {}

beforeAll(async () => {
  ;({ callMCPToolWithUrlElicitationRetry: callTool } = await import(
    '../src/services/mcp/client.ts'
  ))
})

afterEach(async () => {
  resetCommandQueue()
  await cleanup()
})

test('MONITOR_TOOL call path sends SDK task augmentation and registers the returned remote ID', async () => {
  const remoteTask = {
    taskId: 'wire-remote-id',
    status: 'working' as const,
    ttl: null,
    createdAt: '2026-11-11T00:00:00.000Z',
    lastUpdatedAt: '2026-11-11T00:00:00.000Z',
    pollInterval: 60_000,
  }
  const taskOptions: unknown[] = []
  const cancelRequests: string[] = []
  const server = new Server(
    { name: 'wire-server', version: '1.0.0' },
    {
      capabilities: {
        tools: {},
        tasks: { cancel: {}, requests: { tools: { call: {} } } },
      },
    },
  )
  server.setRequestHandler(CallToolRequestSchema, async request => {
    taskOptions.push(request.params.task)
    return { task: remoteTask } as unknown as CallToolResult
  })
  server.setRequestHandler(CancelTaskRequestSchema, async request => {
    cancelRequests.push(request.params.taskId)
    return { ...remoteTask, status: 'cancelled' as const }
  })
  const client = new Client({ name: 'wire-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = createLinkedTransportPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const connected: ConnectedMCPServer = {
    name: 'wire-server',
    client,
    type: 'connected',
    capabilities: client.getServerCapabilities()!,
    config: { type: 'sdk', name: 'wire-server', scope: 'local' },
    cleanup: async () => {
      await client.close()
      await server.close()
    },
  }
  cleanup = connected.cleanup

  let state = getDefaultAppState()
  const setAppState = (update: (previous: AppState) => AppState) => {
    state = update(state)
  }
  const abortController = new AbortController()
  const result = await callTool({
    client: connected,
    clientConnection: connected,
    tool: 'slow-tool',
    args: {},
    signal: abortController.signal,
    getAppState: () => state,
    setAppState,
    taskSupport: 'required',
    taskMonitoringEnabled: true,
  })

  expect(taskOptions).toEqual([{}])
  expect(result.content).toContain('local task ID')
  const monitor = Object.values(state.tasks).find(
    task => task.type === 'monitor_mcp',
  )
  expect(monitor).toBeDefined()
  expect(monitor?.type).toBe('monitor_mcp')
  if (monitor?.type !== 'monitor_mcp') throw new Error('monitor not registered')
  expect(monitor.remoteTaskId).toBe('wire-remote-id')
  expect(monitor.id).not.toBe('wire-remote-id')

  abortController.abort()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(cancelRequests).toHaveLength(0)
  expect(monitor.status).toBe('running')
  expect(CreateTaskResultSchema.safeParse({ task: remoteTask }).success).toBe(true)
})
