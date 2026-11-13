import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { createConnection } from '@playwright/mcp'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { registerCleanup } from '../utils/cleanupRegistry.js'

export type PermissionMode =
  | 'ask'
  | 'skip_all_permission_checks'
  | 'follow_a_plan'

export type Logger = {
  silly(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

export type OpenChromeContext = {
  kind: 'chrome-cdp'
  serverName: string
  logger: Logger
  cdpEndpoint: string
  cdpTimeoutMs: number
  allowedOrigins?: string[]
  initialPermissionMode: PermissionMode
  onToolCallDisconnected(): string
  trackEvent(name: string, metadata?: Record<string, unknown>): void
}

// Keep the old exported name for source compatibility at call sites. The open
// backend deliberately has no native socket, bridge, or extension pairing API.
export type ClaudeForChromeContext = OpenChromeContext

export type BrowserToolDescriptor = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

type PlaywrightMcpConfig = NonNullable<Parameters<typeof createConnection>[0]>

type ManagedConnection = {
  client: Client
  close(): Promise<void>
}

const PRIVATE_EXTENSION_FIELDS = [
  'socketPath',
  'getSocketPaths',
  'clientTypeId',
  'onAuthenticationError',
  'onExtensionPaired',
  'getPersistedDeviceId',
  'bridgeConfig',
  'callAnthropicMessages',
] as const

export const DEFAULT_OPEN_CHROME_CDP_ENDPOINT = 'http://127.0.0.1:9222'
export const DEFAULT_OPEN_CHROME_CDP_TIMEOUT_MS = 30_000

function allowedOriginsFromEnvironment(): string[] | undefined {
  const origins = process.env.PLAYWRIGHT_MCP_ALLOWED_ORIGINS?.split(',')
    .map(value => value.trim())
    .filter(Boolean)
  return origins && origins.length > 0 ? origins : undefined
}

export function createIsolatedBrowserConfig(options?: {
  allowedOrigins?: string[]
}): PlaywrightMcpConfig {
  const allowedOrigins =
    options?.allowedOrigins ?? allowedOriginsFromEnvironment()
  return {
    browser: {
      isolated: true,
      launchOptions: { headless: true },
    },
    ...(allowedOrigins ? { network: { allowedOrigins } } : {}),
  }
}

export function assertLoopbackCdpEndpoint(endpoint: string): string {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch (error) {
    throw new Error('Invalid Chrome CDP endpoint URL', { cause: error })
  }

  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('Chrome CDP endpoint must use http(s) or ws(s)')
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') {
    throw new Error(
      'Chrome CDP endpoint must use loopback 127.0.0.1 or [::1]; non-loopback and 0.0.0.0 are not allowed',
    )
  }
  if (url.username || url.password) {
    throw new Error('Chrome CDP endpoint must not contain URL userinfo')
  }
  if (url.search || url.hash) {
    throw new Error('Chrome CDP endpoint must not contain query or fragment data')
  }
  return endpoint
}

function assertOpenChromeContext(context: OpenChromeContext): void {
  if (context.kind !== 'chrome-cdp') {
    throw new Error('Real Chrome requires an explicit chrome-cdp context')
  }
  for (const field of PRIVATE_EXTENSION_FIELDS) {
    if ((context as unknown as Record<string, unknown>)[field] !== undefined) {
      throw new Error(
        `Open CDP does not support private extension pairing, native messaging, or bridge configuration (${field})`,
      )
    }
  }
  assertLoopbackCdpEndpoint(context.cdpEndpoint)
  if (
    !Number.isFinite(context.cdpTimeoutMs) ||
    context.cdpTimeoutMs < 0
  ) {
    throw new Error('Chrome CDP timeout must be a non-negative finite number')
  }
}

export function createOpenChromeConfig(
  context: OpenChromeContext,
): PlaywrightMcpConfig {
  assertOpenChromeContext(context)
  return {
    browser: {
      browserName: 'chromium',
      isolated: false,
      cdpEndpoint: context.cdpEndpoint,
      cdpTimeout: context.cdpTimeoutMs,
    },
    ...(context.allowedOrigins
      ? { network: { allowedOrigins: context.allowedOrigins } }
      : {}),
    timeouts: { idle: 0 },
  }
}

async function preflightOpenChrome(context: OpenChromeContext): Promise<void> {
  const endpoint = new URL(context.cdpEndpoint)
  if (endpoint.protocol === 'ws:' || endpoint.protocol === 'wss:') return

  const controller = new AbortController()
  const timeout =
    context.cdpTimeoutMs > 0
      ? setTimeout(
          () => controller.abort(new Error('Chrome CDP preflight timed out')),
          context.cdpTimeoutMs,
        )
      : undefined
  try {
    const versionUrl = new URL('/json/version', endpoint)
    const response = await fetch(versionUrl, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`Chrome CDP preflight returned HTTP ${response.status}`)
    }
    const version = (await response.json()) as {
      Browser?: unknown
      webSocketDebuggerUrl?: unknown
    }
    if (
      typeof version.Browser !== 'string' ||
      !/chrome|chromium/i.test(version.Browser) ||
      typeof version.webSocketDebuggerUrl !== 'string'
    ) {
      throw new Error('Loopback endpoint is not a Chrome/Chromium CDP server')
    }
  } catch (error) {
    throw new Error(
      'Unable to connect to real Chrome over public CDP. Start the dedicated Chrome profile with loopback remote debugging enabled; no isolated browser fallback was started.',
      { cause: error },
    )
  } finally {
    clearTimeout(timeout)
  }
}

