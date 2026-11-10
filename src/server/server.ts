import type { SessionManager } from './sessionManager.js'
import type { ServerLogger } from './serverLog.js'
import type { ServerConfig } from './types.js'

export type ServerHandle = {
  port: number | null
  stop: (closeIdleConnections?: boolean) => void
}

export function startServer(
  _config: ServerConfig,
  _sessionManager: SessionManager,
  _logger: ServerLogger,
): ServerHandle {
  throw new Error('The direct-connect server is unavailable in this build')
}
