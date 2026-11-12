import {
  assertLoopbackCdpEndpoint,
  type ClaudeForChromeContext,
  createClaudeForChromeMcpServer,
  DEFAULT_OPEN_CHROME_CDP_ENDPOINT,
  DEFAULT_OPEN_CHROME_CDP_TIMEOUT_MS,
  type Logger,
  type PermissionMode,
} from '@ant/claude-for-chrome-mcp'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { format } from 'util'
import { shutdownDatadog } from '../../services/analytics/datadog.js'
import { shutdown1PEventLogging } from '../../services/analytics/firstPartyEventLogger.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { initializeAnalyticsSink } from '../../services/analytics/sink.js'
import { enableConfigs } from '../config.js'
import { logForDebugging } from '../debug.js'

const SAFE_CHROME_STRING_KEYS = new Set([
  'backend',
  'chrome_status',
  'error_type',
  'permission_mode',
  'tool_name',
])

const PERMISSION_MODES: readonly PermissionMode[] = [
  'ask',
  'skip_all_permission_checks',
  'follow_a_plan',
]

function isPermissionMode(raw: string): raw is PermissionMode {
  return PERMISSION_MODES.some(mode => mode === raw)
}

function readEnv(
  env: Record<string, string> | undefined,
  key: string,
): string | undefined {
  return env?.[key] ?? process.env[key]
}

function parseAllowedOrigins(raw: string | undefined): string[] | undefined {
  const origins = raw
    ?.split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
  return origins && origins.length > 0 ? origins : undefined
}

/** Build the public CDP context used by stdio and in-process MCP clients. */
export function createChromeContext(
  env?: Record<string, string>,
): ClaudeForChromeContext {
  const logger = new DebugLogger()
  const cdpEndpoint = assertLoopbackCdpEndpoint(
    readEnv(env, 'CLAUDE_CHROME_CDP_ENDPOINT') ??
      DEFAULT_OPEN_CHROME_CDP_ENDPOINT,
  )
  const rawTimeout =
    readEnv(env, 'CLAUDE_CHROME_CDP_TIMEOUT_MS') ??
    String(DEFAULT_OPEN_CHROME_CDP_TIMEOUT_MS)
  const cdpTimeoutMs = Number(rawTimeout)
  if (!Number.isFinite(cdpTimeoutMs) || cdpTimeoutMs < 0) {
    throw new Error('CLAUDE_CHROME_CDP_TIMEOUT_MS must be a non-negative number')
  }

  const rawPermissionMode =
    readEnv(env, 'CLAUDE_CHROME_PERMISSION_MODE') ?? 'ask'
  let initialPermissionMode: PermissionMode = 'ask'
  if (isPermissionMode(rawPermissionMode)) {
    initialPermissionMode = rawPermissionMode
  } else {
    logger.warn(
      `Invalid CLAUDE_CHROME_PERMISSION_MODE "${rawPermissionMode}". Valid values: ${PERMISSION_MODES.join(', ')}`,
    )
  }

  const allowedOrigins = parseAllowedOrigins(
    readEnv(env, 'CLAUDE_CHROME_ALLOWED_ORIGINS') ??
      readEnv(env, 'PLAYWRIGHT_MCP_ALLOWED_ORIGINS'),
  )

  logger.info('Using real Chrome over public loopback CDP; private extension pairing is not supported')
  return {
    kind: 'chrome-cdp',
    serverName: 'Claude in Chrome',
    logger,
    cdpEndpoint,
    cdpTimeoutMs,
    ...(allowedOrigins ? { allowedOrigins } : {}),
    initialPermissionMode,
    onToolCallDisconnected: () =>
      'Real Chrome CDP disconnected. The dedicated Chrome profile and its tabs were not closed by Claude. Restart or reconnect the dedicated Chrome instance with loopback remote debugging enabled; Claude will not fall back to an isolated browser.',
    trackEvent: (eventName, metadata) => {
      const safeMetadata: {
        [key: string]:
          | boolean
          | number
          | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          | undefined
      } = {}
      if (metadata) {
        for (const [key, value] of Object.entries(metadata)) {
          const safeKey = key === 'status' ? 'chrome_status' : key
          if (typeof value === 'boolean' || typeof value === 'number') {
            safeMetadata[safeKey] = value
          } else if (
            typeof value === 'string' &&
            SAFE_CHROME_STRING_KEYS.has(safeKey)
          ) {
            safeMetadata[safeKey] =
              value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          }
        }
      }
      logEvent(eventName, safeMetadata)
    },
  }
}

export async function runClaudeInChromeMcpServer(): Promise<void> {
  enableConfigs()
  initializeAnalyticsSink()
  const context = createChromeContext()
  const server = await createClaudeForChromeMcpServer(context)
  const transport = new StdioServerTransport()

  let exiting = false
  const shutdownAndExit = async (): Promise<void> => {
    if (exiting) return
    exiting = true
    await server.close().catch(error => {
      context.logger.warn('Error detaching Chrome MCP server', error)
    })
    await shutdown1PEventLogging()
    await shutdownDatadog()
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  }
  process.stdin.on('end', () => void shutdownAndExit())
  process.stdin.on('error', () => void shutdownAndExit())

  logForDebugging('[Claude in Chrome] Starting public CDP MCP server')
  await server.connect(transport)
  logForDebugging('[Claude in Chrome] Public CDP MCP server started')
}

class DebugLogger implements Logger {
  silly(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'debug' })
  }
  debug(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'debug' })
  }
  info(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'info' })
  }
  warn(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'warn' })
  }
  error(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'error' })
  }
}
