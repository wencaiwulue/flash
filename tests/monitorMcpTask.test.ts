import { afterEach, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  CancelTaskRequestSchema,
  CreateTaskResultSchema,
  ErrorCode,
  GetTaskPayloadRequestSchema,
  GetTaskRequestSchema,
  ListTasksRequestSchema,
  McpError,
  type CallToolResult,
  type Task as McpTask,
} from '@modelcontextprotocol/sdk/types.js'
import { createLinkedTransportPair } from '../src/services/mcp/InProcessTransport.ts'
import type { ConnectedMCPServer } from '../src/services/mcp/types.ts'
import { callMCPToolWithUrlElicitationRetry } from '../src/services/mcp/client.ts'
import { getDefaultAppState } from '../src/state/AppStateStore.ts'
import type { AppState } from '../src/state/AppState.ts'
import {
  createMonitorMcpTask,
  killMonitorMcp,
  killMonitorMcpTasksForAgent,
  MonitorMcpTask,
  reconnectMonitorMcpTasksForServer,
} from '../src/tasks/MonitorMcpTask/MonitorMcpTask.ts'
import type { MonitorMcpTaskState } from '../src/tasks/MonitorMcpTask/MonitorMcpTask.ts'
import type { TaskState } from '../src/tasks/types.ts'
import { asAgentId } from '../src/types/ids.ts'
import {
  getCommandQueueSnapshot,
  resetCommandQueue,
} from '../src/utils/messageQueueManager.ts'
import { getTaskOutput } from '../src/utils/task/diskOutput.ts'
import { sleep } from '../src/utils/sleep.ts'

let sequence = 0
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  resetCommandQueue()
  while (cleanups.length) {
    await cleanups.pop()!()
  }
})

function remoteTask(
  remoteTaskId: string,
  status: McpTask['status'] = 'working',
  version = 0,
): McpTask {
  return {
    taskId: remoteTaskId,
    status,
    ttl: null,
    createdAt: '2026-11-11T00:00:00.000Z',
    lastUpdatedAt: new Date(
      Date.parse('2026-11-11T00:00:00.000Z') + version * 1000,
    ).toISOString(),
    pollInterval: 60_000,
  }
}

type FakeTasks = Awaited<ReturnType<typeof createFakeMcp>>

async function createFakeMcp(options?: {
  name?: string
  cancelCapability?: boolean
  listCapability?: boolean
  cancel?: (taskId: string) => Promise<McpTask>
  get?: (taskId: string) => Promise<McpTask>
}) {
  const name = options?.name ?? `fake-${++sequence}`
  const tasks = new Map<string, McpTask>()
  const cancelRequests: string[] = []
  const resultRequests: string[] = []
  const creationRequests: Array<Record<string, unknown> | undefined> = []
  let nextCreation: McpTask | undefined
  const server = new Server(
    { name, version: '1.0.0' },
    {
      capabilities: {
        tools: {},
        tasks: {
          ...(options?.cancelCapability === false ? {} : { cancel: {} }),
          ...(options?.listCapability === false ? {} : { list: {} }),
          requests: { tools: { call: {} } },
        },
      },
    },
  )
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.task) {
      creationRequests.push(request.params.task)
      const task = nextCreation ?? remoteTask(`${name}-remote`)
      tasks.set(task.taskId, task)
      nextCreation = undefined
      // The SDK's base ServerResult union predates task-augmented tools/call;
      // the public CreateTaskResultSchema validates this actual wire result.
      return { task } as unknown as CallToolResult
    }
    return { content: [{ type: 'text', text: 'ordinary result' }] }
  })
  server.setRequestHandler(GetTaskRequestSchema, async request => {
    const taskId = request.params.taskId
    if (options?.get) return options.get(taskId)
    const task = tasks.get(taskId)
    if (!task) {
      throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`)
    }
    return task
  })
  server.setRequestHandler(CancelTaskRequestSchema, async request => {
    const taskId = request.params.taskId
    cancelRequests.push(taskId)
    if (options?.cancel) return options.cancel(taskId)
    const previous = tasks.get(taskId)
    if (!previous) {
      throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`)
    }
    const cancelled = {
      ...previous,
      status: 'cancelled' as const,
      lastUpdatedAt: new Date(Date.parse(previous.lastUpdatedAt) + 1000).toISOString(),
    }
    tasks.set(taskId, cancelled)
    return cancelled
  })
  server.setRequestHandler(GetTaskPayloadRequestSchema, async request => {
    resultRequests.push(request.params.taskId)
    return {
      content: [{ type: 'text', text: `final result for ${request.params.taskId}` }],
    }
  })
  server.setRequestHandler(ListTasksRequestSchema, async () => ({
    tasks: [...tasks.values()],
  }))

  const client = new Client({ name: 'monitor-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = createLinkedTransportPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const connected: ConnectedMCPServer = {
    name,
    client,
    type: 'connected',
    capabilities: client.getServerCapabilities()!,
    config: { type: 'sdk', name, scope: 'local' },
    cleanup: async () => {
      await client.close()
      await server.close()
    },
  }
  const fake = {
    name,
    server,
    client,
    connected,
    tasks,
    cancelRequests,
    resultRequests,
    creationRequests,
    async createTask(
      task = remoteTask(`${name}-remote-${tasks.size + 1}`),
      signal?: AbortSignal,
    ) {
      nextCreation = task
      return client.request(
        {
          method: 'tools/call',
          params: { name: 'slow-tool', arguments: {} },
        },
        CreateTaskResultSchema,
        { task: {}, signal },
      )
    },
    async notify(task: McpTask) {
      tasks.set(task.taskId, task)
      await server.notification({
        method: 'notifications/tasks/status',
        params: task,
      })
    },
  }
  cleanups.push(fake.connected.cleanup)
  return fake
}

