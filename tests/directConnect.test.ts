import '../src/runtimeMacros.ts'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import UnixWebSocket from 'ws'
import { DangerousBackend } from '../src/server/backends/dangerousBackend.ts'
import { ProcessBackend } from '../src/server/backends/processBackend.ts'
import { runConnectHeadless } from '../src/server/connectHeadless.ts'
import { createDirectConnectSession } from '../src/server/createDirectConnectSession.ts'
import { DirectConnectSessionManager } from '../src/server/directConnectManager.ts'
import { probeRunningServer, removeServerLock, writeServerLock } from '../src/server/lockfile.ts'
import { parseConnectUrl } from '../src/server/parseConnectUrl.ts'
import { startServer, type ServerHandle } from '../src/server/server.ts'
import { SessionManager, type CreateSessionResult } from '../src/server/sessionManager.ts'
import type { BackendCreateOptions } from '../src/server/backends/processBackend.ts'
import { getProcessStartToken } from '../src/utils/processIdentity.ts'

class FakeSession extends EventEmitter {
  readonly process = null
  readonly pid = undefined
  readonly writes: string[] = []
  stopped = false
  write(value: string) {
    this.writes.push(value)
  }
  interrupt() {}
  async stop() {
    if (this.stopped) return
    this.stopped = true
    this.emit('exit', { code: 0, signal: 'SIGTERM', stderr: '' })
  }
}

class FakeBackend {
  readonly sessions = new Map<string, FakeSession>()
  readonly creates: BackendCreateOptions[] = []
  async create(options: BackendCreateOptions) {
    this.creates.push(options)
    const session = new FakeSession()
    this.sessions.set(options.sessionId, session)
    return session as never
  }
  async destroyAll() {
    await Promise.all([...this.sessions.values()].map(session => session.stop()))
  }
  emit(id: string, value: Record<string, unknown>) {
    this.sessions.get(id)?.emit('stdout', JSON.stringify(value))
  }
}

const logger = { debug() {}, info() {}, warn() {}, error() {} }
let temp: string
let configDir: string
let workspace: string
let manager: SessionManager | undefined
let server: ServerHandle | undefined
let backend: FakeBackend
let previousConfig: string | undefined

beforeEach(async () => {
  temp = await mkdtemp('/tmp/direct-connect-test-')
  configDir = join(temp, 'config')
  workspace = join(temp, 'workspace')
  await mkdir(workspace, { recursive: true })
  previousConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  backend = new FakeBackend()
})

afterEach(async () => {
  server?.stop(true)
  await manager?.destroyAll()
  server = undefined
  manager = undefined
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  await rm(temp, { recursive: true, force: true })
})

async function setup(options: {
  token?: string
  maxSessions?: number
  idleTimeoutMs?: number
  allowDangerous?: boolean
  unix?: string
  eventLogLimitBytes?: number
} = {}) {
  const token = options.token ?? 'test-secret'
  manager = new SessionManager(backend as never, {
    idleTimeoutMs: options.idleTimeoutMs ?? 0,
    maxSessions: options.maxSessions ?? 0,
    workspace,
    allowDangerousSkipPermissions: options.allowDangerous,
    configDir,
    transcriptExists: async () => true,
    idleSweepIntervalMs: 10,
    eventLogLimitBytes: options.eventLogLimitBytes,
  })
  server = startServer(
    {
      host: '127.0.0.1',
      port: 0,
      authToken: token,
      workspace,
      unix: options.unix,
      allowDangerousSkipPermissions: options.allowDangerous,
    },
    manager,
    logger,
  )
  const serverUrl = options.unix
    ? `http://unix${options.unix}`
    : `http://127.0.0.1:${server.port}`
  return { token, serverUrl }
}

