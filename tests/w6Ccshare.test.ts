import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFile } from 'child_process'
import { createServer, type Server } from 'https'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execute = promisify(execFile)
let root = ''
let first: Server
let second: Server
let firstOrigin = ''
let secondOrigin = ''
let certificate = ''
const authorization = new Map<string, string | undefined>()
const sockets = new Set<import('net').Socket>()

const id = '11111111-1111-4111-8111-111111111111'
const entry = {
  type: 'user',
  uuid: id,
  parentUuid: null,
  timestamp: '2026-01-02T03:04:05.000Z',
  sessionId: id,
  cwd: '/untrusted/remote/path',
  userType: 'external',
  version: '1.0.0',
  message: { role: 'user', content: 'transcript fixture; fake hooks must not execute' },
}
const goodBody = `${JSON.stringify(entry)}\n${JSON.stringify({ type: 'hook', command: 'touch /tmp/should-not-run' })}\n`

function listen(server: Server): Promise<number> {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as import('net').AddressInfo).port)
    })
  })
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'w6-ccshare-'))
  certificate = join(root, 'certificate.pem')
  const key = join(root, 'key.pem')
  await execute('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', certificate, '-days', '1',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ])
  const [cert, privateKey] = await Promise.all([
    readFile(certificate, 'utf8'),
    readFile(key, 'utf8'),
  ])
  const handler = (label: string) => (request: import('http').IncomingMessage, response: import('http').ServerResponse) => {
    const path = request.url ?? ''
    authorization.set(`${label}${path}`, request.headers.authorization)
    if (path.endsWith('/good') || path.endsWith('/redirect-target')) {
      response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' })
      response.end(goodBody)
    } else if (path.endsWith('/badtype')) {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(goodBody)
    } else if (path.endsWith('/badjson')) {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      response.end('not-json\n')
    } else if (path.endsWith('/large')) {
      response.writeHead(200, { 'content-type': 'application/jsonl' })
      response.end('x'.repeat(256))
    } else if (path.endsWith('/lines')) {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      response.end(`${JSON.stringify(entry)}\n${JSON.stringify(entry)}\n`)
    } else if (path.endsWith('/redirect')) {
      response.writeHead(302, { location: '/ccshare/redirect-target' })
      response.end()
    } else if (path.endsWith('/cross') || path.endsWith('/cross-denied')) {
      response.writeHead(302, { location: `${secondOrigin}/ccshare/good` })
      response.end()
    } else if (path.endsWith('/slow')) {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      response.write('')
    } else {
      response.writeHead(404, { 'content-type': 'application/x-ndjson' })
      response.end()
    }
  }
  first = createServer({ cert, key: privateKey }, handler('first:'))
  second = createServer({ cert, key: privateKey }, handler('second:'))
  for (const server of [first, second]) {
    server.on('connection', socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
  }
  firstOrigin = `https://127.0.0.1:${await listen(first)}`
  secondOrigin = `https://127.0.0.1:${await listen(second)}`
})

afterAll(async () => {
  for (const socket of sockets) socket.destroy()
  await Promise.all([
    new Promise<void>(resolve => first.close(() => resolve())),
    new Promise<void>(resolve => second.close(() => resolve())),
  ])
  await rm(root, { recursive: true, force: true })
})

describe('ccshare local HTTPS resume', () => {
  test('downloads real transcripts with bounds, redirect auth rules and cleanup', async () => {
    const config = join(root, 'config')
    const script = join(root, 'fixture.ts')
    const credential = join(root, 'credential.json')
    await writeFile(credential, JSON.stringify({ token: 'local-secret' }), { mode: 0o600 })
    await writeFile(script, `
      import assert from 'node:assert/strict'
      import { readdir, unlink } from 'node:fs/promises'
      import { join } from 'node:path'
      import { loadCcshare, parseCcshareId } from ${JSON.stringify(join(process.cwd(), 'src/utils/ccshareResume.ts'))}
      const origin = process.env.CLAUDE_CODE_CCSHARE_ORIGIN
      const tmp = join(process.env.CLAUDE_CONFIG_DIR, 'tmp')
      assert.equal(parseCcshareId(origin + '/ccshare/good'), 'good')
      assert.equal(parseCcshareId(origin + '/ccshare/good?x=1'), null)
      assert.equal(parseCcshareId(origin + '/ccshare/..'), null)
      assert.equal(parseCcshareId('https://go/ccshare/good'), null)
      assert.equal(parseCcshareId(origin.replace('https:', 'http:') + '/ccshare/good'), null)
      const clean = async log => { await unlink(log.fullPath) }
      const count = async () => (await readdir(tmp)).length
      const log = await loadCcshare('good')
      assert.equal(log.messageCount, 1)
      assert.equal(log.created.toISOString(), '2026-01-02T03:04:05.000Z')
      assert.equal(log.modified.toISOString(), '2026-01-02T03:04:05.000Z')
      assert.equal(log.projectPath, undefined)
      assert.match(log.fullPath, /ccshare-[a-f0-9]+\\.jsonl$/)
      await clean(log)
      await assert.rejects(loadCcshare('badtype'), /content type/)
      await assert.rejects(loadCcshare('badjson'), /No messages/)
      await assert.rejects(loadCcshare('large', { maxBytes: 32 }), /exceeds 32 bytes/)
      await assert.rejects(loadCcshare('lines', { maxLines: 1 }), /exceeds 1 lines/)
      await assert.rejects(loadCcshare('missing'), /HTTP 404/)
      assert.equal(await count(), 0)
      const redirected = await loadCcshare('redirect')
      await clean(redirected)
      const cross = await loadCcshare('cross', { confirmCrossOrigin: async () => true })
      await clean(cross)
      await assert.rejects(loadCcshare('cross-denied', { confirmCrossOrigin: async () => false }), /not confirmed/)
      await assert.rejects(loadCcshare('slow', { timeoutMs: 50 }), /timed out/)
      assert.equal(await count(), 0)
      await assert.rejects(loadCcshare('../bad'), /Invalid ccshare id/)
      console.log('fixture assertions passed')
    `)
    const child = Bun.spawn([process.execPath, script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: certificate,
        CLAUDE_CONFIG_DIR: config,
        CLAUDE_CODE_CCSHARE_ORIGIN: firstOrigin,
        CLAUDE_CODE_CCSHARE_TOKEN_FILE: credential,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(stderr).toBe('')
    expect(stdout).toContain('fixture assertions passed')
    expect(exitCode).toBe(0)
    expect(authorization.get('first:/ccshare/good')).toBe('Bearer local-secret')
    expect(authorization.get('first:/ccshare/redirect-target')).toBe('Bearer local-secret')
    expect(authorization.get('first:/ccshare/cross')).toBe('Bearer local-secret')
    expect(authorization.get('second:/ccshare/good')).toBeUndefined()
  }, 30_000)
})