function appStateHarness() {
  let state = getDefaultAppState()
  return {
    get: () => state,
    set(update: (previous: AppState) => AppState) {
      state = update(state)
    },
  }
}

async function startMonitor(
  fake: FakeTasks,
  state: ReturnType<typeof appStateHarness>,
  task?: McpTask,
  agentId?: ReturnType<typeof asAgentId>,
  requestTimeoutMs = 1000,
) {
  const createResult = await fake.createTask(task)
  const handle = createMonitorMcpTask({
    server: fake.connected,
    toolName: 'slow-tool',
    createResult,
    getAppState: state.get,
    setAppState: state.set,
    agentId,
    requestTimeoutMs,
  })
  expect(handle).toBeDefined()
  return handle!
}

function localMonitor(state: AppState, taskId: string): MonitorMcpTaskState {
  const task = state.tasks[taskId]
  expect(task?.type).toBe('monitor_mcp')
  return task as MonitorMcpTaskState
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await sleep(5)
  }
  expect(predicate()).toBe(true)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('registers only schema-valid CreateTaskResult from a Tasks-capable server', async () => {
  const fake = await createFakeMcp()
  const state = appStateHarness()
  const createResult = await fake.createTask()

  expect(
    createMonitorMcpTask({
      server: fake.connected,
      toolName: 'slow-tool',
      createResult: { content: [{ type: 'text', text: 'ordinary' }] },
      getAppState: state.get,
      setAppState: state.set,
    }),
  ).toBeUndefined()
  expect(
    createMonitorMcpTask({
      server: { ...fake.connected, capabilities: { tools: {} } },
      toolName: 'slow-tool',
      createResult,
      getAppState: state.get,
      setAppState: state.set,
    }),
  ).toBeUndefined()
  expect(
    createMonitorMcpTask({
      server: fake.connected,
      toolName: 'slow-tool',
      createResult: {
        ...createResult,
        task: { ...createResult.task, taskId: '' },
      },
      getAppState: state.get,
      setAppState: state.set,
    }),
  ).toBeUndefined()
  expect(Object.keys(state.get().tasks)).toHaveLength(0)

  const handle = createMonitorMcpTask({
    server: fake.connected,
    toolName: 'slow-tool',
    createResult,
    getAppState: state.get,
    setAppState: state.set,
  })!
  expect(handle.taskId).not.toBe(handle.remoteTaskId)
  expect(handle.taskId).toStartWith('m')
  const task = localMonitor(state.get(), handle.taskId)
  expect(task.remoteTaskId).toBe(createResult.task.taskId)
  expect(task.serverName).toBe(fake.name)
  expect(task.remoteStatus).toBe('working')
})

test('an immediately completed CreateTaskResult follows the same result delivery path', async () => {
  const fake = await createFakeMcp()
  const state = appStateHarness()
  const handle = await startMonitor(
    fake,
    state,
    remoteTask('already-completed', 'completed'),
  )

  await waitFor(
    () =>
      localMonitor(state.get(), handle.taskId).status === 'completed' &&
      localMonitor(state.get(), handle.taskId).notified,
  )
  expect(fake.resultRequests).toEqual(['already-completed'])
  expect(await getTaskOutput(handle.taskId)).toContain(
    'final result for already-completed',
  )
  expect(localMonitor(state.get(), handle.taskId).notified).toBe(true)
})

