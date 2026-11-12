import { randomUUID, timingSafeEqual, createHash } from 'crypto'
import { chmodSync, mkdirSync } from 'fs'
import { chmod, lstat, mkdir, unlink } from 'fs/promises'
import { dirname, resolve } from 'path'
import {
  DIRECT_CONNECT_PROTOCOL,
  SessionManager,
  SessionManagerError,
  type CreateSessionRequest,
} from './sessionManager.js'
import type { ServerLogger } from './serverLog.js'
import type { ServerConfig } from './types.js'

export type ServerHandle = {
  port: number | null
  stop: (closeIdleConnections?: boolean) => void
}

type WebSocketData = {
  sessionId: string
  after: number
}

function tokenMatches(actual: string, expected: string): boolean {
  const left = createHash('sha256').update(actual).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}

function authenticated(request: Request, token: string): boolean {
  const header = request.headers.get('authorization') ?? ''
  return header.startsWith('Bearer ') && tokenMatches(header.slice(7), token)
}

function errorResponse(error: unknown): Response {
  const converted =
    error instanceof SessionManagerError
      ? error
      : new SessionManagerError('INTERNAL_ERROR', 'Internal server error', 500)
  return Response.json(
    {
      error: {
        code: converted.code,
        message: converted.message,
        retryable: converted.retryable,
        details: converted.details,
      },
      request_id: randomUUID(),
    },
    { status: converted.status },
  )
}

function parseSessionRequest(value: unknown): CreateSessionRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionManagerError('INVALID_REQUEST', 'Request body must be an object', 400)
  }
  const raw = value as Record<string, unknown>
  if (
    (raw.cwd !== undefined && (typeof raw.cwd !== 'string' || !raw.cwd)) ||
    (raw.dangerously_skip_permissions !== undefined &&
      typeof raw.dangerously_skip_permissions !== 'boolean') ||
    (raw.session_id !== undefined &&
      (typeof raw.session_id !== 'string' || !raw.session_id)) ||
    (raw.client_request_id !== undefined && typeof raw.client_request_id !== 'string')
  ) {
    throw new SessionManagerError('INVALID_REQUEST', 'Invalid session request fields', 400)
  }
  return {
    cwd: raw.cwd as string | undefined,
    dangerouslySkipPermissions: raw.dangerously_skip_permissions as boolean | undefined,
    sessionId: raw.session_id as string | undefined,
    clientRequestId: raw.client_request_id as string | undefined,
  }
}

