import { createHash, timingSafeEqual } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { Socket } from 'net'
import {
  MAX_EVENT_BATCH_BYTES,
  OPEN_RUNNER_API_PREFIX,
  OPEN_RUNNER_PROTOCOL,
  OPEN_RUNNER_SERVER_VERSION,
  OpenRunnerError,
  type LeaseIdentity,
  type OpenRunnerRole,
  type WorkState,
  WORK_STATES,
  assertInteger,
  assertUuid,
  errorResponse,
  invalidRequest,
  newId,
  readTokenFile,
} from './protocol.js'
import { OpenRunnerStore, type OpenRunnerStoreOptions } from './store.js'

const MAX_HTTP_BODY_BYTES = MAX_EVENT_BATCH_BYTES + 1024 * 1024

export type OpenRunnerServerOptions = {
  host?: string
  port?: number
  stateDir: string
  workerToken?: string
  adminToken?: string
  workerTokenFile?: string
  adminTokenFile?: string
  leaseMs?: number
  heartbeatIntervalMs?: number
  retryBaseMs?: number
  now?: () => number
  monotonicNow?: () => number
  drainTimeoutMs?: number
}

export type OpenRunnerServerInfo = {
  protocol: typeof OPEN_RUNNER_PROTOCOL
  server_url: string
  state_dir: string
  host: string
  port: number
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

function tokensEqual(received: string, expected: string): boolean {
  return timingSafeEqual(tokenDigest(received), tokenDigest(expected))
}

function authenticate(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization
  if (typeof header !== 'string') return false
  const match = /^Bearer ([^\s]+)$/.exec(header)
  return match !== null && tokensEqual(match[1]!, expected)
}

function protocolSuccess<T extends Record<string, unknown>>(value: T): T & {
  protocol: typeof OPEN_RUNNER_PROTOCOL
} {
  return { protocol: OPEN_RUNNER_PROTOCOL, ...value }
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  requestId: string,
  retryAfterMs?: number,
): void {
  if (response.writableEnded) return
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-request-id': requestId,
    ...(retryAfterMs !== undefined
      ? { 'retry-after': String(Math.max(0, Math.ceil(retryAfterMs / 1000))) }
      : {}),
  })
  response.end(body)
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_HTTP_BODY_BYTES) {
      throw new OpenRunnerError(
        'INVALID_REQUEST',
        'Request body is too large',
        413,
      )
    }
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw invalidRequest('Request body must be valid JSON')
  }
}

function routeWorkId(pathname: string): {
  workId: string
  action: string
} | undefined {
  const match = /^\/open-runner\/v1\/work\/([0-9a-f-]+)(?:\/([a-z]+))?$/.exec(
    pathname,
  )
  if (!match) return undefined
  return { workId: assertUuid(match[1], 'work_id'), action: match[2] ?? '' }
}

function leaseFromQuery(url: URL): LeaseIdentity {
  return {
    runner_id: assertUuid(url.searchParams.get('runner_id'), 'runner_id'),
    instance_id: assertUuid(url.searchParams.get('instance_id'), 'instance_id'),
    worker_epoch: assertInteger(
      Number(url.searchParams.get('worker_epoch')),
      'worker_epoch',
      1,
      1e9,
    ),
    lease_id: assertUuid(url.searchParams.get('lease_id'), 'lease_id'),
  }
}

export class OpenRunnerServer {
  private readonly http: Server
  private readonly sockets = new Set<Socket>()
  private readonly pending = new Set<Promise<void>>()
  private store?: OpenRunnerStore
  private workerToken = ''
  private adminToken = ''
  private info?: OpenRunnerServerInfo
  private draining = false
  private started = false

