import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ask } from '../QueryEngine.js'
import { getCommands } from '../commands.js'
import {
  setClientType,
  setCwdState,
  setIsInteractive,
  setOriginalCwd,
  setSessionSource,
  switchSession,
} from '../bootstrap/state.js'
import { enableConfigs } from './config.js'
import type {
  InternalOptions,
  InternalQuery,
  McpServerConfig,
  McpSdkServerConfigWithInstance,
} from '../entrypoints/sdk/runtimeTypes.js'
import type {
  McpServerStatus,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
} from '../entrypoints/sdk/coreTypes.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import { getMcpToolsCommandsAndResources, fetchToolsForClient } from '../services/mcp/client.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
  ServerResource,
} from '../services/mcp/types.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import type { AppState } from '../state/AppStateStore.js'
import { assembleToolPool } from '../tools.js'
import { parseAgentsFromJson } from '../tools/AgentTool/loadAgentsDir.js'
import { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
import { asSessionId } from '../types/ids.js'
import type { Message } from '../types/message.js'
import { runCleanupFunctions } from './cleanupRegistry.js'
import { flushSessionStorage } from './sessionStorage.js'
import { getModelOptions } from './model/modelOptions.js'
import { initializeToolPermissionContext } from './permissions/permissionSetup.js'
import { hasPermissionsToUseTool } from './permissions/permissions.js'
import { getOauthAccountInfo } from './auth.js'
import type { ThinkingConfig } from './thinking.js'

function debug(stage: string): void {
  if (process.env.SDK_DEBUG) console.error(`[sdk-query] ${stage}`)
}

export class UserMessageChannel {
  private queue: SDKUserMessage[] = []
  private closed = false
  private error: unknown
  private waiters: Array<{
    resolve: () => void
    reject: (error: unknown) => void
  }> = []

  push(message: SDKUserMessage): void {
    if (this.closed) throw new Error('Cannot stream input after the query closes')
    this.queue.push(message)
    this.notify()
  }

  close(): void {
    this.closed = true
    this.notify()
  }

  fail(error: unknown): void {
    this.error = error
    this.closed = true
    this.notify()
  }

  private notify(): void {
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) {
      if (this.error !== undefined) waiter.reject(this.error)
      else waiter.resolve()
    }
  }

  async *iterate(): AsyncGenerator<SDKUserMessage, void> {
    while (true) {
      const message = this.queue.shift()
      if (message) {
        yield message
        continue
      }
      if (this.closed) {
        if (this.error !== undefined) throw this.error
        return
      }
      await new Promise<void>((resolve, reject) => {
        this.waiters.push({ resolve, reject })
      })
    }
  }
}

function toScopedConfigs(
  configs: Record<string, McpServerConfig> | undefined,
): Record<string, ScopedMcpServerConfig> {
  return Object.fromEntries(
    Object.entries(configs ?? {}).map(([name, config]) => [
      name,
      { ...config, scope: 'dynamic' as const } as ScopedMcpServerConfig,
    ]),
  )
}

function hasMcpInstance(
  config: ScopedMcpServerConfig,
): config is ScopedMcpServerConfig & McpSdkServerConfigWithInstance {
  return config.type === 'sdk' && 'instance' in config
}

async function connectMcpConfigs({
  configs,
  onConnection,
}: {
  configs: Record<string, ScopedMcpServerConfig>
  onConnection: Parameters<typeof getMcpToolsCommandsAndResources>[0]
}): Promise<void> {
  const processConfigs = Object.fromEntries(
    Object.entries(configs).filter(([, config]) => !hasMcpInstance(config)),
  )
  const inProcessConfigs = Object.entries(configs).filter(([, config]) =>
    hasMcpInstance(config),
  )
  debug(`mcp:args:configs=${Object.keys(configs).join(',')};callback=${typeof onConnection}`)
  debug(`mcp:kinds:${Object.entries(configs).map(([name, config]) => `${name}:${config.type}:${hasMcpInstance(config)}`).join(',')}`)

  await Promise.all([
    getMcpToolsCommandsAndResources(onConnection, processConfigs),
    ...inProcessConfigs.map(async ([name, config]) => {
      if (!hasMcpInstance(config)) return
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair()
      const client = new Client({ name: 'claude-code-sdk', version: '1.0.0' })
      const connection: MCPServerConnection = {
        type: 'connected',
        name,
        capabilities: {},
        client,
        config,
        cleanup: async () => {
          await Promise.all([client.close(), config.instance.close()])
        },
      }
      try {
        await Promise.all([
          client.connect(clientTransport),
          config.instance.connect(serverTransport),
        ])
        connection.capabilities = client.getServerCapabilities() ?? {}
        const tools = await fetchToolsForClient(connection)
        onConnection({ client: connection, tools, commands: [] })
      } catch (error) {
        await connection.cleanup().catch(() => {})
        onConnection({
          client: {
            type: 'failed',
            name,
            config,
            error: error instanceof Error ? error.message : String(error),
          },
          tools: [],
          commands: [],
        })
      }
    }),
  ])
}

