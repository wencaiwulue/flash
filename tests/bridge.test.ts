import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import {
  createBridgeApiClient,
} from '../src/bridge/bridgeApi.ts'
import { createTokenRefreshScheduler } from '../src/bridge/jwtUtils.ts'
import {
  clearBridgePointer,
  getBridgePointerPath,
  readBridgePointer,
  readBridgePointerAcrossWorktrees,
  writeBridgePointer,
} from '../src/bridge/bridgePointer.ts'
import { createCapacityWake } from '../src/bridge/capacityWake.ts'
import { getClaudeConfigHomeDir } from '../src/utils/envUtils.ts'

let tempDir: string
let previousConfig: string | undefined
let httpServer: Server | undefined

beforeEach(async () => {
  previousConfig = process.env.CLAUDE_CONFIG_DIR
  tempDir = await mkdtemp(join(tmpdir(), 'flash-bridge-'))
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  getClaudeConfigHomeDir.cache.clear()
})

afterEach(async () => {
  httpServer?.closeAllConnections()
  httpServer?.close()
  httpServer = undefined
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  getClaudeConfigHomeDir.cache.clear()
  await rm(tempDir, { recursive: true, force: true })
})

function jwt(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url')
  return `head.${payload}.signature`
}

describe('bridge offline contracts', () => {
  test('permission response times out without hanging or leaking the HTTP server', async () => {
    httpServer = createServer((_req, res) => {
      setTimeout(() => res.end('{}'), 11_000)
    })
    await new Promise<void>(resolve => httpServer!.listen(0, '127.0.0.1', resolve))
    const address = httpServer.address()
    if (!address || typeof address === 'string') throw new Error('missing test port')
    const client = createBridgeApiClient({ baseUrl: `http://127.0.0.1:${address.port}` } as any)
    const started = Date.now()

    await expect(client.sendPermissionResponseEvent(
      'session-1',
      { type: 'permission_response', request_id: 'req-1', response: { behavior: 'allow' } } as any,
      'test-session-token',
    )).rejects.toThrow()

    expect(Date.now() - started).toBeLessThan(12_000)
  }, 15000)

  test('token refresh ignores stale generation and refreshes only the latest token', async () => {
    let resolveFirst!: (value: string) => void
    let resolveSecond!: (value: string) => void
    const first = new Promise<string>(resolve => { resolveFirst = resolve })
    const second = new Promise<string>(resolve => { resolveSecond = resolve })
    const refreshed: Array<{ sessionId: string; token: string }> = []
    const scheduler = createTokenRefreshScheduler({
      getAccessToken: (() => {
        let call = 0
        return () => call++ === 0 ? first : second
      })(),
      onRefresh: (sessionId, token) => { refreshed.push({ sessionId, token }) },
      label: 'offline-test',
      refreshBufferMs: 0,
    })

    scheduler.schedule('session-a', jwt(Math.floor(Date.now() / 1000)))
    scheduler.schedule('session-a', jwt(Math.floor(Date.now() / 1000) + 60))
    resolveFirst('stale-token')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(refreshed).toEqual([])

    scheduler.schedule('session-a', jwt(Math.floor(Date.now() / 1000)))
    resolveSecond('latest-token')
    await new Promise(resolve => setTimeout(resolve, 50))
    scheduler.cancelAll()

    expect(refreshed).toEqual([{ sessionId: 'session-a', token: 'latest-token' }])
  })

  test('capacity wake resets the merged signal and propagates outer cancellation', () => {
    const outer = new AbortController()
    const wake = createCapacityWake(outer.signal)
    const first = wake.signal()
    expect(first.signal.aborted).toBe(false)

    wake.wake()
    expect(first.signal.aborted).toBe(true)
    const second = wake.signal()
    expect(second.signal.aborted).toBe(false)
    outer.abort()
    expect(second.signal.aborted).toBe(true)
    first.cleanup()
    second.cleanup()
  })

  test('bridge pointer rejects stale and corrupt files and clears them', async () => {
    const dir = join(tempDir, 'project')
    const path = getBridgePointerPath(dir)
    await writeBridgePointer(dir, {
      sessionId: 'session-1',
      environmentId: 'env-1',
      source: 'standalone',
    })
    expect((await readBridgePointer(dir))?.sessionId).toBe('session-1')

    await writeFile(path, '{"broken":')
    expect(await readBridgePointer(dir)).toBeNull()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })

    await writeBridgePointer(dir, {
      sessionId: 'session-2',
      environmentId: 'env-2',
      source: 'repl',
    })
    const old = new Date(Date.now() - 5 * 60 * 60 * 1000)
    await utimes(path, old, old)
    expect(await readBridgePointer(dir)).toBeNull()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await clearBridgePointer(dir)
  })

  test('worktree fanout returns the freshest pointer with its owning directory', async () => {
    const main = join(tempDir, 'main')
    const sibling = join(tempDir, 'sibling')
    const run = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' })
    await (await import('fs/promises')).mkdir(main, { recursive: true })
    run(main, ['init'])
    run(main, ['config', 'user.email', 'offline@example.test'])
    run(main, ['config', 'user.name', 'Offline Test'])
    run(main, ['commit', '--allow-empty', '-m', 'init'])
    run(main, ['worktree', 'add', sibling])

    await writeBridgePointer(sibling, {
      sessionId: 'worktree-session',
      environmentId: 'worktree-env',
      source: 'repl',
    })

    const { realpath } = await import('fs/promises')
    const result = await readBridgePointerAcrossWorktrees(main)
    expect(result).not.toBeNull()
    expect(await realpath(result!.dir)).toBe(await realpath(sibling))
    expect(result?.pointer.sessionId).toBe('worktree-session')
  })
})
