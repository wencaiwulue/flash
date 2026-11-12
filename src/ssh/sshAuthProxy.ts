import { chmodSync, lstatSync, unlinkSync } from 'fs'
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'http'
import net, { type Socket } from 'net'
import tls from 'tls'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { OAUTH_BETA_HEADER } from '../constants/oauth.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getAnthropicApiKey,
  getApiKeyFromApiKeyHelper,
  getAuthTokenSource,
  getClaudeAIOAuthTokensAsync,
  validateForceLoginOrg,
} from '../utils/auth.js'
import { validateSocketPath } from './argv.js'
import { SSHSessionError } from './errors.js'

export type SSHAuthKind = 'apiKey' | 'bearer' | 'oauth'
export type SSHResolvedAuth = {
  kind: SSHAuthKind
  headers: Record<string, string>
}

export const SSH_PLACEHOLDERS: Record<SSHAuthKind, string> = {
  apiKey: 'ssh-api-key-placeholder',
  bearer: 'ssh-bearer-placeholder',
  oauth: 'ssh-oauth-placeholder',
}

export const SSH_AUTH_ENV: Record<
  SSHAuthKind,
  'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | 'CLAUDE_CODE_OAUTH_TOKEN'
> = {
  apiKey: 'ANTHROPIC_API_KEY',
  bearer: 'ANTHROPIC_AUTH_TOKEN',
  oauth: 'CLAUDE_CODE_OAUTH_TOKEN',
}

function checkedCredential(value: string | null | undefined, label: string): string {
  if (!value || /[\r\n]/.test(value)) {
    throw new SSHSessionError('AUTH_PROXY_FAILED', `${label} is unavailable or invalid`)
  }
  return value
}

export function getSSHAuthKind(): SSHAuthKind {
  const { source } = getAuthTokenSource()
  if (
    source === 'claude.ai' ||
    source === 'CLAUDE_CODE_OAUTH_TOKEN' ||
    source === 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR' ||
    source === 'CCR_OAUTH_TOKEN_FILE'
  ) {
    return 'oauth'
  }
  if (source === 'ANTHROPIC_AUTH_TOKEN') return 'bearer'
  return 'apiKey'
}

export async function resolveSSHAuth(): Promise<SSHResolvedAuth> {
  const kind = getSSHAuthKind()
  if (kind === 'oauth') {
    await checkAndRefreshOAuthTokenIfNeeded()
    const token = checkedCredential(
      (await getClaudeAIOAuthTokensAsync())?.accessToken,
      'OAuth token',
    )
    return {
      kind,
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
    }
  }
  if (kind === 'bearer') {
    return {
      kind,
      headers: {
        Authorization: `Bearer ${checkedCredential(process.env.ANTHROPIC_AUTH_TOKEN, 'Bearer token')}`,
      },
    }
  }
  if (getAuthTokenSource().source === 'apiKeyHelper') {
    await getApiKeyFromApiKeyHelper(getIsNonInteractiveSession())
  }
  return {
    kind,
    headers: { 'x-api-key': checkedCredential(getAnthropicApiKey(), 'API key') },
  }
}

export async function validateSSHAuthentication(
  resolve: () => Promise<SSHResolvedAuth> = resolveSSHAuth,
): Promise<SSHAuthKind> {
  const auth = await resolve()
  const org = await validateForceLoginOrg()
  if (!org.valid) {
    throw new SSHSessionError('AUTH_PROXY_FAILED', org.message)
  }
  return auth.kind
}

const STATIC_HOP_HEADERS = new Set([
  'connection',
  'expect',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'authorization',
  'x-api-key',
  'cookie',
  'host',
])

function filteredHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const connection = headers.connection
  const dynamic = Array.isArray(connection)
    ? connection.join(',')
    : (connection ?? '')
  const hop = new Set(STATIC_HOP_HEADERS)
  for (const name of dynamic.split(',')) hop.add(name.trim().toLowerCase())
  const output: OutgoingHttpHeaders = { host: 'api.anthropic.com' }
  for (const [name, value] of Object.entries(headers)) {
    if (!hop.has(name.toLowerCase())) output[name] = value
  }
  return output
}

function filteredResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const connection = headers.connection
  const dynamic = Array.isArray(connection)
    ? connection.join(',')
    : (connection ?? '')
  const hop = new Set(STATIC_HOP_HEADERS)
  hop.delete('authorization')
  hop.delete('x-api-key')
  hop.delete('cookie')
  hop.delete('host')
  for (const name of dynamic.split(',')) hop.add(name.trim().toLowerCase())
  const output: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!hop.has(name.toLowerCase())) output[name] = value
  }
  return output
}

