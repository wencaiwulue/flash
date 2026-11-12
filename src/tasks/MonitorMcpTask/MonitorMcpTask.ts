import {
  CallToolResultSchema,
  CancelTaskResultSchema,
  CreateTaskResultSchema,
  ErrorCode,
  GetTaskResultSchema,
  ListTasksResultSchema,
  McpError,
  TaskStatusNotificationSchema,
  type Task as RemoteMcpTask,
  type TaskStatus as RemoteMcpTaskStatus,
} from '@modelcontextprotocol/sdk/types.js'
import type { AppState } from '../../state/AppState.js'
import {
  createTaskStateBase,
  generateTaskId,
  isTerminalTaskStatus,
  type SetAppState,
  type Task,
  type TaskStateBase,
  type TaskStatus,
} from '../../Task.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../../utils/debug.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import {
  appendTaskOutput,
  evictTaskOutput,
  flushTaskOutput,
} from '../../utils/task/diskOutput.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'
import { escapeXml } from '../../utils/xml.js'
import type { ConnectedMCPServer } from '../../services/mcp/types.js'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'

export type MonitorMcpTaskState = TaskStateBase & {
  type: 'monitor_mcp'
  agentId?: AgentId
  error?: string
  serverName: string
  toolName: string
  remoteTaskId: string
  remoteStatus: RemoteMcpTaskStatus
  cancelRequested: boolean
  pollIntervalMs?: number
  lastRemoteUpdateAt?: number
}

type MonitorRuntime = {
  localTaskId: string
  server: ConnectedMCPServer
  remoteTaskId: string
  toolName: string
  getAppState: () => AppState
  setAppState: SetAppState
  toolUseId?: string
  agentId?: AgentId
  description: string
  timer?: NodeJS.Timeout
  updateChain: Promise<void>
  lastRemoteTimestamp: number
  pollFailures: number
  terminal: boolean
  resultRequested: boolean
  cancelWaiters: Set<() => void>
  requestTimeoutMs: number
}

export type CreateMonitorMcpTaskOptions = {
  server: ConnectedMCPServer
  toolName: string
  createResult: unknown
  getAppState: () => AppState
  setAppState: SetAppState
  toolUseId?: string
  agentId?: AgentId
  description?: string
  requestTimeoutMs?: number
}

const monitors = new Map<string, MonitorRuntime>()
const remoteTaskOwners = new Map<string, string>()
const cancellationRequests = new Map<string, Promise<boolean>>()
const instrumentedClients = new WeakSet<ConnectedMCPServer['client']>()

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const MAX_POLL_INTERVAL_MS = 30_000
const MAX_LIST_PAGES = 100
const AGENT_CLEANUP_CONCURRENCY = 4

function remoteKey(serverName: string, remoteTaskId: string): string {
  return JSON.stringify([serverName, remoteTaskId])
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function remoteToLocalStatus(status: RemoteMcpTaskStatus): TaskStatus {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'killed'
    case 'working':
    case 'input_required':
      return 'running'
  }
}

function clearMonitorTimer(runtime: MonitorRuntime): void {
  if (runtime.timer) {
    clearTimeout(runtime.timer)
    runtime.timer = undefined
  }
}

function releaseRuntime(runtime: MonitorRuntime): void {
  clearMonitorTimer(runtime)
  runtime.terminal = true
  monitors.delete(runtime.localTaskId)
  const key = remoteKey(runtime.server.name, runtime.remoteTaskId)
  if (remoteTaskOwners.get(key) === runtime.localTaskId) {
    remoteTaskOwners.delete(key)
  }
  for (const confirm of runtime.cancelWaiters) confirm()
  runtime.cancelWaiters.clear()
}

function taskStatusMessage(status: TaskStatus): string {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'was cancelled remotely'
    case 'pending':
    case 'running':
      return 'is running'
  }
}