async function cleanupClients(clients: MCPServerConnection[]): Promise<void> {
  await Promise.all(
    clients.map(async client => {
      if (client.type === 'connected') {
        await client.cleanup().catch(() => {})
      }
    }),
  )
}

function resolveThinkingConfig(
  options: InternalOptions,
): ThinkingConfig | undefined {
  const configured = options.thinkingConfig
  if (configured) {
    if (configured.type === 'enabled') {
      if (typeof configured.budgetTokens !== 'number') {
        throw new Error('thinkingConfig.enabled requires budgetTokens')
      }
      return {
        type: 'enabled',
        budgetTokens: configured.budgetTokens,
      }
    }
    return configured
  }
  if (options.maxThinkingTokens === null) return { type: 'disabled' }
  if (options.maxThinkingTokens !== undefined) {
    return { type: 'enabled', budgetTokens: options.maxThinkingTokens }
  }
  return undefined
}

function toResourceMap(
  resources: ServerResource[] | Record<string, ServerResource[]> | undefined,
  fallback: Record<string, ServerResource[]>,
): Record<string, ServerResource[]> {
  if (!resources) return fallback
  if (!Array.isArray(resources)) return resources
  return Object.fromEntries(resources.map(resource => [resource.uri, [resource]]))
}

function assembleSdkToolPool(
  appState: AppState,
  toolOption: InternalOptions['tools'],
): ReturnType<typeof assembleToolPool> {
  const pool = assembleToolPool(
    appState.toolPermissionContext,
    appState.mcp.tools,
  )
  if (Array.isArray(toolOption) && toolOption.length === 0) {
    return pool.filter(tool => tool.isMcp)
  }
  return pool
}

function toMcpStatus(clients: MCPServerConnection[]): McpServerStatus[] {
  return clients.map(client => ({
    name: client.name,
    status:
      client.type === 'connected'
        ? 'connected'
        : client.type === 'failed'
          ? 'failed'
          : client.type === 'needs-auth'
            ? 'needs-auth'
            : 'pending',
    ...(client.type === 'connected' && client.serverInfo
      ? { serverInfo: client.serverInfo }
      : {}),
  }))
}

