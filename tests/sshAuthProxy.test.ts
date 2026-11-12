import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { appendFile, mkdtemp, readFile, rm, unlink, writeFile } from 'fs/promises'
import http, { type IncomingMessage } from 'http'
import net from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { OAUTH_BETA_HEADER } from '../src/constants/oauth.ts'
import { createLocalSSHSession } from '../src/ssh/createSSHSession.ts'
import { createSSHAuthProxy, type SSHResolvedAuth } from '../src/ssh/sshAuthProxy.ts'
import { withoutSSHTunnelVars } from '../src/utils/managedEnv.ts'

const PROXY_ENV_KEYS = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'no_proxy'] as const
const originalProxyEnv = new Map<string, string | undefined>(
  PROXY_ENV_KEYS.map(key => [key, process.env[key]]),
)

let root: string
let upstream: http.Server
let upstreamPort: number
let upstreamRequests: Array<{
  method?: string
  url?: string
  headers: IncomingMessage['headers']
  body: string
}>

beforeAll(async () => {
  for (const key of PROXY_ENV_KEYS) delete process.env[key]
  process.env.NO_PROXY = '*'
  process.env.no_proxy = '*'
  root = await mkdtemp(join(tmpdir(), 'claude-ssh-proxy-'))
  upstreamRequests = []
  upstream = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      upstreamRequests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      response.writeHead(200, {
        'content-type': 'text/plain',
        connection: 'x-remove-me',
        'x-remove-me': 'must not escape',
      })
      response.write('stream-')
      setTimeout(() => response.end('response'), 5)
    })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  upstreamPort = (upstream.address() as net.AddressInfo).port
})