function enqueueTerminalNotification(
  runtime: MonitorRuntime,
  status: TaskStatus,
): void {
  if (!isTerminalTaskStatus(status)) return
  let shouldNotify = false
  updateTaskState<MonitorMcpTaskState>(
    runtime.localTaskId,
    runtime.setAppState,
    task => {
      if (task.notified) return task
      shouldNotify = true
      return { ...task, notified: true }
    },
  )
  if (!shouldNotify) return

  const toolUseIdLine = runtime.toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${runtime.toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  enqueuePendingNotification({
    value: `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${runtime.localTaskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${TASK_TYPE_TAG}>monitor_mcp</${TASK_TYPE_TAG}>
<${OUTPUT_FILE_TAG}>${runtime.getAppState().tasks[runtime.localTaskId]?.outputFile ?? ''}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(`MCP task "${runtime.description}" ${taskStatusMessage(status)}`)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`,
    mode: 'task-notification',
    priority: 'later',
    agentId: runtime.agentId,
  })
}

function setTaskError(
  taskId: string,
  setAppState: SetAppState,
  message: string,
): void {
  updateTaskState<MonitorMcpTaskState>(taskId, setAppState, task =>
    task.error === message ? task : { ...task, error: message },
  )
}

function setMonitorError(runtime: MonitorRuntime, message: string): void {
  setTaskError(runtime.localTaskId, runtime.setAppState, message)
}

function requestOptions(runtime: MonitorRuntime): {
  timeout: number
  signal: AbortSignal
} {
  return {
    timeout: runtime.requestTimeoutMs,
    signal: AbortSignal.timeout(runtime.requestTimeoutMs),
  }
}

async function getRemoteTask(
  runtime: MonitorRuntime,
): Promise<RemoteMcpTask> {
  const result = await runtime.server.client.request(
    { method: 'tasks/get', params: { taskId: runtime.remoteTaskId } },
    GetTaskResultSchema,
    requestOptions(runtime),
  )
  return result
}

function serializeModelOutput(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2)
  return content
    .map(block => {
      if (
        block &&
        typeof block === 'object' &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
      ) {
        return block.text
      }
      return JSON.stringify(block)
    })
    .join('\n')
}

async function deliverFinalResult(runtime: MonitorRuntime): Promise<void> {
  if (runtime.resultRequested) return
  runtime.resultRequested = true
  try {
    const result = await runtime.server.client.request(
      { method: 'tasks/result', params: { taskId: runtime.remoteTaskId } },
      CallToolResultSchema,
      requestOptions(runtime),
    )
    const { processMCPResult } = await import('../../services/mcp/client.js')
    const content = await processMCPResult(
      result,
      runtime.toolName,
      runtime.server.name,
    )
    appendTaskOutput(runtime.localTaskId, serializeModelOutput(content))
    await flushTaskOutput(runtime.localTaskId)
  } catch (error) {
    setMonitorError(
      runtime,
      `Remote task reached a terminal state, but its result could not be retrieved: ${errorText(error)}`,
    )
  } finally {
    await evictTaskOutput(runtime.localTaskId)
  }
}

function applyRemoteTaskUnchecked(
  runtime: MonitorRuntime,
  value: unknown,
): Promise<void> {
  const parsed = GetTaskResultSchema.safeParse(value)
  if (!parsed.success) {
    setMonitorError(runtime, `Invalid MCP task status: ${parsed.error.message}`)
    return Promise.resolve()
  }
  const remote = parsed.data
  if (remote.taskId !== runtime.remoteTaskId) {
    setMonitorError(runtime, 'MCP server returned a status for a different task')
    return Promise.resolve()
  }

  const timestamp = Date.parse(remote.lastUpdatedAt)
  if (!Number.isFinite(timestamp)) {
    setMonitorError(runtime, 'MCP server returned an invalid lastUpdatedAt value')
    return Promise.resolve()
  }
  const current = runtime.getAppState().tasks[runtime.localTaskId]
  if (
    runtime.terminal ||
    !current ||
    current.type !== 'monitor_mcp' ||
    isTerminalTaskStatus(current.status) ||
    timestamp < runtime.lastRemoteTimestamp
  ) {
    return Promise.resolve()
  }
  runtime.lastRemoteTimestamp = timestamp
  runtime.pollFailures = 0
  clearMonitorTimer(runtime)

  const localStatus = remoteToLocalStatus(remote.status)
  updateTaskState<MonitorMcpTaskState>(
    runtime.localTaskId,
    runtime.setAppState,
    task => ({
      ...task,
      status: localStatus,
      remoteStatus: remote.status,
      pollIntervalMs: remote.pollInterval,
      lastRemoteUpdateAt: timestamp,
      error: remote.statusMessage,
      ...(isTerminalTaskStatus(localStatus) ? { endTime: Date.now() } : {}),
    }),
  )

  if (!isTerminalTaskStatus(localStatus)) {
    schedulePoll(runtime, remote.pollInterval)
    return Promise.resolve()
  }

  releaseRuntime(runtime)
  const finish = async () => {
    if (remote.status === 'completed' || remote.status === 'failed') {
      await deliverFinalResult(runtime)
    }
    enqueueTerminalNotification(runtime, localStatus)
  }
  return finish()
}