export function createSdkQuery({
  prompt,
  options = {},
  initialMessages,
  session,
}: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: InternalOptions
  initialMessages?: Message[] | Promise<Message[]>
  session?: { id: string; projectDir?: string | Promise<string | undefined> }
}): InternalQuery {
  const abortController = options.abortController ?? new AbortController()
  const channel = new UserMessageChannel()
  let setupPromise: Promise<{
    appState: AppState
    commands: Awaited<ReturnType<typeof getCommands>>
    tools: ReturnType<typeof assembleToolPool>
    thinkingConfig: ThinkingConfig | undefined
    userSpecifiedModel: string | undefined
    readFileCache: ReturnType<typeof createFileStateCacheWithSizeLimit>
    mutableMessages: Parameters<typeof ask>[0]['mutableMessages']
  }> | undefined

  if (typeof prompt === 'string') {
    channel.push({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: '',
      uuid: randomUUID(),
    })
    channel.close()
  } else {
    void (async () => {
      try {
        for await (const message of prompt) channel.push(message)
        channel.close()
      } catch (error) {
        channel.fail(error)
      }
    })()
  }

  const initialize = () => {
    setupPromise ??= (async () => {
      const cwd = options.cwd ?? process.cwd()
      setOriginalCwd(cwd)
      setCwdState(cwd)
      setIsInteractive(false)
      setClientType('sdk')
      setSessionSource('sdk')
      if (session) {
        switchSession(asSessionId(session.id), (await session.projectDir) ?? null)
      }

      if (options.env) {
        for (const [key, value] of Object.entries(options.env)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
      debug('init:start')
      enableConfigs()
      debug('init:done')

      const appState = getDefaultAppState()
      Object.assign(appState, {
        mainLoopModel: options.model ?? null,
        verbose: options.verbose ?? false,
        agent: options.agent,
        agentDefinitions: {
          activeAgents: [],
          allAgents: [],
        },
      })
      const { toolPermissionContext } = await initializeToolPermissionContext({
        allowedToolsCli: options.allowedTools ?? [],
        disallowedToolsCli: options.disallowedTools ?? [],
        baseToolsCli: Array.isArray(options.tools) ? options.tools : undefined,
        permissionMode: options.permissionMode ?? 'default',
        allowDangerouslySkipPermissions:
          options.allowDangerouslySkipPermissions ?? false,
        addDirs: options.additionalDirectories ?? [],
      })
      Object.assign(appState, { toolPermissionContext })
      debug('permissions:done')

      const scopedConfigs = toScopedConfigs(options.mcpServers)
      debug(`mcp:config:${Object.keys(options.mcpServers ?? {}).join(',')};scoped:${Object.keys(scopedConfigs).join(',')}`)
      await connectMcpConfigs({
        configs: scopedConfigs,
        onConnection: ({ client, tools, commands, resources }) => {
          appState.mcp = {
            ...appState.mcp,
            clients: [...appState.mcp.clients, client],
            tools: [...appState.mcp.tools, ...tools],
            commands: [...appState.mcp.commands, ...commands],
            resources: toResourceMap(resources, appState.mcp.resources),
          }
        },
      })
      debug(`mcp:done:${appState.mcp.clients.map(client => `${client.name}:${client.type}${client.type === 'failed' ? `:${client.error}` : ''}`).join(',')}`)
      const commands = [
        ...(await getCommands(cwd)),
        ...appState.mcp.commands,
      ]
      debug('commands:done')
      const tools = assembleSdkToolPool(appState, options.tools)
      debug(`tools:${tools.map(tool => tool.name).join(',')}`)
      const thinkingConfig = resolveThinkingConfig(options)

      return {
        appState,
        commands,
        tools,
        thinkingConfig,
        userSpecifiedModel: options.model,
        readFileCache: createFileStateCacheWithSizeLimit(100),
        mutableMessages: (await initialMessages) ?? [],
      }
    })()
    return setupPromise
  }

  const run = async function* (): AsyncGenerator<SDKMessage, void> {
    const setup = await initialize()
    const {
      appState,
      readFileCache,
      mutableMessages,
    } = setup
    const canUseTool: CanUseToolFn = async (
      tool,
      input,
      context,
      assistantMessage,
      toolUseID,
      forceDecision,
    ) => {
      if (options.canUseTool) {
        const result = await options.canUseTool(tool.name, input, {
          signal: context.abortController.signal,
          ...(forceDecision?.behavior === 'ask' && {
            suggestions: forceDecision.suggestions,
            blockedPath: forceDecision.blockedPath,
          }),
          toolUseID,
          ...(context.agentId ? { agentID: context.agentId } : {}),
        })
        if (result.behavior === 'allow') {
          return {
            behavior: 'allow',
            ...(result.updatedInput
              ? { updatedInput: result.updatedInput }
              : {}),
            ...(result.toolUseID ? { toolUseID: result.toolUseID } : {}),
          }
        }
        return {
          behavior: 'deny',
          message: result.message,
          decisionReason: {
            type: 'hook',
            hookName: 'SDK canUseTool',
            reason: result.message,
          },
          ...(result.interrupt !== undefined
            ? { interrupt: result.interrupt }
            : {}),
          ...(result.toolUseID ? { toolUseID: result.toolUseID } : {}),
        }
      }
      return hasPermissionsToUseTool(
        tool,
        input,
        context,
        assistantMessage,
        toolUseID,
        forceDecision,
      )
    }

    try {
      for await (const message of channel.iterate()) {
        const content = message.message.content
        const promptContent: string | ContentBlockParam[] =
          typeof content === 'string' ? content : content
        debug('ask:start')
        for await (const output of ask({
          commands: setup.commands,
          prompt: promptContent,
          promptUuid: message.uuid,
          isMeta: message.isSynthetic,
          cwd: options.cwd ?? process.cwd(),
          tools: setup.tools,
          mcpClients: setup.appState.mcp.clients,
          verbose: options.verbose,
          thinkingConfig: setup.thinkingConfig,
          maxTurns: options.maxTurns,
          maxBudgetUsd: options.maxBudgetUsd,
          taskBudget: options.taskBudget,
          canUseTool,
          mutableMessages,
          getReadFileCache: () => setup.readFileCache,
          setReadFileCache: cache => {
            setup.readFileCache = cache
          },
          customSystemPrompt:
            options.systemPrompt === undefined
              ? ''
              : typeof options.systemPrompt === 'string'
                ? options.systemPrompt
                : undefined,
          appendSystemPrompt:
            typeof options.systemPrompt === 'object' &&
            options.systemPrompt.type === 'preset'
              ? options.systemPrompt.append
              : undefined,
          userSpecifiedModel: setup.userSpecifiedModel,
          fallbackModel: options.fallbackModel,
          jsonSchema: options.outputFormat?.schema,
          getAppState: () => setup.appState,
          setAppState: f => {
            Object.assign(setup.appState, f(setup.appState))
          },
          abortController,
          replayUserMessages: options.replayUserMessages,
          includePartialMessages: options.includePartialMessages,
          agents: parseAgentsFromJson(options.agents ?? {}),
        })) {
          debug(`message:${output.type}`)
          yield output
        }
        debug('ask:done')
      }
    } catch (error) {
      debug(`error:${error instanceof Error ? error.stack : String(error)}`)
      throw error
    } finally {
      await Promise.all([
        cleanupClients(setup.appState.mcp.clients),
        runCleanupFunctions(),
        flushSessionStorage(),
      ])
    }
  }

  const query = run() as InternalQuery
  const unsupported = (name: string) => async (): Promise<never> => {
    throw new Error(`${name} is not supported by this SDK query`)
  }

  return Object.assign(query, {
    interrupt: async () => {
      abortController.abort()
    },
    setPermissionMode: async (mode: PermissionMode) => {
      const { appState } = await initialize()
      Object.assign(appState, {
        toolPermissionContext: {
          ...appState.toolPermissionContext,
          mode,
        },
      })
    },
    setModel: async (model?: string) => {
      const setup = await initialize()
      setup.userSpecifiedModel = model
      Object.assign(setup.appState, { mainLoopModel: model ?? null })
    },
    setMaxThinkingTokens: async (maxThinkingTokens: number | null) => {
      const setup = await initialize()
      setup.thinkingConfig =
        maxThinkingTokens === null
          ? { type: 'disabled' }
          : { type: 'enabled', budgetTokens: maxThinkingTokens }
    },
    supportedCommands: async () => {
      const { commands } = await initialize()
      return commands.map(command => ({
        name: command.name,
        description: command.description,
        argumentHint: command.argumentHint,
      }))
    },
    supportedModels: async () => {
      await initialize()
      return getModelOptions().map(model => ({
        value: model.value,
        label: model.label,
        description: model.description,
      }))
    },
    mcpServerStatus: async () => {
      const { appState } = await initialize()
      return toMcpStatus(appState.mcp.clients)
    },
    accountInfo: async () => {
      await initialize()
      const account = getOauthAccountInfo()
      if (!account) throw new Error('No authenticated account is available')
      return account
    },
    rewindFiles: async () => ({
      canRewind: false,
      error: 'File checkpointing is not enabled for this SDK query',
    }),
    setMcpServers: async (servers: Record<string, McpServerConfig>) => {
      const setup = await initialize()
      const previousNames = new Set(
        setup.appState.mcp.clients.map(client => client.name),
      )
      await cleanupClients(setup.appState.mcp.clients)
      setup.appState.mcp = {
        ...setup.appState.mcp,
        clients: [],
        tools: [],
        commands: [],
        resources: {},
      }
      await connectMcpConfigs({
        configs: toScopedConfigs(servers),
        onConnection: ({ client, tools, commands, resources }) => {
          setup.appState.mcp = {
            ...setup.appState.mcp,
            clients: [...setup.appState.mcp.clients, client],
            tools: [...setup.appState.mcp.tools, ...tools],
            commands: [...setup.appState.mcp.commands, ...commands],
            resources: toResourceMap(resources, setup.appState.mcp.resources),
          }
        },
      })
      setup.tools = assembleSdkToolPool(setup.appState, options.tools)
      const added: string[] = []
      const errors: Record<string, string> = {}
      for (const client of setup.appState.mcp.clients) {
        if (!previousNames.has(client.name)) added.push(client.name)
        if (client.type === 'failed') {
          errors[client.name] = client.error ?? 'Unknown MCP connection error'
        }
      }
      return {
        added,
        removed: [...previousNames].filter(name => !(name in servers)),
        errors,
      }
    },
    streamInput: async (stream: AsyncIterable<SDKUserMessage>) => {
      for await (const message of stream) channel.push(message)
    },
    close: async (reason?: string) => {
      void reason
      abortController.abort(reason)
    },
    getContextUsage: unsupported('getContextUsage'),
    reloadPlugins: unsupported('reloadPlugins'),
    stopTask: unsupported('stopTask'),
    applyFlagSettings: unsupported('applyFlagSettings'),
    getSettings: unsupported('getSettings'),
    enableRemoteControl: unsupported('enableRemoteControl'),
  })
}