async function post(serverUrl: string, token: string, body: unknown) {
  const unix = serverUrl.startsWith('http://unix')
    ? serverUrl.slice('http://unix'.length)
    : undefined
  return fetch(`${unix ? 'http://localhost' : serverUrl}/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(unix ? ({ unix } as unknown as RequestInit) : {}),
  })
}

class WsInbox {
  readonly ws: WebSocket
  readonly records: Record<string, unknown>[] = []
  private waiters: (() => void)[] = []
  readonly opened: Promise<void>
  readonly closed: Promise<{ code: number }>
  constructor(url: string, token: string, unix?: string) {
    this.ws = unix
      ? (new UnixWebSocket(
          `ws+unix://${unix}:${new URL(url.replace('ws://unix/', 'ws://localhost/')).pathname}`,
          { headers: { authorization: `Bearer ${token}` } },
        ) as unknown as WebSocket)
      : new WebSocket(url, {
          headers: { authorization: `Bearer ${token}` },
        } as unknown as string[])
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', event => reject(
        (event as unknown as { error?: Error }).error ?? new Error('WebSocket connection failed'),
      ))
    })
    this.closed = new Promise(resolve =>
      this.ws.addEventListener('close', event => resolve({ code: event.code })),
    )
    this.ws.addEventListener('message', event => {
      if (typeof event.data !== 'string') return
      for (const line of event.data.split('\n')) {
        if (line.trim()) this.records.push(JSON.parse(line))
      }
      for (const wake of this.waiters.splice(0)) wake()
    })
  }
  async next(index: number, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs
    while (this.records.length <= index && Date.now() < deadline) {
      await new Promise<void>(resolve => {
        this.waiters.push(resolve)
        setTimeout(resolve, 20)
      })
    }
    if (!this.records[index]) throw new Error(`missing frame ${index}`)
    return this.records[index]
  }
  close() {
    this.ws.close()
  }
}

test('URL tokens stay out of transport URLs and environment token wins', () => {
  const previous = process.env.CLAUDE_DIRECT_CONNECT_TOKEN
  process.env.CLAUDE_DIRECT_CONNECT_TOKEN = 'environment-secret'
  try {
    const parsed = parseConnectUrl('cc://user:pw@localhost:123/base?token=url-secret#x')
    expect(parsed.serverUrl).toBe('http://localhost:123/base')
    expect(parsed.authToken).toBe('environment-secret')
    expect(parsed.serverUrl).not.toContain('secret')
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_DIRECT_CONNECT_TOKEN
    else process.env.CLAUDE_DIRECT_CONNECT_TOKEN = previous
  }
})