function applyRemoteTask(
  runtime: MonitorRuntime,
  remote: unknown,
): Promise<void> {
  const operation = runtime.updateChain.then(() =>
    applyRemoteTaskUnchecked(runtime, remote),
  )
  runtime.updateChain = operation.catch(error => {
    setMonitorError(runtime, `Failed to synchronize MCP task: ${errorText(error)}`)
  })
  return operation
}

function schedulePoll(runtime: MonitorRuntime, serverInterval?: number): void {
  if (runtime.terminal) return
  clearMonitorTimer(runtime)
  const hasServerInterval =
    serverInterval !== undefined &&
    Number.isFinite(serverInterval) &&
    serverInterval > 0
  const base = hasServerInterval
    ? serverInterval
    : Math.min(
        DEFAULT_POLL_INTERVAL_MS * 2 ** runtime.pollFailures,
        MAX_POLL_INTERVAL_MS,
      )
  const delay = hasServerInterval
    ? base
    : Math.floor(base * (0.8 + Math.random() * 0.4))
  runtime.timer = setTimeout(() => {
    runtime.timer = undefined
    void pollMonitorMcp(runtime.localTaskId)
  }, delay)
  runtime.timer.unref?.()
}

export async function pollMonitorMcp(taskId: string): Promise<boolean> {
  const runtime = monitors.get(taskId)
  if (!runtime || runtime.terminal) return false
  try {
    const remote = await getRemoteTask(runtime)
    await applyRemoteTask(runtime, remote)
    if (!runtime.terminal) schedulePoll(runtime, remote.pollInterval)
    return true
  } catch (error) {
    runtime.pollFailures++
    setMonitorError(
      runtime,
      `MCP task status is unknown; polling failed: ${errorText(error)}`,
    )
    schedulePoll(runtime)
    return false
  }
}

function instrumentClient(runtime: MonitorRuntime): void {
  const client = runtime.server.client
  if (instrumentedClients.has(client)) return
  instrumentedClients.add(client)

  client.setNotificationHandler(TaskStatusNotificationSchema, notification => {
    const owner = remoteTaskOwners.get(
      remoteKey(serverName, notification.params.taskId),
    )
    const target = owner ? monitors.get(owner) : undefined
    if (target && target.server.client === client) {
      void applyRemoteTask(target, notification.params)
    }
  })

  const originalOnClose = client.onclose
  const serverName = runtime.server.name
  client.onclose = () => {
    for (const target of monitors.values()) {
      if (target.server.client !== client || target.terminal) continue
      clearMonitorTimer(target)
      setMonitorError(
        target,
        'MCP connection closed; remote task status is unknown while reconnecting',
      )
    }
    originalOnClose?.()
  }
}

