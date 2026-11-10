import type Anthropic from '@anthropic-ai/sdk'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { privatePackageUnavailable } from './unavailable.js'

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

/** An empty catalog disables Chrome setup instead of advertising dead tools. */
export const BROWSER_TOOLS: BrowserToolDescriptor[] = []

export function createClaudeForChromeMcpServer(
  _context: ClaudeForChromeContext,
): Server {
  throw privatePackageUnavailable('@ant/claude-for-chrome-mcp')
}
