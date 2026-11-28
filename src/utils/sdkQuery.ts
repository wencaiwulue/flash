import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID, type UUID } from 'crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ask } from '../QueryEngine.js'
import { getCommands } from '../commands.js'
import {
  setClientType,
  registerHookCallbacks,
  setCwdState,
  setIsInteractive,
  setOriginalCwd,
  setSessionSource,
  switchSession,
  isSessionPersistenceDisabled,
  setSessionPersistenceDisabled,
} from '../bootstrap/state.js'
import { enableConfigs } from './config.js'
import type {
  InternalOptions,
  InternalQuery,
  McpServerConfig,
  McpSdkServerConfigWithInstance,
} from '../entrypoints/sdk/runtimeTypes.js'
import type {
  HookEvent,
  McpServerStatus,
  PermissionMode,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '../entrypoints/sdk/coreTypes.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type {
  HookCallback as InternalHookCallback,
  HookCallbackMatcher as InternalHookCallbackMatcher,
} from '../types/hooks.js'
import { getMcpToolsCommandsAndResources, fetchToolsForClient } from '../services/mcp/client.js'
import { registerElicitationHandler } from '../services/mcp/elicitationHandler.js'
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
import { FileCheckpointing } from './fileCheckpointing.js'
import { getModelOptions } from './model/modelOptions.js'
import { getMainLoopModel } from './model/model.js'
import {
  applySdkFlagSettings,
  getSdkContextUsage,
  getSdkSettings,
  reloadSdkPlugins,
  stopSdkTask,
} from './sdkControl.js'
import { initializeToolPermissionContext } from './permissions/permissionSetup.js'
import { hasPermissionsToUseTool } from './permissions/permissions.js'
import { getOauthAccountInfo, getClaudeAIOAuthTokens } from './auth.js'
import { getOrganizationUUID } from '../services/oauth/client.js'
import { getOauthConfig } from '../constants/oauth.js'
import { connectDaemonBridge } from '../assistant/daemonBridge.js'
import {
  startSdkRemoteControl,
  type SdkRemoteController,
} from './sdkRemoteControl.js'
import type { ThinkingConfig } from './thinking.js'

function debug(stage: string): void {
  if (process.env.SDK_DEBUG) console.error(`[sdk-query] ${stage}`)
}

// Session persistence is process-global in QueryEngine. Serialize only its
// configuration (not queries themselves), and reject combinations that cannot
// be represented safely. File checkpointing itself is per-query state.
let activePersistenceLease:
  | {
      persistSession: boolean
      previousDisabled: boolean
      users: number
    }
  | undefined