test('maps notification states, rejects late updates, and delivers output once', async () => {
  const fake = await createFakeMcp()
  const state = appStateHarness()
  const created = remoteTask('states-remote')
  const handle = await startMonitor(fake, state, created)

  await fake.notify({ ...created, status: 'input_required', lastUpdatedAt: remoteTask('x', 'working', 1).lastUpdatedAt })
  await waitFor(() => localMonitor(state.get(), handle.taskId).remoteStatus === 'input_required')
  expect(localMonitor(state.get(), handle.taskId).status).toBe('running')

  const completed = {
    ...created,
    status: 'completed' as const,
    lastUpdatedAt: remoteTask('x', 'working', 2).lastUpdatedAt,
  }
  await fake.notify(completed)
  await waitFor(() => localMonitor(state.get(), handle.taskId).status === 'completed')
  await fake.notify({ ...created, status: 'working', lastUpdatedAt: remoteTask('x', 'working', 1).lastUpdatedAt })
  await fake.notify(completed)
  await sleep(20)

  const terminal = localMonitor(state.get(), handle.taskId)
  expect(terminal.status).toBe('completed')
  expect(terminal.endTime).toBeDefined()
  expect(fake.resultRequests).toEqual([created.taskId])
  expect(await getTaskOutput(handle.taskId)).toContain(`final result for ${created.taskId}`)
  const notifications = getCommandQueueSnapshot().filter(
    command =>
      command.mode === 'task-notification' && command.value.includes(handle.taskId),
  )
  expect(notifications).toHaveLength(1)

  for (const [remoteStatus, localStatus] of [
    ['failed', 'failed'],
    ['cancelled', 'killed'],
  ] as const) {
    const remote = remoteTask(`${remoteStatus}-remote`)
    const monitor = await startMonitor(fake, state, remote)
    await fake.notify({
      ...remote,
      status: remoteStatus,
      lastUpdatedAt: remoteTask('x', 'working', 1).lastUpdatedAt,
    })
    await waitFor(() => localMonitor(state.get(), monitor.taskId).status === localStatus)
    expect(localMonitor(state.get(), monitor.taskId).remoteStatus).toBe(remoteStatus)
  }
})

test('missing and non-MCP local IDs return false without network requests', async () => {
  const fake = await createFakeMcp()
  const state = appStateHarness()
  const handle = await startMonitor(fake, state)
  expect(await killMonitorMcp('missing', state.get, state.set)).toBe(false)
  state.set(previous => ({
    ...previous,
    tasks: {
      ...previous.tasks,
      shell: {
        ...localMonitor(previous, handle.taskId),
        type: 'local_bash',
      } as unknown as TaskState,
    },
  }))
  expect(await killMonitorMcp('shell', state.get, state.set)).toBe(false)
  expect(fake.cancelRequests).toHaveLength(0)
})

test('uses remoteTaskId for tasks/cancel and marks killed only after confirmation', async () => {
  const fake = await createFakeMcp()
  const state = appStateHarness()
  const handle = await startMonitor(fake, state)

  await MonitorMcpTask.kill(handle.taskId, state.set, state.get)
  expect(fake.cancelRequests).toEqual([handle.remoteTaskId])
  expect(fake.cancelRequests).not.toContain(handle.taskId)
  expect(localMonitor(state.get(), handle.taskId).status).toBe('killed')
  expect(localMonitor(state.get(), handle.taskId).remoteStatus).toBe('cancelled')

  expect(await killMonitorMcp(handle.taskId, state.get, state.set)).toBe(true)
  expect(fake.cancelRequests).toHaveLength(1)
})