export function createMonitorMcpTask(
  options: CreateMonitorMcpTaskOptions,
): { taskId: string; remoteTaskId: string } | undefined {
  const {
    server,
    toolName,
    getAppState,
    setAppState,
    toolUseId,
    agentId,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = options
  if (!server.capabilities.tasks?.requests?.tools?.call) return undefined
  const parsed = CreateTaskResultSchema.safeParse(options.createResult)
  if (!parsed.success || !parsed.data.task.taskId) return undefined

  const remote = parsed.data.task
  const existingId = remoteTaskOwners.get(remoteKey(server.name, remote.taskId))
  if (existingId && monitors.has(existingId)) {
    return { taskId: existingId, remoteTaskId: remote.taskId }
  }

  const taskId = generateTaskId('monitor_mcp')
  const description = options.description ?? `MCP ${server.name}/${toolName}`
  const timestamp = Date.parse(remote.lastUpdatedAt)
  const localStatus = remoteToLocalStatus(remote.status)
  const initial: MonitorMcpTaskState = {
    ...createTaskStateBase(taskId, 'monitor_mcp', description, toolUseId),
    type: 'monitor_mcp',
    // A terminal CreateTaskResult is registered as running first so the common
    // transition path can persist its result and emit exactly one notification.
    status: isTerminalTaskStatus(localStatus) ? 'running' : localStatus,
    agentId,
    serverName: server.name,
    toolName,
    remoteTaskId: remote.taskId,
    remoteStatus: remote.status,
    cancelRequested: false,
    pollIntervalMs: remote.pollInterval,
    lastRemoteUpdateAt: Number.isFinite(timestamp) ? timestamp : undefined,
    error: remote.statusMessage,
  }
  const runtime: MonitorRuntime = {
    localTaskId: taskId,
    server,
    remoteTaskId: remote.taskId,
    toolName,
    getAppState,
    setAppState,
    toolUseId,
    agentId,
    description,
    updateChain: Promise.resolve(),
    lastRemoteTimestamp: Number.isFinite(timestamp) ? timestamp : 0,
    pollFailures: 0,
    terminal: false,
    resultRequested: false,
    cancelWaiters: new Set(),
    requestTimeoutMs,
  }
  monitors.set(taskId, runtime)
  remoteTaskOwners.set(remoteKey(server.name, remote.taskId), taskId)
  instrumentClient(runtime)
  registerTask(initial, setAppState)
  if (isTerminalTaskStatus(localStatus)) {
    void applyRemoteTask(runtime, remote)
  } else {
    schedulePoll(runtime, remote.pollInterval)
  }
  return { taskId, remoteTaskId: remote.taskId }
}

function isUnknownTaskError(error: unknown): boolean {
  return (
    error instanceof McpError &&
    error.code === ErrorCode.InvalidParams &&
    /unknown task|task(?:\s+[^ ]+)*\s+(?:was\s+)?not found/i.test(error.message)
  )
}

export function killMonitorMcp(
  taskId: string,
  getAppState: () => AppState,
  setAppState: SetAppState,
): Promise<boolean> {
  const task = getAppState().tasks[taskId]
  if (!task || task.type !== 'monitor_mcp') return Promise.resolve(false)
  if (isTerminalTaskStatus(task.status)) return Promise.resolve(true)
  const existing = cancellationRequests.get(taskId)
  if (existing) return existing

  const runtime = monitors.get(taskId)
  updateTaskState<MonitorMcpTaskState>(taskId, setAppState, current => ({
    ...current,
    status: 'running',
    cancelRequested: true,
    error: undefined,
  }))
  if (
    !runtime ||
    runtime.remoteTaskId !== task.remoteTaskId ||
    runtime.server.name !== task.serverName
  ) {
    setTaskError(
      taskId,
      setAppState,
      'The original MCP connection is unavailable; cancellation was not sent',
    )
    return Promise.resolve(false)
  }

  const operation = (async () => {
    let confirmed = false
    const confirmation = new Promise<void>(resolve => {
      runtime.cancelWaiters.add(() => {
        confirmed = true
        resolve()
      })
    })
    try {
      const capabilities =
        runtime.server.client.getServerCapabilities() ??
        runtime.server.capabilities
      if (!capabilities.tasks?.cancel) {
        setMonitorError(
          runtime,
          'MCP server does not advertise tasks.cancel; remote task is still running',
        )
        return false
      }

      const cancelRequest = runtime.server.client.request(
        { method: 'tasks/cancel', params: { taskId: runtime.remoteTaskId } },
        CancelTaskResultSchema,
        requestOptions(runtime),
      )
      const outcome = await Promise.race([
        cancelRequest.then(async remote => {
          await applyRemoteTask(runtime, remote)
          return remote.status === 'cancelled'
        }),
        confirmation.then(() => true),
      ])
      if (outcome && (confirmed || runtime.terminal)) {
        const current = getAppState().tasks[taskId]
        if (
          current?.type === 'monitor_mcp' &&
          current.remoteStatus === 'cancelled' &&
          current.status === 'killed'
        ) {
          return true
        }
      }
      if (!runtime.terminal) {
        setMonitorError(
          runtime,
          'Cancellation was requested, but the server has not confirmed that the remote task is cancelled',
        )
        schedulePoll(runtime)
      }
      return false
    } catch (error) {
      if (isUnknownTaskError(error)) {
        updateTaskState<MonitorMcpTaskState>(taskId, setAppState, current => ({
          ...current,
          status: 'failed',
          remoteStatus: 'failed',
          error: `MCP server reported that the remote task is unknown: ${errorText(error)}`,
          endTime: Date.now(),
        }))
        releaseRuntime(runtime)
        enqueueTerminalNotification(runtime, 'failed')
        return false
      }
      if (!runtime.terminal) {
        setMonitorError(
          runtime,
          `Cancellation was not confirmed; remote task may still be running: ${errorText(error)}`,
        )
        schedulePoll(runtime)
        return false
      }
      const current = getAppState().tasks[taskId]
      return (
        current?.type === 'monitor_mcp' &&
        current.remoteStatus === 'cancelled' &&
        current.status === 'killed'
      )
    } finally {
      runtime.cancelWaiters.clear()
    }
  })()
  cancellationRequests.set(taskId, operation)
  void operation.finally(() => {
    if (cancellationRequests.get(taskId) === operation) {
      cancellationRequests.delete(taskId)
    }
  })
  return operation
}

export async function killMonitorMcpTasksForAgent(
  agentId: AgentId,
  getAppState: () => AppState,
  setAppState: SetAppState,
): Promise<number> {
  const taskIds = Object.values(getAppState().tasks)
    .filter(
      (task): task is MonitorMcpTaskState =>
        task.type === 'monitor_mcp' &&
        task.agentId === agentId &&
        !isTerminalTaskStatus(task.status),
    )
    .map(task => task.id)
  let confirmed = 0
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < taskIds.length) {
      const taskId = taskIds[nextIndex++]!
      try {
        if (await killMonitorMcp(taskId, getAppState, setAppState)) confirmed++
      } catch (error) {
        logForDebugging(
          `MCP monitor cleanup failed for agent ${agentId}: ${errorText(error)}`,
        )
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(AGENT_CLEANUP_CONCURRENCY, taskIds.length) },
      worker,
    ),
  )
  const failed = taskIds.length - confirmed
  if (failed > 0) {
    logForDebugging(
      `MCP monitor cleanup for agent ${agentId}: ${confirmed} confirmed terminal, ${failed} unconfirmed`,
    )
  }
  return confirmed
}