function acquireSessionPersistence(persistSession: boolean): () => void {
  if (
    activePersistenceLease &&
    activePersistenceLease.persistSession !== persistSession
  ) {
    throw new Error(
      'Concurrent SDK queries with different persistSession options are not supported because session persistence is process-global',
    )
  }

  if (!activePersistenceLease) {
    const previousDisabled = isSessionPersistenceDisabled()
    activePersistenceLease = {
      persistSession,
      previousDisabled,
      users: 0,
    }
    // Checkpoint backups are independent of this flag. In particular, never
    // enable transcript persistence just to make file snapshots available.
    setSessionPersistenceDisabled(previousDisabled || !persistSession)
  }
  activePersistenceLease.users++

  let released = false
  return () => {
    if (released) return
    released = true
    const lease = activePersistenceLease
    if (!lease || lease.persistSession !== persistSession) return
    lease.users--
    if (lease.users === 0) {
      setSessionPersistenceDisabled(lease.previousDisabled)
      activePersistenceLease = undefined
    }
  }
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

  isClosedAndDrained(): boolean {
    return this.closed && this.queue.length === 0
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
  onElicitation,
  setAppState,
}: {
  configs: Record<string, ScopedMcpServerConfig>
  onConnection: Parameters<typeof getMcpToolsCommandsAndResources>[0]
  onElicitation: InternalOptions['onElicitation']
  setAppState: (f: (prevState: AppState) => AppState) => void
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
      const client = new Client(
        { name: 'claude-code-sdk', version: '1.0.0' },
        { capabilities: { elicitation: {} } },
      )
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
        // Servers may legally elicit from oninitialized. Install the handler
        // before either side starts connecting and exchanging initialization.
        registerElicitationHandler(
          client,
          name,
          setAppState,
          async (params, signal) => {
            // URL elicitation is outside the in-process SDK scope. Form mode
            // follows hooks -> callback -> decline -> result hooks.
            if (params.mode === 'url' || !onElicitation) {
              return { action: 'decline' }
            }
            return onElicitation({ ...params, serverName: name }, { signal })
          },
        )
        await Promise.all([
          client.connect(clientTransport),
          config.instance.connect(serverTransport),
        ])
        connection.capabilities = client.getServerCapabilities() ?? {}
        // This is a new client even when its server name was used by an earlier
        // query. Name-keyed tool wrappers must not retain a closed client.
        fetchToolsForClient.cache.delete(name)
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

function registerSdkHooks(hooks: InternalOptions['hooks']): () => void {
  if (!hooks) return () => {}
  const registered: Partial<Record<HookEvent, InternalHookCallbackMatcher[]>> = {}
  for (const [event, matchers] of Object.entries(hooks)) {
    registered[event as HookEvent] = matchers.map(matcher => ({
      matcher: matcher.matcher,
      hooks: matcher.hooks.map((callback): InternalHookCallback => ({
        type: 'callback',
        timeout: matcher.timeout,
        callback: (input, toolUseID, signal) =>
          callback(input, toolUseID ?? undefined, {
            signal: signal ?? new AbortController().signal,
          }),
      })),
    }))
  }
  return registerHookCallbacks(registered)
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
  remoteControlFactory = connectDaemonBridge,
  organizationUUID,
}: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: InternalOptions
  initialMessages?: Message[] | Promise<Message[]>
  session?: { id: string; projectDir?: string | Promise<string | undefined> }
  remoteControlFactory?: typeof connectDaemonBridge
  organizationUUID?: string
}): InternalQuery {
  const abortController = options.abortController ?? new AbortController()
  const channel = new UserMessageChannel()
  let currentTurnAbortController: AbortController | undefined
  let remoteController: SdkRemoteController | undefined
  let setupPromise: Promise<{
    appState: AppState
    commands: Awaited<ReturnType<typeof getCommands>>
    tools: ReturnType<typeof assembleToolPool>
    thinkingConfig: ThinkingConfig | undefined
    userSpecifiedModel: string | undefined
    readFileCache: ReturnType<typeof createFileStateCacheWithSizeLimit>
    mutableMessages: Parameters<typeof ask>[0]['mutableMessages']
    fileCheckpointing: FileCheckpointing
    releasePersistence: () => void
  }> | undefined

  let releasePersistence: (() => void) | undefined
  let releaseHooks: (() => void) | undefined
  let restoreEnv: (() => void) | undefined

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

  const closeChannelOnExternalAbort = () => channel.close()
  if (abortController.signal.aborted) closeChannelOnExternalAbort()
  else {
    abortController.signal.addEventListener('abort', closeChannelOnExternalAbort, {
      once: true,
    })
  }

  const initialize = () => {
    setupPromise ??= (async () => {
      releaseHooks = registerSdkHooks(options.hooks)
      releasePersistence = acquireSessionPersistence(
        options.persistSession !== false,
      )
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
        const previousEnv = new Map<string, string | undefined>()
        for (const key of Object.keys(options.env)) {
          previousEnv.set(key, process.env[key])
        }
        let envRestored = false
        restoreEnv = () => {
          if (envRestored) return
          envRestored = true
          for (const [key, value] of previousEnv) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
          }
        }
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
        fileHistory: {
          ...appState.fileHistory,
          checkpointingEnabled: options.enableFileCheckpointing,
        },
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
        onElicitation: options.onElicitation,
        setAppState: updater => Object.assign(appState, updater(appState)),
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
      const fileCheckpointing = new FileCheckpointing(
        () => appState.fileHistory,
        updater => {
          Object.assign(appState, {
            fileHistory: updater(appState.fileHistory),
          })
        },
      )

      return {
        appState,
        commands,
        tools,
        thinkingConfig,
        userSpecifiedModel: options.model,
        readFileCache: createFileStateCacheWithSizeLimit(100),
        mutableMessages: (await initialMessages) ?? [],
        fileCheckpointing,
        releasePersistence: releasePersistence!,
      }
    })()
    setupPromise.catch(() => {
      releaseHooks?.()
      restoreEnv?.()
      releasePersistence?.()
    })
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
      if (remoteController) {
        return remoteController.requestPermission(tool.name, input, toolUseID)
      }
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

    let terminalErrorResult: SDKResultMessage | undefined
    const throwTerminalError = (result: SDKResultMessage): never => {
      const diagnostic =
        result.subtype === 'success'
          ? result.result
          : result.errors.join('\n')
      throw new Error(
        diagnostic || `SDK query ended with ${result.subtype}`,
      )
    }

    try {
      for await (const message of channel.iterate()) {
        terminalErrorResult = undefined
        const turnAbortController = new AbortController()
        const forwardExternalAbort = () => {
          turnAbortController.abort(abortController.signal.reason)
        }
        if (abortController.signal.aborted) forwardExternalAbort()
        else {
          abortController.signal.addEventListener('abort', forwardExternalAbort, {
            once: true,
          })
        }
        currentTurnAbortController = turnAbortController
        try {
          const content = message.message.content
          const promptContent: string | ContentBlockParam[] =
            typeof content === 'string' ? content : content
          if (!message.isSynthetic) {
            // A user-visible checkpoint is usable only after its initial state
            // has been committed. QueryEngine's fire-and-forget duplicate is
            // deduplicated by fileHistoryMakeSnapshot.
            await setup.fileCheckpointing.makeSnapshot(message.uuid as UUID)
          }
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
            abortController: turnAbortController,
            replayUserMessages: options.replayUserMessages,
            includePartialMessages: options.includePartialMessages,
            agents: parseAgentsFromJson(options.agents ?? {}),
          })) {
            debug(`message:${output.type}`)
            if (
              output.type === 'result' &&
              (output.subtype !== 'success' || output.is_error)
            ) {
              terminalErrorResult = output
            }
            yield output
          }
          debug('ask:done')
        } finally {
          abortController.signal.removeEventListener(
            'abort',
            forwardExternalAbort,
          )
          if (currentTurnAbortController === turnAbortController) {
            currentTurnAbortController = undefined
          }
        }

        if (
          terminalErrorResult &&
          (channel.isClosedAndDrained() || abortController.signal.aborted)
        ) {
          throwTerminalError(terminalErrorResult)
        }
        if (abortController.signal.aborted) return
      }
      if (terminalErrorResult) throwTerminalError(terminalErrorResult)
    } catch (error) {
      debug(`error:${error instanceof Error ? error.stack : String(error)}`)
      throw error
    } finally {
      await cleanup()
    }
  }

  const query = run() as InternalQuery
  let cleanupPromise: Promise<void> | undefined
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      try {
        const setup = await setupPromise
        if (remoteController) {
          const controller = remoteController
          remoteController = undefined
          await controller.stop()
        }
        if (setup) {
          await Promise.all([
            cleanupClients(setup.appState.mcp.clients),
            runCleanupFunctions(),
            flushSessionStorage(),
          ])
        }
      } finally {
        abortController.signal.removeEventListener(
          'abort',
          closeChannelOnExternalAbort,
        )
        releaseHooks?.()
        restoreEnv?.()
        releasePersistence?.()
      }
    })()
    return cleanupPromise
  }
  const originalReturn = query.return.bind(query)
  query.return = async (value: void | undefined) => {
    try {
      return await originalReturn(value)
    } finally {
      await cleanup()
    }
  }

  return Object.assign(query, {
    interrupt: async () => {
      currentTurnAbortController?.abort('interrupt')
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
    rewindFiles: async (
      userMessageId: string,
      rewindOptions?: { dryRun?: boolean },
    ) => {
      if (options.enableFileCheckpointing === false) {
        return {
          canRewind: false,
          error: 'File checkpointing is not enabled for this SDK query',
        }
      }
      const setup = await initialize()
      return setup.fileCheckpointing.rewindFiles(
        userMessageId,
        rewindOptions,
      )
    },
    setMcpServers: async (servers: Record<string, McpServerConfig>) => {
      const setup = await initialize()
      const previousNames = new Set(
        setup.appState.mcp.clients.map(client => client.name),
      )
      await cleanupClients(setup.appState.mcp.clients)
      // Tool wrappers capture their client. Invalidate name-keyed discovery
      // entries before same-name replacement so the fresh instance is called.
      for (const name of previousNames) fetchToolsForClient.cache.delete(name)
      setup.appState.mcp = {
        ...setup.appState.mcp,
        clients: [],
        tools: [],
        commands: [],
        resources: {},
      }
      await connectMcpConfigs({
        configs: toScopedConfigs(servers),
        onElicitation: options.onElicitation,
        setAppState: updater =>
          Object.assign(setup.appState, updater(setup.appState)),
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
      abortController.abort(reason)
      await query.return(undefined)
    },
    getContextUsage: async () => {
      const setup = await initialize()
      return getSdkContextUsage({
        messages: setup.mutableMessages ?? [],
        tools: setup.tools,
        getAppState: () => setup.appState,
        setAppState: f => {
          Object.assign(setup.appState, f(setup.appState))
        },
        systemPrompt:
          typeof options.systemPrompt === 'string'
            ? options.systemPrompt
            : undefined,
        appendSystemPrompt:
          typeof options.systemPrompt === 'object' &&
          options.systemPrompt.type === 'preset'
            ? options.systemPrompt.append
            : undefined,
      })
    },
    reloadPlugins: async () => {
      const setup = await initialize()
      return reloadSdkPlugins({
        cwd: options.cwd ?? process.cwd(),
        loadCommands: getCommands,
        mcpServers: toMcpStatus(setup.appState.mcp.clients),
        agents: options.agents,
        getAppState: () => setup.appState,
        setAppState: f => {
          Object.assign(setup.appState, f(setup.appState))
        },
      })
    },
    stopTask: async (taskId: string) => {
      const setup = await initialize()
      await stopSdkTask(taskId, {
        getAppState: () => setup.appState,
        setAppState: f => {
          Object.assign(setup.appState, f(setup.appState))
        },
      })
    },
    applyFlagSettings: async (settings: Record<string, unknown>) => {
      const setup = await initialize()
      applySdkFlagSettings(settings)
      if ('model' in settings) {
        setup.userSpecifiedModel =
          settings.model == null ? undefined : String(settings.model)
        Object.assign(setup.appState, {
          mainLoopModel: setup.userSpecifiedModel ?? null,
        })
      }
    },
    getSettings: async () => {
      const setup = await initialize()
      return getSdkSettings(setup.appState)
    },
    enableRemoteControl: async (enabled: boolean) => {
      if (!enabled) {
        const controller = remoteController
        remoteController = undefined
        await controller?.stop()
        return
      }
      if (remoteController) {
        return {
          session_url: remoteController.handle.sessionUrl,
          connect_url: remoteController.handle.sessionUrl,
          environment_id: remoteController.handle.environmentId,
        }
      }
      const setup = await initialize()
      const orgUUID = organizationUUID ?? (await getOrganizationUUID())
      if (!orgUUID) {
        throw new Error('Remote control requires an organization UUID')
      }
      const handle = await remoteControlFactory({
        dir: options.cwd ?? process.cwd(),
        name: 'flash SDK',
        workerType: 'sdk',
        getAccessToken: () => getClaudeAIOAuthTokens()?.accessToken,
        baseUrl: getOauthConfig().BASE_API_URL,
        orgUUID,
        model: setup.userSpecifiedModel ?? getMainLoopModel(),
      })
      if (!handle) {
        throw new Error('Remote control initialization failed')
      }
      remoteController = startSdkRemoteControl({
        handle,
        query,
        channel,
      })
      return {
        session_url: handle.sessionUrl,
        connect_url: handle.sessionUrl,
        environment_id: handle.environmentId,
      }
    },
  })
}