test('shares in-flight cancellation and accepts a status notification as confirmation', async () => {
  const response = deferred<McpTask>()
  const fake = await createFakeMcp({ cancel: () => response.promise })
  const state = appStateHarness()
  const created = remoteTask('deferred-cancel')
  const handle = await startMonitor(fake, state, created)

  const first = killMonitorMcp(handle.taskId, state.get, state.set)
  const second = killMonitorMcp(handle.taskId, state.get, state.set)
  expect(second).toBe(first)
  await waitFor(() => fake.cancelRequests.length === 1)
  expect(localMonitor(state.get(), handle.taskId).status).toBe('running')
  expect(localMonitor(state.get(), handle.taskId).cancelRequested).toBe(true)

  await fake.notify({
    ...created,
    status: 'cancelled',
    lastUpdatedAt: remoteTask('x', 'working', 1).lastUpdatedAt,
  })
  expect(await first).toBe(true)
  expect(localMonitor(state.get(), handle.taskId).status).toBe('killed')
  response.resolve({
    ...created,
    status: 'cancelled',
    lastUpdatedAt: remoteTask('x', 'working', 1).lastUpdatedAt,
  })
  expect(fake.cancelRequests).toHaveLength(1)
})

test('does not claim cancellation when unsupported, rejected, non-terminal, or timed out', async () => {
  {
    const fake = await createFakeMcp({ cancelCapability: false })
    const state = appStateHarness()
    const handle = await startMonitor(fake, state)
    expect(await killMonitorMcp(handle.taskId, state.get, state.set)).toBe(false)
    expect(fake.cancelRequests).toHaveLength(0)
    expect(localMonitor(state.get(), handle.taskId).status).toBe('running')
  }
  {
    const fake = await createFakeMcp({
      cancel: taskId => Promise.resolve(remoteTask(taskId, 'working', 1)),
    })
    const state = appStateHarness()
    const handle = await startMonitor(fake, state)
    expect(await killMonitorMcp(handle.taskId, state.get, state.set)).toBe(false)
    expect(localMonitor(state.get(), handle.taskId).status).toBe('running')
    expect(localMonitor(state.get(), handle.taskId).error).toContain('not confirmed')
  }
  {
    const fake = await createFakeMcp({
      cancel: () => Promise.reject(new Error('connection lost')),
    })
    const state = appStateHarness()
    const handle = await startMonitor(fake, state)
    expect(await killMonitorMcp(handle.taskId, state.get, state.set)).toBe(false)
    expect(localMonitor(state.get(), handle.taskId).status).toBe('running')
    expect(localMonitor(state.get(), handle.taskId).error).toContain('connection lost')
  }
  {
    const never = deferred<McpTask>()
    const fake = await createFakeMcp({ cancel: () => never.promise })
    const state = appStateHarness()
    const handle = await startMonitor(fake, state, undefined, undefined, 20)
    expect(await killMonitorMcp(handle.taskId, state.get, state.set)).toBe(false)
    expect(localMonitor(state.get(), handle.taskId).status).toBe('running')
    expect(localMonitor(state.get(), handle.taskId).error).toContain('not confirmed')
    never.reject(new Error('test cleanup'))
  }
})

test('an actual transport disconnect leaves the remote task running and observable', async () => {
  let fake!: FakeTasks
  const never = deferred<McpTask>()
  fake = await createFakeMcp({
    cancel: () => {
      void fake.server.close()
      return never.promise
    },
  })
  const state = appStateHarness()
  const handle = await startMonitor(fake, state)

  expect(await killMonitorMcp(handle.taskId, state.get, state.set)).toBe(false)
  expect(localMonitor(state.get(), handle.taskId).status).toBe('running')
  expect(localMonitor(state.get(), handle.taskId).error).toContain('not confirmed')
  never.reject(new Error('test cleanup'))
})