  constructor(private readonly options: OpenRunnerServerOptions) {
    this.http = createServer((request, response) => {
      const task = this.handle(request, response)
      this.pending.add(task)
      void task.finally(() => this.pending.delete(task))
    })
    this.http.on('connection', socket => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
  }

  get url(): string {
    if (!this.info) throw new Error('Open Runner server has not started')
    return this.info.server_url
  }

  get serverInfo(): OpenRunnerServerInfo {
    if (!this.info) throw new Error('Open Runner server has not started')
    return { ...this.info }
  }

  get stateStore(): OpenRunnerStore {
    if (!this.store) throw new Error('Open Runner server has not started')
    return this.store
  }

  async start(): Promise<OpenRunnerServerInfo> {
    if (this.started) return this.serverInfo
    const host = this.options.host ?? '127.0.0.1'
    if (!isLoopbackHost(host)) {
      throw new Error('Open Runner reference HTTP server only binds to loopback')
    }
    const port = this.options.port ?? 0
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error('Open Runner server port is invalid')
    }
    this.workerToken = await this.resolveToken('worker')
    this.adminToken = await this.resolveToken('admin')
    if (tokensEqual(this.workerToken, this.adminToken)) {
      throw new Error('Worker and admin tokens must be independent')
    }
    const storeOptions: OpenRunnerStoreOptions = {
      stateDir: this.options.stateDir,
      ...(this.options.leaseMs !== undefined
        ? { leaseMs: this.options.leaseMs }
        : {}),
      ...(this.options.heartbeatIntervalMs !== undefined
        ? { heartbeatIntervalMs: this.options.heartbeatIntervalMs }
        : {}),
      ...(this.options.retryBaseMs !== undefined
        ? { retryBaseMs: this.options.retryBaseMs }
        : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.monotonicNow
        ? { monotonicNow: this.options.monotonicNow }
        : {}),
    }
    this.store = new OpenRunnerStore(storeOptions)
    await this.store.initialize()
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        this.http.once('error', onError)
        this.http.listen(port, host, () => {
          this.http.off('error', onError)
          resolve()
        })
      })
    } catch (error) {
      await this.store.close()
      throw error
    }
    const address = this.http.address()
    if (!address || typeof address === 'string') {
      await this.store.close()
      throw new Error('Open Runner server did not bind a TCP address')
    }
    const urlHost = host === '::1' ? '[::1]' : host
    this.info = {
      protocol: OPEN_RUNNER_PROTOCOL,
      server_url: `http://${urlHost}:${address.port}`,
      state_dir: this.options.stateDir,
      host,
      port: address.port,
    }
    this.started = true
    return this.serverInfo
  }

  private async resolveToken(role: OpenRunnerRole): Promise<string> {
    const direct = role === 'worker' ? this.options.workerToken : this.options.adminToken
    const file =
      role === 'worker' ? this.options.workerTokenFile : this.options.adminTokenFile
    if ((direct === undefined) === (file === undefined)) {
      throw new Error(`Exactly one ${role} token or token file is required`)
    }
    const token = direct ?? (await readTokenFile(file!))
    if (token.length < 32 || token.length > 1024 || /\s/.test(token)) {
      throw new Error(`${role} token is invalid`)
    }
    return token
  }

  private role(request: IncomingMessage): OpenRunnerRole {
    const worker = authenticate(request, this.workerToken)
    const admin = authenticate(request, this.adminToken)
    if (!worker && !admin) {
      throw new OpenRunnerError(
        'AUTHENTICATION_FAILED',
        'Authentication failed',
        401,
      )
    }
    return worker ? 'worker' : 'admin'
  }

  private requireRole(actual: OpenRunnerRole, required: OpenRunnerRole): void {
    if (actual !== required) {
      throw new OpenRunnerError('PERMISSION_DENIED', 'Permission denied', 403)
    }
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestId = newId()
    try {
      const url = new URL(request.url ?? '/', 'http://loopback.invalid')
      if (request.method === 'GET' && url.pathname === `${OPEN_RUNNER_API_PREFIX}/health`) {
        sendJson(
          response,
          200,
          {
            protocol: OPEN_RUNNER_PROTOCOL,
            server_version: OPEN_RUNNER_SERVER_VERSION,
            pid: process.pid,
          },
          requestId,
        )
        return
      }
      if (!url.pathname.startsWith(`${OPEN_RUNNER_API_PREFIX}/`)) {
        throw new OpenRunnerError('INVALID_REQUEST', 'Route not found', 404)
      }
      const role = this.role(request)
      const store = this.store!
      const workRoute = routeWorkId(url.pathname)

      if (
        request.method === 'POST' &&
        url.pathname === `${OPEN_RUNNER_API_PREFIX}/runners/register`
      ) {
        this.requireRole(role, 'worker')
        const registration = await store.register(await readJsonBody(request))
        sendJson(response, 200, protocolSuccess(registration as unknown as Record<string, unknown>), requestId)
        return
      }
      if (request.method === 'POST' && url.pathname === `${OPEN_RUNNER_API_PREFIX}/work`) {
        if (this.draining) throw this.drainingError()
        this.requireRole(role, 'admin')
        const work = await store.submit(await readJsonBody(request))
        sendJson(response, 200, { protocol: OPEN_RUNNER_PROTOCOL, work }, requestId)
        return
      }
      if (
        request.method === 'POST' &&
        url.pathname === `${OPEN_RUNNER_API_PREFIX}/work/poll`
      ) {
        this.requireRole(role, 'worker')
        if (this.draining) throw this.drainingError()
        const body = await readJsonBody(request)
        const waitMs =
          typeof body === 'object' && body !== null && 'wait_ms' in body
            ? Number((body as { wait_ms?: unknown }).wait_ms)
            : 0
        if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25_000) {
          throw invalidRequest('wait_ms must be an integer between 0 and 25000')
        }
        const deadline = Date.now() + waitMs
        for (;;) {
          if (this.draining) throw this.drainingError()
          const result = await store.poll(body)
          if (
            result.work.length > 0 ||
            result.cancel_requested.length > 0 ||
            Date.now() >= deadline
          ) {
            sendJson(response, 200, protocolSuccess(result), requestId)
            return
          }
          await store.waitForChange(Math.min(250, deadline - Date.now()))
        }
      }
      if (request.method === 'GET' && url.pathname === `${OPEN_RUNNER_API_PREFIX}/work`) {
        this.requireRole(role, 'admin')
        const rawState = url.searchParams.get('state')
        if (rawState !== null && !WORK_STATES.includes(rawState as WorkState)) {
          throw invalidRequest('state is invalid')
        }
        const limit = Number(url.searchParams.get('limit') ?? 100)
        const works = await store.listWorks((rawState ?? undefined) as WorkState | undefined, limit)
        sendJson(response, 200, { protocol: OPEN_RUNNER_PROTOCOL, work: works }, requestId)
        return
      }
      if (workRoute) {
        const { workId, action } = workRoute
        if (request.method === 'GET' && action === '') {
          if (role === 'worker') {
            // Validate synchronously through the serialized store operation.
            await store.appendEvents(workId, {
              ...leaseFromQuery(url),
              events: [],
            })
          } else {
            this.requireRole(role, 'admin')
          }
          const work = await store.getWork(workId)
          sendJson(response, 200, { protocol: OPEN_RUNNER_PROTOCOL, work }, requestId)
          return
        }
        if (request.method === 'GET' && action === 'events') {
          if (role === 'worker') {
            await store.appendEvents(workId, {
              ...leaseFromQuery(url),
              events: [],
            })
          } else {
            this.requireRole(role, 'admin')
          }
          const after = Number(url.searchParams.get('after') ?? 0)
          const limit = Number(url.searchParams.get('limit') ?? 100)
          const events = await store.readEvents(workId, after, limit)
          sendJson(response, 200, protocolSuccess(events), requestId)
          return
        }
        if (request.method === 'POST' && action === 'cancel') {
          this.requireRole(role, 'admin')
          const work = await store.cancel(workId, await readJsonBody(request))
          sendJson(response, 200, { protocol: OPEN_RUNNER_PROTOCOL, work }, requestId)
          return
        }
        if (request.method === 'POST' && action === 'ack') {
          this.requireRole(role, 'worker')
          const work = await store.acknowledge(workId, await readJsonBody(request))
          sendJson(response, 200, { protocol: OPEN_RUNNER_PROTOCOL, work }, requestId)
          return
        }
        if (request.method === 'POST' && action === 'heartbeat') {
          this.requireRole(role, 'worker')
          const result = await store.heartbeat(workId, await readJsonBody(request))
          sendJson(response, 200, protocolSuccess(result), requestId)
          return
        }
        if (request.method === 'POST' && action === 'events') {
          this.requireRole(role, 'worker')
          const result = await store.appendEvents(workId, await readJsonBody(request))
          sendJson(response, 200, protocolSuccess(result), requestId)
          return
        }
        if (request.method === 'POST' && action === 'complete') {
          this.requireRole(role, 'worker')
          const work = await store.complete(workId, await readJsonBody(request))
          sendJson(response, 200, { protocol: OPEN_RUNNER_PROTOCOL, work }, requestId)
          return
        }
      }
      throw new OpenRunnerError('INVALID_REQUEST', 'Route not found', 404)
    } catch (error) {
      const status =
        error instanceof OpenRunnerError ? error.status : 500
      sendJson(
        response,
        status,
        errorResponse(error, requestId),
        requestId,
        error instanceof OpenRunnerError ? error.retryAfterMs : undefined,
      )
    } finally {
      // Drain bodies for rejected requests so keep-alive sockets remain usable.
      if (!request.readableEnded) request.resume()
    }
  }

  private drainingError(): OpenRunnerError {
    return new OpenRunnerError(
      'SERVER_DRAINING',
      'Server is draining',
      503,
      true,
      {},
      undefined,
      1_000,
    )
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.draining = true
    this.started = false
    this.store?.wakeUp()
    const timeout = this.options.drainTimeoutMs ?? 10_000
    const closed = new Promise<void>(resolve => {
      this.http.close(() => resolve())
    })
    await Promise.race([
      Promise.allSettled([...this.pending]),
      new Promise<void>(resolve => setTimeout(resolve, timeout)),
    ])
    for (const socket of this.sockets) socket.destroy()
    await closed.catch(() => {})
    await this.store?.close()
    this.store = undefined
    this.info = undefined
  }

  async drain(): Promise<void> {
    await this.stop()
  }
}

export async function startOpenRunnerServer(
  options: OpenRunnerServerOptions,
): Promise<OpenRunnerServer> {
  const server = new OpenRunnerServer(options)
  await server.start()
  return server
}