function chromeToolDescription(description: string | undefined): string {
  return `Real Chrome over public CDP (not the private Claude Chrome extension). ${description ?? ''}`.trim()
}

const NODE_CDP_SIDECAR = String.raw`
import { createConnection } from '@playwright/mcp'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
const server = await createConnection(JSON.parse(process.env.OPEN_CHROME_PLAYWRIGHT_CONFIG))
await server.connect(new StdioServerTransport())
`

async function connectPlaywrightUpstream(
  context: OpenChromeContext,
): Promise<{ client: Client; server?: Server }> {
  // Bun's node:http upgrade emulation currently cannot complete Playwright's
  // ws-based CDP handshake. Keep the exact same public Playwright config and
  // MCP protocol, but run only the upstream transport in Node when necessary.
  if (typeof Bun !== 'undefined') {
    const client = new Client({ name: context.serverName, version: '1.0.0' })
    const transport = new StdioClientTransport({
      command: process.env.CLAUDE_CHROME_NODE_EXECUTABLE ?? 'node',
      args: ['--input-type=module', '--eval', NODE_CDP_SIDECAR],
      cwd: dirname(fileURLToPath(import.meta.url)),
      env: {
        ...process.env,
        OPEN_CHROME_PLAYWRIGHT_CONFIG: JSON.stringify(
          createOpenChromeConfig(context),
        ),
      } as Record<string, string>,
      stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 32_768) stderr += chunk.toString()
    })
    try {
      await client.connect(transport)
      return { client }
    } catch (error) {
      await client.close().catch(() => undefined)
      context.logger.error(
        `Node CDP sidecar failed${stderr ? `: ${stderr.slice(0, 1024)}` : ''}`,
      )
      throw error
    }
  }

  const server = await createConnection(createOpenChromeConfig(context))
  const client = new Client({ name: context.serverName, version: '1.0.0' })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, server }
}

/**
 * Put a small MCP facade in front of Playwright. Besides making browser_close
 * safe for an attached default context, this gives every transport (including
 * stdio) the same filtered schemas, serialized calls, and error propagation.
 */
