import type Anthropic from '@anthropic-ai/sdk'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createConnection } from '@playwright/mcp'

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

export type AnthropicMessagesRequest = {
  model: string
  max_tokens: number
  system: string
  messages: Anthropic.MessageParam[]
  stop_sequences?: string[]
  signal?: AbortSignal
}

export type AnthropicMessagesResponse = {
  content: Array<{ type: 'text'; text: string }>
  stop_reason: string | null
  usage?: { input_tokens: number; output_tokens: number }
}

export type ClaudeForChromeContext = {
  serverName: string
  logger: Logger
  socketPath: string
  getSocketPaths(): string[]
  clientTypeId: string
  onAuthenticationError(): void
  onToolCallDisconnected(): string
  onExtensionPaired(deviceId: string, name: string): void
  getPersistedDeviceId(): string | undefined
  bridgeConfig?: {
    url: string
    getUserId(): Promise<string | undefined>
    getOAuthToken(): Promise<string>
    devUserId?: string
  }
  initialPermissionMode?: PermissionMode
  callAnthropicMessages?(
    request: AnthropicMessagesRequest,
  ): Promise<AnthropicMessagesResponse>
  trackEvent(
    eventName: string,
    metadata?: Record<string, unknown>,
  ): void
}

export type BrowserToolDescriptor = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

function browserConfig() {
  const allowedOrigins = process.env.PLAYWRIGHT_MCP_ALLOWED_ORIGINS?.split(',')
    .map(value => value.trim())
    .filter(Boolean)
  return {
    browser: {
      isolated: true,
      launchOptions: { headless: true },
    },
    ...(allowedOrigins && allowedOrigins.length > 0 ? { allowedOrigins } : {}),
  }
}

export function createClaudeForChromeMcpServer(
  _context: ClaudeForChromeContext,
): Promise<Server> {
  return createConnection(browserConfig())
}

let browserClient: Promise<Client> | undefined

export async function getOpenBrowserClient(): Promise<Client> {
  browserClient ??= (async () => {
    const server = await createClaudeForChromeMcpServer({} as ClaudeForChromeContext)
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'flash-browser', version: '1.0.0' })
    await client.connect(clientTransport)
    return client
  })().catch(error => {
    browserClient = undefined
    throw error
  })
  return browserClient
}

export async function closeOpenBrowserClient(): Promise<void> {
  const pending = browserClient
  browserClient = undefined
  if (pending) await (await pending).close()
}

export async function listBrowserTools(): Promise<BrowserToolDescriptor[]> {
  const client = await getOpenBrowserClient()
  const result = await client.listTools()
  return result.tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
  }))
}