function writeProtocolError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(message),
    connection: 'close',
  })
  response.end(message)
}

export type SSHAuthProxyOptions = {
  socketPath: string
  resolveAuth?: () => Promise<SSHResolvedAuth>
  /** Test-only loopback transport. Production always uses the fixed HTTPS upstream. */
  upstream?: {
    protocol: 'http:' | 'https:'
    hostname: string
    port?: number
  }
  onError?: (error: Error) => void
}

export type SSHAuthProxy = {
  socketPath: string
  ready: Promise<void>
  stopped: Promise<void>
  stop: () => void
}

function normalizeRequestPath(rawPath: string | undefined): string | undefined {
  if (!rawPath || /[\r\n#]/.test(rawPath)) return undefined
  if (rawPath.startsWith('/v1/') && !rawPath.startsWith('//')) return rawPath
  // Bun's fetch/node:http Unix transport serializes the origin into an
  // absolute-form target even when the caller supplied only a path. Accept
  // only its fixed synthetic origins, discard that origin, and never honor an
  // arbitrary absolute URL or Host as a redirect.
  try {
    const parsed = new URL(rawPath)
    const bunLocal =
      parsed.protocol === 'http:' && parsed.hostname === 'localhost' && !parsed.port
    const fixedAnthropic =
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname === 'api.anthropic.com' &&
      !parsed.port
    if (
      (bunLocal || fixedAnthropic) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash &&
      parsed.pathname.startsWith('/v1/')
    ) {
      return `${parsed.pathname}${parsed.search}`
    }
  } catch {
    // Invalid and non-origin forms are rejected below.
  }
  return undefined
}

function startPinnedUpstream(options: {
  request: IncomingMessage
  response: ServerResponse
  path: string
  headers: OutgoingHttpHeaders
  upstream: NonNullable<SSHAuthProxyOptions['upstream']>
  onError?: (error: Error) => void
}): Socket {
  const { request, response, upstream } = options
  const socket: Socket =
    upstream.protocol === 'http:'
      ? net.connect({ host: upstream.hostname, port: upstream.port ?? 80 })
      : tls.connect({
          host: upstream.hostname,
          port: upstream.port ?? 443,
          servername: 'api.anthropic.com',
        })
  const headers = { ...options.headers, host: 'api.anthropic.com', connection: 'close' }
  const contentLength = headers['content-length']
  const chunkedRequest = contentLength === undefined
  if (chunkedRequest) headers['transfer-encoding'] = 'chunked'
  const lines = [`${request.method ?? 'GET'} ${options.path} HTTP/1.1`]
  for (const [name, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue
    const values = Array.isArray(rawValue) ? rawValue : [rawValue]
    for (const value of values) {
      const text = String(value)
      if (/[\r\n]/.test(name) || /[\r\n]/.test(text)) {
        socket.destroy()
        writeProtocolError(response, 400, 'Invalid upstream header')
        return socket
      }
      lines.push(`${name}: ${text}`)
    }
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  request.on('data', (chunk: Buffer | string) => {
    const body = Buffer.from(chunk)
    if (chunkedRequest) {
      socket.write(`${body.length.toString(16)}\r\n`)
      socket.write(body)
      socket.write('\r\n')
    } else socket.write(body)
  })
  request.on('end', () => {
    if (chunkedRequest) socket.write('0\r\n\r\n')
  })
  request.on('aborted', () => socket.destroy())
  response.on('close', () => {
    if (!socket.destroyed) socket.destroy()
  })

  let headerBuffer = Buffer.alloc(0)
  let responseStarted = false
  let responseEnded = false
  let bodyBuffer = Buffer.alloc(0)
  let chunkedResponse = false
  let responseBytes: number | undefined
  let chunkState: 'size' | 'data' | 'trailer' = 'size'
  let chunkSize = 0

  const fail = (error: Error) => {
    options.onError?.(error)
    socket.destroy()
    if (responseEnded) return
    responseEnded = true
    if (!response.headersSent) writeProtocolError(response, 502, 'Anthropic upstream failed')
    else response.destroy()
  }
  const endResponse = () => {
    if (responseEnded) return
    responseEnded = true
    response.end()
    socket.destroy()
  }
  const writeBody = (body: Buffer) => {
    if (body.length === 0 || responseEnded) return
    if (!response.write(body)) {
      socket.pause()
      response.once('drain', () => socket.resume())
    }
  }
  const consumeBody = (chunk: Buffer) => {
    if (!chunkedResponse) {
      if (responseBytes === undefined) {
        writeBody(chunk)
        return
      }
      const body = chunk.subarray(0, responseBytes)
      responseBytes -= body.length
      writeBody(body)
      if (responseBytes === 0) endResponse()
      return
    }
    bodyBuffer = Buffer.concat([bodyBuffer, chunk])
    while (!responseEnded) {
      if (chunkState === 'size') {
        const end = bodyBuffer.indexOf('\r\n')
        if (end === -1) return
        const sizeText = bodyBuffer.subarray(0, end).toString('ascii').split(';')[0]!
        if (!/^[0-9a-f]+$/i.test(sizeText)) {
          fail(new Error('Invalid upstream chunk size'))
          return
        }
        chunkSize = Number.parseInt(sizeText, 16)
        bodyBuffer = bodyBuffer.subarray(end + 2)
        chunkState = chunkSize === 0 ? 'trailer' : 'data'
      } else if (chunkState === 'data') {
        if (bodyBuffer.length < chunkSize + 2) return
        if (bodyBuffer.subarray(chunkSize, chunkSize + 2).toString('ascii') !== '\r\n') {
          fail(new Error('Invalid upstream chunk framing'))
          return
        }
        writeBody(bodyBuffer.subarray(0, chunkSize))
        bodyBuffer = bodyBuffer.subarray(chunkSize + 2)
        chunkState = 'size'
      } else {
        if (bodyBuffer.length >= 2 && bodyBuffer.subarray(0, 2).toString('ascii') === '\r\n') {
          endResponse()
          return
        }
        const end = bodyBuffer.indexOf('\r\n\r\n')
        if (end === -1) {
          if (bodyBuffer.length > 64 * 1024) fail(new Error('Upstream trailer too large'))
          return
        }
        endResponse()
        return
      }
    }
  }
  const startResponse = (header: Buffer) => {
    const lines = header.toString('latin1').split('\r\n')
    const status = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0] ?? '')
    if (!status || lines.length > 101) throw new Error('Invalid upstream response status')
    const headers: IncomingHttpHeaders = {}
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':')
      if (colon <= 0) throw new Error('Invalid upstream response header')
      const name = line.slice(0, colon).trim().toLowerCase()
      const value = line.slice(colon + 1).trim()
      const previous = headers[name]
      if (previous === undefined) headers[name] = value
      else if (Array.isArray(previous)) previous.push(value)
      else headers[name] = `${previous}, ${value}`
    }
    chunkedResponse = /(?:^|,)\s*chunked\s*(?:,|$)/i.test(
      String(headers['transfer-encoding'] ?? ''),
    )
    if (headers['content-length'] !== undefined) {
      if (chunkedResponse) throw new Error('Ambiguous upstream response framing')
      const length = Number(headers['content-length'])
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new Error('Invalid upstream content length')
      }
      responseBytes = length
    }
    response.writeHead(
      Number(status[1]),
      status[2],
      filteredResponseHeaders(headers),
    )
    responseStarted = true
    if (responseBytes === 0) endResponse()
  }
  socket.on('data', chunk => {
    try {
      if (responseEnded) return
      if (!responseStarted) {
        headerBuffer = Buffer.concat([headerBuffer, Buffer.from(chunk)])
        const end = headerBuffer.indexOf('\r\n\r\n')
        if (end === -1) {
          if (headerBuffer.length > 64 * 1024) throw new Error('Upstream headers too large')
          return
        }
        const body = headerBuffer.subarray(end + 4)
        const header = headerBuffer.subarray(0, end)
        headerBuffer = Buffer.alloc(0)
        startResponse(header)
        consumeBody(body)
      } else consumeBody(Buffer.from(chunk))
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
  socket.on('end', () => {
    if (!responseStarted) {
      fail(new Error('Upstream closed before response headers'))
      return
    }
    if (!chunkedResponse && responseBytes === undefined) endResponse()
    else if (!responseEnded) fail(new Error('Upstream closed in an incomplete response'))
  })
  socket.on('error', fail)
  return socket
}

export function createSSHAuthProxy(options: SSHAuthProxyOptions): SSHAuthProxy {
  const socketPath = validateSocketPath(options.socketPath)
  try {
    lstatSync(socketPath)
    throw new SSHSessionError('AUTH_PROXY_FAILED', `Refusing to replace existing socket: ${socketPath}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const sockets = new Set<Socket>()
  const upstreamRequests = new Set<Socket>()
  const resolveAuth = options.resolveAuth ?? resolveSSHAuth
  const upstream = options.upstream ?? {
    protocol: 'https:' as const,
    hostname: 'api.anthropic.com',
    port: 443,
  }
  let stopping = false
  let listening = false
  let identity: { dev: number; ino: number } | undefined
  let resolveStopped!: () => void
  const stopped = new Promise<void>(resolve => {
    resolveStopped = resolve
  })
  let rejectReady!: (error: Error) => void
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // A late server error after ready rejection must still have a listener.
  ready.catch(() => undefined)

  const server = http.createServer({ maxHeaderSize: 64 * 1024 }, (request, response) => {
    if (stopping) {
      writeProtocolError(response, 503, 'SSH auth proxy is stopping')
      return
    }
    const requestPath = normalizeRequestPath(request.url)
    if (
      request.method === 'CONNECT' ||
      request.method === 'TRACE' ||
      !requestPath
    ) {
      request.resume()
      writeProtocolError(response, 403, 'Only origin-form /v1/ Anthropic API requests are allowed')
      return
    }

    void (async () => {
      let auth: SSHResolvedAuth
      try {
        auth = await resolveAuth()
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)))
        request.resume()
        writeProtocolError(response, 502, 'Local authentication resolution failed')
        return
      }
      if (stopping || response.destroyed) {
        request.resume()
        return
      }
      const headers = filteredHeaders(request.headers)
      for (const [name, value] of Object.entries(auth.headers)) {
        if (name.toLowerCase() === 'anthropic-beta') {
          const existing = request.headers['anthropic-beta']
          const values = Array.isArray(existing) ? existing.join(',') : existing
          headers[name] = values?.includes(OAUTH_BETA_HEADER)
            ? values
            : [values, value].filter(Boolean).join(',')
        } else {
          headers[name] = value
        }
      }
      const upstreamSocket = startPinnedUpstream({
        request,
        response,
        path: requestPath,
        headers,
        upstream,
        onError: options.onError,
      })
      upstreamRequests.add(upstreamSocket)
      upstreamSocket.on('close', () => upstreamRequests.delete(upstreamSocket))
    })().catch(() => {
      if (!response.headersSent) writeProtocolError(response, 500, 'SSH auth proxy failed')
      else response.destroy()
    })
  })
  server.maxHeadersCount = 100
  server.headersTimeout = 15_000
  // Model responses may stream for much longer than a normal HTTP request.
  server.requestTimeout = 0
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('connect', (_request, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
  })
  server.on('clientError', (_error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    } else {
      socket.destroy()
    }
  })
  server.on('error', error => {
    if (!listening) rejectReady(error)
  })
  server.on('close', () => {
    listening = false
    try {
      if (identity) {
        const current = lstatSync(socketPath)
        if (current.isSocket() && current.dev === identity.dev && current.ino === identity.ino) {
          unlinkSync(socketPath)
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Cleanup is best-effort only after identity verification. Never unlink
        // a path another process may have replaced.
      }
    }
    resolveStopped()
  })
  const closeListeningServer = (): void => {
    let replaced = false
    if (identity) {
      try {
        const current = lstatSync(socketPath)
        replaced = current.dev !== identity.dev || current.ino !== identity.ino
      } catch {
        // A missing path cannot belong to a replacement instance.
      }
    }
    if (replaced) {
      // Bun/Node automatically unlink the listen path in server.close(),
      // without checking its inode. The old inode is already unreachable by
      // name, so unref it rather than letting close unlink the replacement.
      server.unref()
      resolveStopped()
      return
    }
    server.close()
  }
  server.listen(socketPath, () => {
    try {
      const info = lstatSync(socketPath)
      identity = { dev: info.dev, ino: info.ino }
      chmodSync(socketPath, 0o600)
      if (stopping) {
        closeListeningServer()
        return
      }
      listening = true
      resolveReady()
    } catch (error) {
      rejectReady(error as Error)
      closeListeningServer()
    }
  })

  const stop = (): void => {
    if (stopping) return
    stopping = true
    for (const request of upstreamRequests) request.destroy()
    for (const socket of sockets) socket.destroy()
    if (listening) closeListeningServer()
    else {
      // If listen has not completed, its callback observes `stopping` and
      // closes immediately. If listen failed, close also settles cleanup.
      try {
        server.close()
      } catch {
        resolveStopped()
      }
    }
  }
  return { socketPath, ready, stopped, stop }
}