test('loopback requires auth and implements idempotency, max sessions and metadata', async () => {
  const { token, serverUrl } = await setup({ maxSessions: 1 })
  const health = await fetch(`${serverUrl}/health`).then(response => response.json())
  expect(health).toMatchObject({ protocol: 'direct-connect-v1', pid: process.pid })
  expect((await post(serverUrl, 'wrong', { cwd: workspace })).status).toBe(401)
  const request = { cwd: workspace, client_request_id: crypto.randomUUID() }
  const first = await post(serverUrl, token, request)
  expect(first.status).toBe(200)
  const created = await first.json()
  expect(created.ws_url).not.toContain(token)
  expect(created.work_dir).toBe(await realpath(workspace))
  const again = await post(serverUrl, token, request)
  expect((await again.json()).session_id).toBe(created.session_id)
  expect(backend.creates).toHaveLength(1)
  const conflict = await post(serverUrl, token, {
    ...request,
    dangerously_skip_permissions: true,
  })
  expect(conflict.status).toBe(409)
  expect((await conflict.json()).error.code).toBe('IDEMPOTENCY_CONFLICT')
  expect((await post(serverUrl, token, { cwd: workspace })).status).toBe(429)
  const info = await fetch(`${serverUrl}/sessions/${created.session_id}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect((await info.json()).last_seq).toBe(0)
  expect((await stat(join(configDir, 'server-sessions.json'))).mode & 0o777).toBe(0o600)
})

test('workspace escape and one-sided dangerous mode are rejected', async () => {
  const { token, serverUrl } = await setup()
  const escape = await post(serverUrl, token, { cwd: temp })
  expect(escape.status).toBe(403)
  expect((await escape.json()).error.code).toBe('CWD_NOT_ALLOWED')
  const dangerous = await post(serverUrl, token, {
    cwd: workspace,
    dangerously_skip_permissions: true,
  })
  expect(dangerous.status).toBe(403)
  expect((await dangerous.json()).error.code).toBe('DANGEROUS_MODE_DISABLED')
})

test('WebSocket accepts NDJSON, persists replay, and validates frames and controls', async () => {
  const { token, serverUrl } = await setup()
  const created = await (await post(serverUrl, token, { cwd: workspace })).json()
  const socket = new WsInbox(created.ws_url, token)
  await socket.opened
  expect(await socket.next(0)).toMatchObject({ subtype: 'ready', last_seq: 0 })
  socket.ws.send(
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'one' } })}\n` +
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'two' } })}`,
  )
  await new Promise(resolve => setTimeout(resolve, 30))
  const id = created.session_id as string
  expect(backend.sessions.get(id)?.writes).toHaveLength(2)
  expect(JSON.parse(backend.sessions.get(id)!.writes[0]).session_id).toBe(id)
  backend.emit(id, { type: 'assistant', message: { content: [] } })
  expect(await socket.next(1)).toMatchObject({ type: 'assistant', seq: 1 })
  socket.ws.send(JSON.stringify({
    type: 'control_request', request_id: 'unknown-1', request: { subtype: 'mystery' },
  }))
  expect(await socket.next(2)).toMatchObject({
    type: 'control_response',
    response: { subtype: 'error', request_id: 'unknown-1' },
  })
  socket.close()

  const replay = new WsInbox(`${created.ws_url}?after=0`, token)
  await replay.opened
  expect((await replay.next(1)).seq).toBe(1)
  expect((await replay.next(2)).seq).toBe(2)
  replay.ws.send('not-json')
  expect((await replay.closed).code).toBe(1007)

  const binary = new WsInbox(created.ws_url, token)
  await binary.opened
  await binary.next(0)
  binary.ws.send(new Uint8Array([1, 2, 3]))
  expect((await binary.closed).code).toBe(1003)

  const oversized = new WsInbox(created.ws_url, token)
  await oversized.opened
  await oversized.next(0)
  oversized.ws.send('x'.repeat(1024 * 1024 + 1))
  expect((await oversized.closed).code).toBe(1009)
})

test('control response IDs are deduplicated and conflicting content is rejected', async () => {
  const { token, serverUrl } = await setup()
  const created = await (await post(serverUrl, token, { cwd: workspace })).json()
  const socket = new WsInbox(created.ws_url, token)
  await socket.opened
  await socket.next(0)
  const response = {
    type: 'control_response',
    response: {
      subtype: 'success', request_id: 'permission-1',
      response: { behavior: 'deny', message: 'no' },
    },
  }
  socket.ws.send(JSON.stringify(response))
  socket.ws.send(JSON.stringify(response))
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(backend.sessions.get(created.session_id)?.writes).toHaveLength(1)
  socket.ws.send(JSON.stringify({
    ...response,
    response: { ...response.response, response: { behavior: 'allow', updatedInput: {} } },
  }))
  expect(await socket.next(1)).toMatchObject({ code: 'CONTROL_ID_CONFLICT' })
  socket.close()
})

test('DELETE is idempotent and explicit resume uses the indexed transcript', async () => {
  const { token, serverUrl } = await setup()
  const created = await (await post(serverUrl, token, { cwd: workspace })).json()
  for (let count = 0; count < 2; count++) {
    const response = await fetch(`${serverUrl}/sessions/${created.session_id}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    expect((await response.json()).state).toBe('stopped')
  }
  const resumed = await post(serverUrl, token, {
    cwd: workspace,
    session_id: created.session_id,
    client_request_id: crypto.randomUUID(),
  })
  expect(resumed.status).toBe(200)
  expect((await resumed.json()).resumed).toBe(true)
  expect(backend.creates[1].resumeTranscriptId).toBe(created.session_id)
  expect((await post(serverUrl, token, { session_id: crypto.randomUUID() })).status).toBe(404)
})