afterAll(async () => {
  for (const key of PROXY_ENV_KEYS) {
    const value = originalProxyEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await new Promise<void>(resolve => upstream.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
})

function socketPath(name: string): string {
  return join(root, `${name}-${crypto.randomUUID().slice(0, 8)}.sock`)
}

async function startProxy(name: string, auth: SSHResolvedAuth, onResolve?: () => void) {
  const proxy = createSSHAuthProxy({
    socketPath: socketPath(name),
    resolveAuth: async () => {
      onResolve?.()
      return auth
    },
    upstream: { protocol: 'http:', hostname: '127.0.0.1', port: upstreamPort },
  })
  await proxy.ready
  return proxy
}

async function request(options: {
  path: string
  socketPath: string
  method?: string
  headers?: Record<string, string>
  body?: string
}) {
  return new Promise<{ status: number | undefined; headers: IncomingMessage['headers']; body: string }>(
    (resolve, reject) => {
      const req = http.request(
        {
          socketPath: options.socketPath,
          path: options.path,
          method: options.method ?? 'POST',
          headers: options.headers,
        },
        response => {
          const chunks: Buffer[] = []
          response.on('data', chunk => chunks.push(Buffer.from(chunk)))
          response.on('end', () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          )
        },
      )
      req.on('error', reject)
      if (options.body) {
        req.write(options.body.slice(0, 3))
        req.end(options.body.slice(3))
      } else req.end()
    },
  )
}

async function rawRequest(path: string, requestText: string): Promise<string> {
  const socket = net.createConnection(path)
  await new Promise<void>(resolve => socket.once('connect', resolve))
  socket.write(requestText)
  return new Promise<string>(resolve => {
    let value = ''
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(value)
    }, 2_000)
    socket.on('data', chunk => (value += chunk.toString()))
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(value)
    })
    socket.on('error', () => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

const authCases: Array<{
  name: string
  auth: SSHResolvedAuth
  expected: (headers: IncomingMessage['headers']) => void
}> = [
  {
    name: 'API key',
    auth: { kind: 'apiKey', headers: { 'x-api-key': 'local-api-secret' } },
    expected: headers => {
      expect(headers['x-api-key']).toBe('local-api-secret')
      expect(headers.authorization).toBeUndefined()
    },
  },
  {
    name: 'bearer',
    auth: { kind: 'bearer', headers: { Authorization: 'Bearer local-bearer-secret' } },
    expected: headers => {
      expect(headers.authorization).toBe('Bearer local-bearer-secret')
      expect(headers['x-api-key']).toBeUndefined()
    },
  },
  {
    name: 'OAuth',
    auth: {
      kind: 'oauth',
      headers: { Authorization: 'Bearer local-oauth-secret', 'anthropic-beta': OAUTH_BETA_HEADER },
    },
    expected: headers => {
      expect(headers.authorization).toBe('Bearer local-oauth-secret')
      expect(headers['anthropic-beta']).toContain(OAUTH_BETA_HEADER)
      expect(headers['anthropic-beta']).toContain('tools-2025-01-01')
    },
  },
]

describe('real local SSH auth proxy', () => {
  for (const authCase of authCases) {
    test(`injects ${authCase.name}, strips placeholders, fixes Host, and streams chunked bodies`, async () => {
      upstreamRequests = []
      let resolutions = 0
      const proxy = await startProxy('auth', authCase.auth, () => resolutions++)
      const response = await request({
        socketPath: proxy.socketPath,
        path: '/v1/messages?model=test',
        headers: {
          authorization: 'Bearer ssh-remote-placeholder',
          'x-api-key': 'ssh-api-key-placeholder',
          cookie: 'secret=cookie',
          'proxy-authorization': 'proxy-secret',
          'anthropic-beta': 'tools-2025-01-01',
          connection: 'x-hop-by-hop',
          'x-hop-by-hop': 'remove',
        },
        body: 'chunked-request-body',
      })
      expect(response.status).toBe(200)
      expect(response.body).toBe('stream-response')
      expect(response.headers['x-remove-me']).toBeUndefined()
      expect(upstreamRequests).toHaveLength(1)
      const seen = upstreamRequests[0]!
      expect(seen.url).toBe('/v1/messages?model=test')
      expect(seen.body).toBe('chunked-request-body')
      expect(seen.headers.host).toBe('api.anthropic.com')
      expect(seen.headers.cookie).toBeUndefined()
      expect(seen.headers['proxy-authorization']).toBeUndefined()
      expect(seen.headers['x-hop-by-hop']).toBeUndefined()
      authCase.expected(seen.headers)
      expect(resolutions).toBe(1)
      proxy.stop()
      proxy.stop()
      await proxy.stopped
      expect(existsSync(proxy.socketPath)).toBe(false)
    })
  }

  test('rejects non-/v1/, absolute-form, TRACE, and oversized headers before auth or upstream', async () => {
    upstreamRequests = []
    let resolutions = 0
    const proxy = await startProxy('protocol', authCases[0]!.auth, () => resolutions++)
    for (const path of ['/v2/messages', '/v1']) {
      const response = await request({ socketPath: proxy.socketPath, path })
      expect(response.status).toBe(403)
    }
    const absolute = await rawRequest(
      proxy.socketPath,
      'POST http://attacker.invalid/v1/messages HTTP/1.1\r\nHost: attacker.invalid\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    )
    expect(absolute).toContain('403')
    const trace = await request({ socketPath: proxy.socketPath, path: '/v1/messages', method: 'TRACE' })
    expect(trace.status).toBe(403)
    const rawResponse = await rawRequest(
      proxy.socketPath,
      `POST /v1/messages HTTP/1.1\r\nHost: attacker\r\nX-Large: ${'a'.repeat(70 * 1024)}\r\nConnection: close\r\n\r\n`,
    )
    // Bun may abort oversized headers at the parser before clientError can
    // write a 400. Either a 400 or an immediate close is a valid rejection.
    if (rawResponse) expect(rawResponse).toContain('400')
    expect(resolutions).toBe(0)
    expect(upstreamRequests).toHaveLength(0)
    proxy.stop()
    await proxy.stopped
  })

  test('does not unlink a socket path replaced by another instance', async () => {
    const proxy = await startProxy('identity', authCases[0]!.auth)
    const path = proxy.socketPath
    await unlink(path)
    const replacement = net.createServer()
    await new Promise<void>((resolve, reject) => {
      replacement.once('error', reject)
      replacement.listen(path, () => resolve())
    })
    proxy.stop()
    await proxy.stopped
    expect(existsSync(path)).toBe(true)
    await new Promise<void>(resolve => replacement.close(() => resolve()))
  })

  test('settings.env cannot override SSH tunnel routing or placeholders', () => {
    const previous = process.env.ANTHROPIC_UNIX_SOCKET
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/authorized-ssh.sock'
    try {
      expect(
        withoutSSHTunnelVars({
          ANTHROPIC_UNIX_SOCKET: '/tmp/attacker.sock',
          ANTHROPIC_BASE_URL: 'https://attacker.invalid',
          ANTHROPIC_API_KEY: 'attacker-key',
          ANTHROPIC_AUTH_TOKEN: 'attacker-token',
          CLAUDE_CODE_OAUTH_TOKEN: 'attacker-oauth',
          EDITOR: 'allowed-setting',
        }),
      ).toEqual({ EDITOR: 'allowed-setting' })
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_UNIX_SOCKET
      else process.env.ANTHROPIC_UNIX_SOCKET = previous
    }
  })

  test('--local spawns the real CLI path with placeholders and uses the same authenticated proxy', async () => {
    upstreamRequests = []
    const fixture = join(root, 'local-cli.ts')
    const envLog = join(root, 'local-env.json')
    await writeFile(
      fixture,
      `import {appendFileSync} from 'fs'
appendFileSync(process.env.LOCAL_ENV_LOG!, JSON.stringify({argv:process.argv.slice(2),env:{ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY,ANTHROPIC_AUTH_TOKEN:process.env.ANTHROPIC_AUTH_TOKEN,CLAUDE_CODE_OAUTH_TOKEN:process.env.CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_BASE_URL:process.env.ANTHROPIC_BASE_URL,ANTHROPIC_UNIX_SOCKET:process.env.ANTHROPIC_UNIX_SOCKET}}) + '\\n')
const response = await fetch(process.env.ANTHROPIC_BASE_URL! + '/v1/local',{unix:process.env.ANTHROPIC_UNIX_SOCKET,method:'POST',headers:{'x-api-key':process.env.ANTHROPIC_API_KEY!},body:'local-real-request'} as RequestInit & {unix:string})
await response.text()
process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'22222222-2222-4222-8222-222222222222'}) + '\\n')
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk.toString()
  if (buffer.includes('end_session')) process.exit(0)
  if (buffer.includes('"type":"user"')) process.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:'22222222-2222-4222-8222-222222222222',result:'ok'}) + '\\n')
})
`,
    )
    const session = await createLocalSSHSession({
      cwd: root,
      dangerouslySkipPermissions: false,
      executablePath: process.execPath,
      cliPath: fixture,
      socketDirectory: '/tmp',
      environment: {
        ...process.env,
        LOCAL_ENV_LOG: envLog,
        ANTHROPIC_API_KEY: 'real-api-key-never-in-child',
        ANTHROPIC_AUTH_TOKEN: 'real-bearer-never-in-child',
        CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-never-in-child',
      },
      authProxy: {
        resolveAuth: async () => ({
          kind: 'apiKey',
          headers: { 'x-api-key': 'local-only-real-api-key' },
        }),
        upstream: { protocol: 'http:', hostname: '127.0.0.1', port: upstreamPort },
      },
    })
    const connected = Promise.withResolvers<void>()
    const disconnected = Promise.withResolvers<void>()
    const messages: unknown[] = []
    const manager = session.createManager({
      onMessage: message => messages.push(message),
      onPermissionRequest: () => {},
      onConnected: () => connected.resolve(),
      onReconnecting: () => {},
      onDisconnected: () => disconnected.resolve(),
      onError: error => {
        throw error
      },
    })
    manager.connect()
    await connected.promise
    expect(await manager.sendMessage('two real local turns')).toBe(true)
    const deadline = Date.now() + 2_000
    while (!messages.some(message => (message as { type: string }).type === 'result')) {
      if (Date.now() > deadline) throw new Error('Local fixture did not answer user input')
      await Bun.sleep(5)
    }
    const child = JSON.parse(await readFile(envLog, 'utf8'))
    expect(child.argv).toContain('--input-format')
    expect(child.argv).toContain('stream-json')
    expect(child.env.ANTHROPIC_API_KEY).toBe('ssh-api-key-placeholder')
    expect(child.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(child.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(child.env.ANTHROPIC_BASE_URL).toBe('http://api.anthropic.com')
    expect(JSON.stringify(child)).not.toContain('never-in-child')
    expect(upstreamRequests.at(-1)!.headers['x-api-key']).toBe('local-only-real-api-key')
    expect(upstreamRequests.at(-1)!.body).toBe('local-real-request')
    manager.disconnect()
    await disconnected.promise
    session.proxy.stop()
    const socketDeadline = Date.now() + 2_000
    while (existsSync(child.env.ANTHROPIC_UNIX_SOCKET)) {
      if (Date.now() > socketDeadline) throw new Error('Local socket was not removed')
      await Bun.sleep(5)
    }
    expect(existsSync(child.env.ANTHROPIC_UNIX_SOCKET)).toBe(false)
  })
})