async function createOpenChromeProxyServer(
  context: OpenChromeContext,
): Promise<Server> {
  assertOpenChromeContext(context)
  context.trackEvent('open_chrome_connection', {
    backend: 'chrome-cdp',
    status: 'connecting',
    permission_mode: context.initialPermissionMode,
    origins_restricted: Boolean(context.allowedOrigins?.length),
  })
  context.logger.info('Connecting to real Chrome over public loopback CDP')
  await preflightOpenChrome(context)

  const { client: upstreamClient, server: upstreamServer } =
    await connectPlaywrightUpstream(context)

  const proxy = new Server(
    { name: context.serverName, version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  )
  let closing = false
  let disconnected = false
  let toolQueue: Promise<unknown> = Promise.resolve()
  let upstreamClosePromise: Promise<void> | undefined

  const closeUpstream = (): Promise<void> => {
    closing = true
    upstreamClosePromise ??= closeResources([
      () => upstreamClient.close(),
      ...(upstreamServer ? [() => upstreamServer.close()] : []),
    ]).catch(error => {
      upstreamClosePromise = undefined
      throw error
    })
    return upstreamClosePromise
  }

  upstreamClient.onclose = () => {
    disconnected = true
    if (closing) return
    const message = context.onToolCallDisconnected()
    context.logger.error(message)
    context.trackEvent('open_chrome_connection', {
      backend: 'chrome-cdp',
      status: 'disconnected',
    })
  }

  proxy.onclose = () => {
    closing = true
    context.logger.info('Detaching from real Chrome; preserving its default context and tabs')
    context.trackEvent('open_chrome_connection', {
      backend: 'chrome-cdp',
      status: 'detached',
    })
    void closeUpstream().catch(error => {
      context.logger.warn('Error detaching Chrome CDP upstream', error)
    })
  }
  const closeProxy = proxy.close.bind(proxy)
  proxy.close = async () => {
    closing = true
    try {
      await closeProxy()
    } finally {
      await closeUpstream()
    }
  }

  proxy.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await upstreamClient.listTools()
    return {
      ...result,
      tools: result.tools
        .filter(tool => tool.name !== 'browser_close')
        .map(tool => ({
          ...tool,
          description: chromeToolDescription(tool.description),
        })),
    }
  })

  proxy.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name
    if (toolName === 'browser_close') {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'browser_close is disabled for real Chrome. Detach the MCP connection instead, or explicitly close one tab with browser_tabs(close).',
          },
        ],
        isError: true,
      }
    }

    const startedAt = Date.now()
    const call = toolQueue.then(async () => {
      context.trackEvent('open_chrome_tool', {
        tool_name: toolName,
        status: 'started',
      })
      try {
        const result = await upstreamClient.callTool(
          {
            name: toolName,
            arguments: request.params.arguments ?? {},
            ...(request.params._meta ? { _meta: request.params._meta } : {}),
          },
          undefined,
          { signal: extra.signal },
        )
        context.trackEvent('open_chrome_tool', {
          tool_name: toolName,
          status: 'isError' in result && result.isError ? 'error' : 'succeeded',
          duration_ms: Date.now() - startedAt,
        })
        return result
      } catch (error) {
        context.trackEvent('open_chrome_tool', {
          tool_name: toolName,
          status: 'error',
          error_type: error instanceof Error ? error.name : 'unknown',
          duration_ms: Date.now() - startedAt,
        })
        if (disconnected && !closing) {
          throw new Error(context.onToolCallDisconnected(), { cause: error })
        }
        throw error
      }
    })
    toolQueue = call.catch(() => undefined)
    return call
  })

  return proxy
}

export async function createClaudeForChromeMcpServer(
  context: ClaudeForChromeContext,
): Promise<Server> {
  try {
    return await createOpenChromeProxyServer(context)
  } catch (error) {
    context.logger.error('Failed to connect real Chrome over public CDP', error)
    context.trackEvent('open_chrome_connection', {
      backend: 'chrome-cdp',
      status: 'failed',
      error_type: error instanceof Error ? error.name : 'unknown',
    })
    throw error
  }
}

async function closeResources(
  cleanups: Array<() => Promise<void>>,
): Promise<void> {
  const errors: unknown[] = []
  for (const cleanup of cleanups) {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        cleanup(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Browser resource cleanup timed out')),
            10_000,
          )
          timer.unref()
        }),
      ])
    } catch (error) {
      errors.push(error)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Failed to close browser resources')
  }
}

async function connectInMemory(
  server: Server,
  clientName: string,
  dispose?: () => Promise<void>,
): Promise<ManagedConnection> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: clientName, version: '1.0.0' })
  try {
    await client.connect(clientTransport)
  } catch (error) {
    await closeResources([
      () => server.close(),
      ...(dispose ? [dispose] : []),
    ]).catch(() => undefined)
    throw error
  }
  let closePromise: Promise<void> | undefined
  return {
    client,
    close: () => {
      closePromise ??= closeResources([
        () => client.close(),
        () => server.close(),
        ...(dispose ? [dispose] : []),
      ]).catch(error => {
        closePromise = undefined
        throw error
      })
      return closePromise
    },
  }
}

let isolatedGeneration = 0
let isolatedConnection:
  | { generation: number; promise: Promise<ManagedConnection> }
  | undefined