test('idle reaps detached sessions but never attached sessions', async () => {
  const { token, serverUrl } = await setup({ idleTimeoutMs: 250 })
  const created = await (await post(serverUrl, token, { cwd: workspace })).json()
  const socket = new WsInbox(created.ws_url, token)
  await socket.opened
  expect(await socket.next(0)).toMatchObject({ subtype: 'ready', state: 'running' })
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(backend.sessions.get(created.session_id)?.stopped).toBe(false)
  socket.close()
  await new Promise(resolve => setTimeout(resolve, 500))
  expect(backend.sessions.get(created.session_id)?.stopped).toBe(true)
})

test('real DirectConnect client and headless produce text and deny permission', async () => {
  const { token, serverUrl } = await setup()
  const { config } = await createDirectConnectSession({ serverUrl, authToken: token, cwd: workspace })
  const id = config.sessionId
  backend.sessions.get(id)!.write = value => {
    backend.sessions.get(id)!.writes.push(value)
    const message = JSON.parse(value)
    if (message.type === 'user') {
      backend.emit(id, { type: 'control_request', request_id: 'p1', request: {
        subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't1', input: {},
      } })
    } else if (message.type === 'control_response') {
      backend.emit(id, { type: 'assistant', message: { content: [{ type: 'text', text: 'denied ok' }] } })
      backend.emit(id, { type: 'result', subtype: 'success', is_error: false })
    }
  }
  let output = ''
  const original = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString()
    return true
  }) as typeof process.stdout.write
  try {
    await runConnectHeadless(config, 'hello', 'text', false)
  } finally {
    process.stdout.write = original
  }
  expect(output).toBe('denied ok')
  expect(JSON.parse(backend.sessions.get(id)!.writes[1]).response.response.behavior).toBe('deny')
})

test('headless supports text, json and stream-json output formats', async () => {
  const { token, serverUrl } = await setup()
  for (const format of ['text', 'json', 'stream-json']) {
    const { config } = await createDirectConnectSession({ serverUrl, authToken: token, cwd: workspace })
    const id = config.sessionId
    backend.sessions.get(id)!.write = value => {
      backend.sessions.get(id)!.writes.push(value)
      if (JSON.parse(value).type !== 'user') return
      backend.emit(id, { type: 'assistant', message: { content: [{ type: 'text', text: `format-${format}` }] } })
      backend.emit(id, { type: 'result', subtype: 'success', is_error: false, result: 'done' })
    }
    let output = ''
    const original = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += chunk.toString()
      return true
    }) as typeof process.stdout.write
    try {
      await runConnectHeadless(config, 'hello', format, false)
    } finally {
      process.stdout.write = original
    }
    if (format === 'text') expect(output).toBe('format-text')
    if (format === 'json') {
      const lines = output.trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({ type: 'result', result: 'done' })
    }
    if (format === 'stream-json') {
      const lines = output.trim().split('\n').map(line => JSON.parse(line))
      expect(lines.map(message => message.type)).toEqual(['assistant', 'result'])
    }
  }
})

test('Unix socket has private permissions and works with the real client transport', async () => {
  const unix = join(temp, 'private', 'server.sock')
  await mkdir(join(temp, 'private'), { recursive: true })
  const { token, serverUrl } = await setup({ unix })
  const { config } = await createDirectConnectSession({ serverUrl, authToken: token, cwd: workspace })
  expect(config.wsUrl).toBe(`ws://unix/sessions/${config.sessionId}/ws`)
  expect((await stat(unix)).mode & 0o777).toBe(0o600)
  expect((await stat(join(temp, 'private'))).mode & 0o777).toBe(0o700)
  const socket = new WsInbox(config.wsUrl, token, unix)
  await socket.opened
  expect(await socket.next(0)).toMatchObject({ subtype: 'ready' })
  socket.close()
})