export async function reconnectMonitorMcpTasksForServer(
  server: ConnectedMCPServer,
): Promise<void> {
  const targets = [...monitors.values()].filter(
    runtime => runtime.server.name === server.name && !runtime.terminal,
  )
  for (const runtime of targets) {
    runtime.server = server
    instrumentClient(runtime)
  }
  if (targets.length === 0) return
  if (!server.capabilities.tasks?.requests?.tools?.call) {
    for (const runtime of targets) {
      setMonitorError(runtime, 'Reconnected MCP server no longer supports Tasks')
    }
    return
  }

  const found = new Set<string>()
  if (server.capabilities.tasks.list) {
    try {
      let cursor: string | undefined
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await server.client.request(
          {
            method: 'tasks/list',
            params: cursor ? { cursor } : undefined,
          },
          ListTasksResultSchema,
          { timeout: DEFAULT_REQUEST_TIMEOUT_MS },
        )
        for (const remote of result.tasks) {
          const owner = remoteTaskOwners.get(
            remoteKey(server.name, remote.taskId),
          )
          const runtime = owner ? monitors.get(owner) : undefined
          if (!runtime || !targets.includes(runtime)) continue
          found.add(runtime.localTaskId)
          await applyRemoteTask(runtime, remote)
        }
        if (!result.nextCursor) break
        cursor = result.nextCursor
      }
    } catch (error) {
      for (const runtime of targets) {
        if (!runtime.terminal) {
          setMonitorError(
            runtime,
            `Failed to reconcile MCP tasks after reconnect: ${errorText(error)}`,
          )
        }
      }
      return
    }
  }

  for (const runtime of targets) {
    if (runtime.terminal || found.has(runtime.localTaskId)) continue
    try {
      const remote = await getRemoteTask(runtime)
      await applyRemoteTask(runtime, remote)
    } catch (error) {
      setMonitorError(
        runtime,
        `Remote task was not confirmed after reconnect: ${errorText(error)}`,
      )
    }
    if (!runtime.terminal) schedulePoll(runtime)
  }
}

export const MonitorMcpTask: Task = {
  name: 'MonitorMcpTask',
  type: 'monitor_mcp',
  async kill(taskId, setAppState, getAppState) {
    const runtime = monitors.get(taskId)
    const getState = getAppState ?? runtime?.getAppState
    if (!getState) {
      throw new Error('MCP monitor state is unavailable; cancellation was not sent')
    }
    const confirmed = await killMonitorMcp(taskId, getState, setAppState)
    if (!confirmed) {
      throw new Error(
        'Remote MCP task cancellation was not confirmed; the task may still be running',
      )
    }
  },
}