export async function getOpenBrowserClient(): Promise<Client> {
  await closeResources(
    [...isolatedCloses.keys()].map(
      pending => () => closeIsolatedConnection(pending),
    ),
  )
  if (!isolatedConnection) {
    registerCleanup(closeOpenBrowserClient)
    const generation = ++isolatedGeneration
    const promise = (async () => {
      const config = createIsolatedBrowserConfig()
      const launchArgs = [...(config.browser?.launchOptions?.args ?? [])]
      if (!launchArgs.some(arg => arg.includes('--disable-blink-features'))) {
        launchArgs.push('--disable-blink-features=AutomationControlled')
      }
      const browsers = new Set<Browser>()
      const idleTimers = new Map<Browser, NodeJS.Timeout>()
      const idleTimeout = config.timeouts?.idle ?? 60 * 60 * 1000
      const pendingContexts = new Set<Promise<BrowserContext>>()
      let closing = false
      const scheduleIdle = (browser: Browser): void => {
        const existing = idleTimers.get(browser)
        if (existing) clearTimeout(existing)
        if (closing || !idleTimeout) return
        const timer = setTimeout(() => {
          void browser.close().catch(() => undefined)
        }, idleTimeout)
        timer.unref()
        idleTimers.set(browser, timer)
      }
      const contextGetter = (): Promise<BrowserContext> => {
        if (closing) {
          return Promise.reject(new Error('Isolated Chrome connection is closing'))
        }
        const context = (async () => {
          const browser = await chromium.launch({
            channel: 'chrome',
            chromiumSandbox: true,
            ...config.browser?.launchOptions,
            args: launchArgs,
            handleSIGINT: false,
            handleSIGTERM: false,
          })
          if (closing) {
            await browser.close()
            throw new Error('Isolated Chrome connection is closing')
          }
          browsers.add(browser)
          scheduleIdle(browser)
          browser.once('disconnected', () => {
            const timer = idleTimers.get(browser)
            if (timer) clearTimeout(timer)
            idleTimers.delete(browser)
            browsers.delete(browser)
          })
          try {
            return await browser.newContext({
              ...config.browser?.contextOptions,
              viewport:
                config.browser?.contextOptions?.viewport ??
                (config.browser?.launchOptions?.headless
                  ? { width: 1280, height: 720 }
                  : null),
            })
          } catch (error) {
            await browser.close().catch(() => undefined)
            throw error
          }
        })()
        pendingContexts.add(context)
        return context.finally(() => pendingContexts.delete(context))
      }
      let disposePromise: Promise<void> | undefined
      const dispose = (): Promise<void> => {
        disposePromise ??= (async () => {
          closing = true
          for (const timer of idleTimers.values()) clearTimeout(timer)
          idleTimers.clear()
          const closeBrowsers = async () => {
            const results = await Promise.allSettled(
              [...browsers].map(browser => browser.close()),
            )
            return results.flatMap(result =>
              result.status === 'rejected' ? [result.reason] : [],
            )
          }
          const errors = await closeBrowsers()
          await Promise.allSettled([...pendingContexts])
          errors.push(...(await closeBrowsers()))
          if (errors.length === 1) throw errors[0]
          if (errors.length > 1) {
            throw new AggregateError(errors, 'Failed to close isolated Chrome')
          }
        })().catch(error => {
          disposePromise = undefined
          throw error
        })
        return disposePromise
      }
      try {
        const server = await createConnection(
          {
            ...config,
            browser: { ...config.browser, isolated: false },
          },
          contextGetter,
        )
        const connection = await connectInMemory(
          server,
          'flash-browser',
          dispose,
        )
        const callTool = connection.client.callTool.bind(connection.client)
        connection.client.callTool = ((
          ...args: Parameters<typeof callTool>
        ) => {
          for (const browser of browsers) scheduleIdle(browser)
          return callTool(...args)
        }) as typeof callTool
        const connectionPromise = Promise.resolve(connection)
        connection.client.onclose = () => {
          if (isolatedConnection?.generation === generation) {
            isolatedConnection = undefined
            ++isolatedGeneration
          }
          void closeIsolatedConnection(connectionPromise).catch(() => undefined)
        }
        if ((isolatedConnection as { generation: number } | undefined)?.generation !== generation) {
          await connection.close()
          throw new Error('Isolated browser connection was superseded')
        }
        return connection
      } catch (error) {
        await dispose().catch(() => undefined)
        throw error
      }
    })().catch(error => {
      if (isolatedConnection?.generation === generation) {
        isolatedConnection = undefined
      }
      throw error
    })
    isolatedConnection = { generation, promise }
  }
  return (await isolatedConnection.promise).client
}