test('event rotation advertises replay reset instead of hiding gaps', async () => {
  const { token, serverUrl } = await setup({ eventLogLimitBytes: 240 })
  const created = await (await post(serverUrl, token, { cwd: workspace })).json()
  for (let index = 0; index < 10; index++) {
    backend.emit(created.session_id, { type: 'system', subtype: 'tick', index })
  }
  await new Promise(resolve => setTimeout(resolve, 100))
  const socket = new WsInbox(created.ws_url, token)
  await socket.opened
  const ready = await socket.next(0)
  expect(ready.replay_reset).toBe(true)
  expect(ready.last_seq).toBe(10)
  socket.close()
})

test('idempotency records survive a server restart without another spawn', async () => {
  const { token, serverUrl } = await setup()
  const request = { cwd: workspace, client_request_id: crypto.randomUUID() }
  const created = await (await post(serverUrl, token, request)).json()
  server?.stop(true)
  await manager?.destroyAll()
  const restarted = await setup()
  const replayed = await post(restarted.serverUrl, token, request)
  expect(replayed.status).toBe(200)
  expect((await replayed.json()).session_id).toBe(created.session_id)
  expect(backend.creates).toHaveLength(1)
})

test('lockfile validates live health and removes only stale identity', async () => {
  const { serverUrl } = await setup()
  const token = 'test-secret'
  const processStartToken = await getProcessStartToken(process.pid)
  await writeServerLock({
    pid: process.pid,
    processStartToken,
    port: server!.port!,
    host: '127.0.0.1',
    httpUrl: serverUrl,
    startedAt: Date.now(),
  })
  expect(await probeRunningServer()).toMatchObject({ pid: process.pid, httpUrl: serverUrl })
  const lock = await readFile(join(configDir, 'server.lock'), 'utf8')
  expect(lock).not.toContain(token)
  await removeServerLock()
  expect(await probeRunningServer()).toBeNull()
  await writeFile(join(configDir, 'server.lock'), JSON.stringify({
    version: 'direct-connect-v1', pid: 999_999, processStartToken: 'stale',
    port: 1, host: '127.0.0.1', httpUrl: 'http://127.0.0.1:1', startedAt: 1,
  }), { mode: 0o600 })
  expect(await probeRunningServer()).toBeNull()
})

test('process backends keep argv structured and require both dangerous opt-ins', async () => {
  const script = join(temp, 'child.cjs')
  const argsPath = join(temp, 'args.json')
  await writeFile(script, `require('fs').writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2))); process.stdin.resume()`)
  const normal = new ProcessBackend({ executable: process.execPath, executableArgs: [script], stopTimeoutMs: 50 })
  const created = await normal.create({ sessionId: crypto.randomUUID(), cwd: workspace, permissionMode: 'default' })
  await expect(normal.create({ sessionId: crypto.randomUUID(), cwd: workspace, permissionMode: 'bypassPermissions' })).rejects.toThrow('disabled')
  await new Promise(resolve => setTimeout(resolve, 50))
  const args = JSON.parse(await readFile(argsPath, 'utf8'))
  expect(args).toContain('--input-format')
  expect(args).not.toContain('--dangerously-skip-permissions')
  await created.stop()
  const dangerous = new DangerousBackend({
    executable: process.execPath, executableArgs: [script], stopTimeoutMs: 50,
    allowDangerousSkipPermissions: true,
  })
  const bypass = await dangerous.create({ sessionId: crypto.randomUUID(), cwd: workspace, permissionMode: 'bypassPermissions' })
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(JSON.parse(await readFile(argsPath, 'utf8'))).toContain('--dangerously-skip-permissions')
  await bypass.stop()
})