function websocketHost(config: ServerConfig): string {
  const host =
    config.host === '0.0.0.0'
      ? '127.0.0.1'
      : config.host === '::'
        ? '::1'
        : config.host
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

export function startServer(
  config: ServerConfig,
  sessionManager: SessionManager,
  logger: ServerLogger,
): ServerHandle {
  if (!config.authToken) throw new Error('A bearer token is required')
  if (config.unix) {
    mkdirSync(dirname(resolve(config.unix)), { recursive: true, mode: 0o700 })
    chmodSync(dirname(resolve(config.unix)), 0o700)
  }
  const sockets = new Set<{ close: (code?: number, reason?: string) => void }>()
  const readySockets = new Set<object>()
  const detachBySocket = new WeakMap<object, () => void>()

  let boundPort: number | null = null
  const server = Bun.serve<WebSocketData>({
    ...(config.unix
      ? { unix: resolve(config.unix) }
      : { hostname: config.host, port: config.port }),
    maxRequestBodySize: 64 * 1024,
    async fetch(request, bunServer) {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/health') {
        return Response.json({
          protocol: DIRECT_CONNECT_PROTOCOL,
          pid: process.pid,
          server_version:
            typeof MACRO !== 'undefined' ? MACRO.VERSION : 'unknown',
        })
      }
      if (!authenticated(request, config.authToken)) {
        return errorResponse(
          new SessionManagerError('UNAUTHORIZED', 'Unauthorized', 401),
        )
      }

      if (request.method === 'POST' && url.pathname === '/sessions') {
        try {
          const length = Number(request.headers.get('content-length') ?? 0)
          if (length > 64 * 1024) {
            throw new SessionManagerError(
              'REQUEST_TOO_LARGE',
              'Request body is too large',
              413,
            )
          }
          const text = await request.text()
          if (Buffer.byteLength(text) > 64 * 1024) {
            throw new SessionManagerError(
              'REQUEST_TOO_LARGE',
              'Request body is too large',
              413,
            )
          }
          let body: unknown
          try {
            body = JSON.parse(text)
          } catch {
            throw new SessionManagerError('INVALID_JSON', 'Malformed JSON body', 400)
          }
          const result = await sessionManager.createSession(parseSessionRequest(body))
          const wsUrl = config.unix
            ? `ws://unix/sessions/${result.sessionId}/ws`
            : `ws://${websocketHost(config)}:${boundPort}/sessions/${result.sessionId}/ws`
          return Response.json({
            session_id: result.sessionId,
            ws_url: wsUrl,
            work_dir: result.workDir,
            protocol: DIRECT_CONNECT_PROTOCOL,
            state: result.state,
            resumed: result.resumed,
            last_seq: result.lastSeq,
          })
        } catch (error) {
          logger.warn(`Session request failed: ${error instanceof SessionManagerError ? error.code : 'INTERNAL_ERROR'}`)
          return errorResponse(error)
        }
      }

      const wsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/ws$/)
      if (request.method === 'GET' && wsMatch) {
        const afterText = url.searchParams.get('after') ?? '0'
        const after = Number(afterText)
        if (!/^\d+$/.test(afterText) || !Number.isSafeInteger(after)) {
          return errorResponse(
            new SessionManagerError('INVALID_REQUEST', 'Invalid replay cursor', 400),
          )
        }
        try {
          await sessionManager.getSession(wsMatch[1])
        } catch (error) {
          return errorResponse(error)
        }
        const upgraded = bunServer.upgrade(request, {
          data: { sessionId: wsMatch[1], after },
        })
        return upgraded
          ? undefined
          : errorResponse(
              new SessionManagerError(
                'UPGRADE_FAILED',
                'WebSocket upgrade failed',
                400,
              ),
            )
      }

      const match = url.pathname.match(/^\/sessions\/([^/]+)$/)
      if (match) {
        const id = match[1]
        try {
          if (request.method === 'GET') {
            return Response.json(await sessionManager.getSession(id))
          }
          if (request.method === 'DELETE') {
            return Response.json(await sessionManager.deleteSession(id))
          }
        } catch (error) {
          return errorResponse(error)
        }
      }
      return errorResponse(new SessionManagerError('NOT_FOUND', 'Not found', 404))
    },
    websocket: {
      async open(ws) {
        sockets.add(ws)
        try {
          const detach = await sessionManager.attach(
            ws.data.sessionId,
            ws.data.after,
            record => {
              const frame = `${JSON.stringify(record)}\n`
              if (Buffer.byteLength(frame) > 4 * 1024 * 1024) {
                ws.close(1009, 'Server event too large')
              } else if (ws.readyState === 1) {
                ws.send(frame)
              }
            },
          )
          detachBySocket.set(ws, detach)
          readySockets.add(ws)
        } catch (error) {
          if (ws.readyState === 1) {
            ws.send(
              `${JSON.stringify({
                type: 'direct_connect',
                subtype: 'error',
                code:
                  error instanceof SessionManagerError
                    ? error.code
                    : 'INTERNAL_ERROR',
              })}\n`,
            )
            ws.close(1008, 'Session attach rejected')
          }
        }
      },
      async message(ws, data) {
        if (typeof data !== 'string') {
          ws.close(1003, 'Text frames required')
          return
        }
        const lines = data.split('\n').filter(line => line.trim())
        for (const line of lines) {
          if (Buffer.byteLength(line) > 1024 * 1024) {
            ws.close(1009, 'Message too large')
            return
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            ws.close(1007, 'Invalid JSON')
            return
          }
          try {
            await sessionManager.handleClientMessage(ws.data.sessionId, parsed)
          } catch (error) {
            ws.send(
              `${JSON.stringify({
                type: 'direct_connect',
                subtype: 'error',
                code:
                  error instanceof SessionManagerError
                    ? error.code
                    : 'INTERNAL_ERROR',
              })}\n`,
            )
          }
        }
      },
      close(ws) {
        sockets.delete(ws)
        readySockets.delete(ws)
        detachBySocket.get(ws)?.()
        detachBySocket.delete(ws)
      },
    },
  })

  boundPort = server.port ?? null

  if (config.unix) {
    const socketPath = resolve(config.unix)
    void (async () => {
      await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
      await chmod(dirname(socketPath), 0o700)
      await chmod(socketPath, 0o600)
    })().catch(error => logger.error(`Unable to secure Unix socket: ${String(error)}`))
  }

  const keepalive = setInterval(() => {
    const frame = `${JSON.stringify({ type: 'keep_alive', timestamp: new Date().toISOString() })}\n`
    for (const socket of sockets) {
      if (!readySockets.has(socket)) continue
      const candidate = socket as unknown as {
        readyState: number
        send: (data: string) => void
      }
      if (candidate.readyState === 1) candidate.send(frame)
    }
  }, 15_000)
  keepalive.unref()

  return {
    port: server.port ?? null,
    stop(closeIdleConnections = false) {
      clearInterval(keepalive)
      for (const socket of sockets) socket.close(1001, 'Server shutting down')
      sockets.clear()
      readySockets.clear()
      server.stop(closeIdleConnections)
      if (config.unix) {
        const path = resolve(config.unix)
        void lstat(path)
          .then(info => (info.isSocket() ? unlink(path) : undefined))
          .catch(() => undefined)
      }
    },
  }
}