test('unknown remote IDs fail without being mislabeled as cancelled', async () => {
  const fake = await createFakeMcp({
    cancel: taskId =>
      Promise.reject(
        new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`),
      ),
  })
  const state = appStateHarness()
  const handle = await startMonitor(fake, state)
  expect(await killMonitorMcp(handle.taskId, state.get, state.set)).toBe(false)
  expect(localMonitor(state.get(), handle.taskId).status).toBe('failed')
  expect(localMonitor(state.get(), handle.taskId).status).not.toBe('killed')
  expect(localMonitor(state.get(), handle.taskId).error).toContain('unknown')
})

test('agent cleanup counts only confirmed cancellations and leaves shell and other agents alone', async () => {
  const agentId = asAgentId('agent-a')
  const otherAgent = asAgentId('agent-b')
  const fake = await createFakeMcp({
    cancel: taskId =>
      Promise.resolve(
        remoteTask(
          taskId,
          taskId === 'confirm-agent' ? 'cancelled' : 'working',
          1,
        ),
      ),
  })
  const state = appStateHarness()
  const confirmed = await startMonitor(
    fake,
    state,
    remoteTask('confirm-agent'),
    agentId,
  )
  const unconfirmed = await startMonitor(
    fake,
    state,
    remoteTask('unconfirmed-agent'),
    agentId,
  )
  const other = await startMonitor(
    fake,
    state,
    remoteTask('other-agent'),
    otherAgent,
  )
  state.set(previous => ({
    ...previous,
    tasks: {
      ...previous.tasks,
      shell: {
        ...localMonitor(state.get(), confirmed.taskId),
        id: 'shell',
        type: 'local_bash',
        agentId,
        status: 'running',
      } as unknown as TaskState,
    },
  }))

  expect(
    await killMonitorMcpTasksForAgent(agentId, state.get, state.set),
  ).toBe(1)
  expect(localMonitor(state.get(), confirmed.taskId).status).toBe('killed')
  expect(localMonitor(state.get(), unconfirmed.taskId).status).toBe('running')
  expect(localMonitor(state.get(), other.taskId).status).toBe('running')
  expect(state.get().tasks.shell?.status).toBe('running')
  expect(fake.cancelRequests).toEqual([
    confirmed.remoteTaskId,
    unconfirmed.remoteTaskId,
  ])
})

test('reconnect reconciles registered IDs only and gets list-missing tasks', async () => {
  const name = `reconnect-${++sequence}`
  const oldFake = await createFakeMcp({ name })
  const state = appStateHarness()
  const listed = await startMonitor(oldFake, state, remoteTask('listed'))
  const completed = await startMonitor(oldFake, state, remoteTask('missing-completed'))
  const unknown = await startMonitor(oldFake, state, remoteTask('missing-unknown'))

  const newFake = await createFakeMcp({
    name,
    get: taskId => {
      if (taskId === 'missing-completed') {
        return Promise.resolve(remoteTask(taskId, 'completed', 2))
      }
      return Promise.reject(new Error('get failed after reconnect'))
    },
  })
  newFake.tasks.set('listed', remoteTask('listed', 'input_required', 2))
  newFake.tasks.set('unrelated', remoteTask('unrelated', 'cancelled', 2))

  await reconnectMonitorMcpTasksForServer(newFake.connected)
  await waitFor(() => localMonitor(state.get(), completed.taskId).status === 'completed')
  expect(localMonitor(state.get(), listed.taskId).remoteStatus).toBe('input_required')
  expect(localMonitor(state.get(), unknown.taskId).status).toBe('running')
  expect(localMonitor(state.get(), unknown.taskId).error).toContain('get failed')
  expect(Object.values(state.get().tasks).filter(task => task.type === 'monitor_mcp')).toHaveLength(3)
  expect(newFake.cancelRequests).toHaveLength(0)
})

test('ordinary tools/call stays synchronous without registering a monitor', async () => {
  const fake = await createFakeMcp()
  const state = appStateHarness()
  const ordinary = await callMCPToolWithUrlElicitationRetry({
    client: fake.connected,
    clientConnection: fake.connected,
    tool: 'slow-tool',
    args: {},
    signal: new AbortController().signal,
    getAppState: state.get,
    setAppState: state.set,
  })
  expect(ordinary.content).toEqual([
    { type: 'text', text: 'ordinary result' },
  ])
  expect(Object.keys(state.get().tasks)).toHaveLength(0)
  expect(fake.creationRequests).toHaveLength(0)
})

test('aborting local tool-call waiting never issues an implicit remote task cancel', async () => {
  const fake = await createFakeMcp()
  const state = appStateHarness()
  const abortController = new AbortController()
  const createResult = await fake.createTask(
    remoteTask('abort-local-only'),
    abortController.signal,
  )
  const handle = createMonitorMcpTask({
    server: fake.connected,
    toolName: 'slow-tool',
    createResult,
    getAppState: state.get,
    setAppState: state.set,
  })!

  abortController.abort()
  await sleep(20)
  expect(fake.cancelRequests).toHaveLength(0)
  expect(localMonitor(state.get(), handle.taskId).status).toBe('running')
})

test('CallToolResultSchema remains distinct from CreateTaskResultSchema', () => {
  const ordinary = CallToolResultSchema.parse({
    content: [{ type: 'text', text: 'done' }],
  })
  expect('task' in ordinary).toBe(false)
  expect(CreateTaskResultSchema.safeParse(ordinary).success).toBe(false)
})