const isolatedCloses = new Map<
  Promise<ManagedConnection>,
  Promise<void>
>()

async function closeIsolatedConnection(
  pending: Promise<ManagedConnection>,
): Promise<void> {
  while (true) {
    const existing = isolatedCloses.get(pending)
    if (existing) {
      try {
        await existing
        return
      } catch {
        if (isolatedCloses.get(pending) === existing) {
          isolatedCloses.delete(pending)
        }
        continue
      }
    }

    const close = (async () => {
      const connection = await pending.catch(() => undefined)
      await connection?.close()
    })()
    isolatedCloses.set(pending, close)
    try {
      await close
      if (isolatedCloses.get(pending) === close) {
        isolatedCloses.delete(pending)
      }
      return
    } catch (error) {
      // Keep the failed close available so the next caller can retry disposal.
      throw error
    }
  }
}

export async function closeOpenBrowserClient(
  expectedClient?: Client,
): Promise<void> {
  const pending = isolatedConnection
  if (pending) {
    if (expectedClient) {
      const connection = await pending.promise.catch(() => undefined)
      if (connection?.client !== expectedClient) return
    }
    if (isolatedConnection !== pending) return
    isolatedConnection = undefined
    ++isolatedGeneration
    await closeIsolatedConnection(pending.promise)
    return
  }

  if (expectedClient) {
    for (const [connectionPromise, close] of isolatedCloses) {
      const connection = await connectionPromise.catch(() => undefined)
      if (connection?.client === expectedClient) {
        await close
        return
      }
    }
    return
  }

  await closeResources(
    [...isolatedCloses.keys()].map(
      pending => () => closeIsolatedConnection(pending),
    ),
  )
}

let chromeGeneration = 0
let chromeConnection:
  | {
      generation: number
      promise: Promise<ManagedConnection>
    }
  | undefined

export async function getOpenChromeClient(
  context: OpenChromeContext,
): Promise<Client> {
  if (!chromeConnection) {
    const generation = ++chromeGeneration
    const promise = (async () => {
      const server = await createClaudeForChromeMcpServer(context)
      const connection = await connectInMemory(server, 'open-chrome-cdp')
      connection.client.onclose = () => {
        if (chromeConnection?.generation === generation) {
          chromeConnection = undefined
        }
      }
      if ((chromeConnection as { generation: number } | undefined)?.generation !== generation) {
        await connection.close()
        throw new Error('Open Chrome connection was superseded')
      }
      return connection
    })().catch(error => {
      if (chromeConnection?.generation === generation) {
        chromeConnection = undefined
      }
      throw error
    })
    chromeConnection = { generation, promise }
  }
  return (await chromeConnection.promise).client
}

export async function closeOpenChromeClient(expectedClient?: Client): Promise<void> {
  const pending = chromeConnection
  if (!pending) return
  if (expectedClient) {
    const connection = await pending.promise.catch(() => undefined)
    if (connection?.client !== expectedClient) return
  }
  if (chromeConnection === pending) {
    chromeConnection = undefined
    ++chromeGeneration
  }
  await (await pending.promise).close()
}

function descriptors(
  tools: Awaited<ReturnType<Client['listTools']>>['tools'],
): BrowserToolDescriptor[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
  }))
}

export async function listBrowserTools(): Promise<BrowserToolDescriptor[]> {
  const client = await getOpenBrowserClient()
  return descriptors((await client.listTools()).tools)
}

export async function listOpenChromeTools(
  context: OpenChromeContext,
): Promise<BrowserToolDescriptor[]> {
  const client = await getOpenChromeClient(context)
  return descriptors((await client.listTools()).tools)
}

export async function callOpenChromeTool(
  context: OpenChromeContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{
  content: unknown
  isError?: boolean
  [key: string]: unknown
}> {
  const client = await getOpenChromeClient(context)
  return (await client.callTool({ name, arguments: args })) as {
    content: unknown
    isError?: boolean
    [key: string]: unknown
  }
}
