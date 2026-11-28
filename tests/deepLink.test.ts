import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const moduleIsolationRoot = mkdtempSync(join(tmpdir(), 'deep-link-'))
const originalHome = process.env.HOME
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalXdgDataHome = process.env.XDG_DATA_HOME
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
process.env.HOME = join(moduleIsolationRoot, 'home')
process.env.CLAUDE_CONFIG_DIR = join(moduleIsolationRoot, 'config')

const execCalls: Array<{ file: string; args: string[] }> = []
const actualExec = await import('../src/utils/execFileNoThrow.ts')
mock.module('../src/utils/execFileNoThrow.ts', () => ({
  ...actualExec,
  execFileNoThrow: async (file: string, args: string[]) => {
    execCalls.push({ file, args })
    return { code: 0, stdout: '', stderr: '' }
  },
}))
mock.module('../src/utils/githubRepoPathMapping.ts', () => ({
  getKnownPathsForRepo: () => ['/tmp/offline-repo'],
  filterExistingPaths: async (paths: string[]) => paths,
}))
mock.module('../src/utils/deepLink/banner.ts', () => ({
  readLastFetchTime: async () => new Date(123),
}))
const terminalLaunches: Array<{ path: string; action: Record<string, unknown> }> = []
const actualConfig = await import('../src/utils/config.ts')
mock.module('../src/utils/config.ts', () => ({
  ...actualConfig,
  getGlobalConfig: () => ({ deepLinkTerminal: 'Ghostty' }),
}))
const actualLauncher = await import('../src/utils/deepLink/terminalLauncher.ts')
const productionLaunchInTerminal = actualLauncher.launchInTerminal
mock.module('../src/utils/deepLink/terminalLauncher.ts', () => ({
  launchInTerminal: async (path: string, action: Record<string, unknown>) => {
    terminalLaunches.push({ path, action })
    return true
  },
}))

const { parseDeepLink, buildDeepLink } = await import('../src/utils/deepLink/parseDeepLink.ts')
const { handleDeepLinkUri } = await import('../src/utils/deepLink/protocolHandler.ts')
process.env.XDG_DATA_HOME = join(moduleIsolationRoot, 'xdg')
mock.module('../src/utils/which.ts', () => ({
  which: async () => undefined,
}))
const { registerProtocolHandler, isProtocolHandlerCurrent } = await import(
  '../src/utils/deepLink/registerProtocol.ts'
)

let tempRoot = ''

beforeEach(() => {
  process.env.HOME = join(moduleIsolationRoot, 'home')
  process.env.CLAUDE_CONFIG_DIR = join(moduleIsolationRoot, 'config')
  process.env.XDG_DATA_HOME = join(moduleIsolationRoot, 'xdg')
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'deep-link-test-')))
  execCalls.length = 0
  terminalLaunches.length = 0
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgDataHome
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originalXdgDataHome
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  rmSync(moduleIsolationRoot, { recursive: true, force: true })
})

describe('deep link parser', () => {
  test('parses and round-trips q/cwd/repo with Unicode preserved', () => {
    const action = parseDeepLink('claude-cli://open?q=fix+测试&cwd=/tmp/project&repo=owner/repo')
    expect(action).toEqual({ query: 'fix 测试', cwd: '/tmp/project', repo: 'owner/repo' })
    expect(parseDeepLink(buildDeepLink(action))).toEqual(action)
  })

  test('rejects malformed actions, relative cwd, invalid repos and control characters', () => {
    expect(() => parseDeepLink('https://example.com')).toThrow('expected claude-cli:// scheme')
    expect(() => parseDeepLink('claude-cli://other')).toThrow('Unknown deep link action')
    expect(() => parseDeepLink('claude-cli://open?cwd=relative')).toThrow('must be an absolute path')
    expect(() => parseDeepLink('claude-cli://open?repo=not-a-repo')).toThrow('Invalid repo')
    expect(() => parseDeepLink('claude-cli://open?q=bad%0Acommand')).toThrow('control characters')
    expect(() => parseDeepLink(`claude-cli://open?q=${'a'.repeat(5001)}`)).toThrow('exceeds 5000 characters')
  })
})

describe('deep link protocol handling', () => {
  test('resolves repo and last fetch before launching the current executable', async () => {
    const exit = await handleDeepLinkUri('claude-cli://open?q=hello&repo=owner/repo')
    expect(exit).toBe(0)
    expect(terminalLaunches).toHaveLength(1)
    expect(terminalLaunches[0]).toMatchObject({
      path: process.execPath,
      action: {
        query: 'hello',
        cwd: '/tmp/offline-repo',
        repo: 'owner/repo',
        lastFetchMs: 123,
      },
    })
  })

  test('returns failure for invalid links without launching', async () => {
    expect(await handleDeepLinkUri('https://example.com')).toBe(1)
    expect(terminalLaunches).toHaveLength(0)
  })
})

describe('terminal launch argv and registration artifacts', () => {
  test('passes query, repo and fetch metadata as distinct argv entries without a shell', async () => {
    const launched = await productionLaunchInTerminal('/tmp/flash-binary', {
      query: 'q; rm -rf /tmp/should-not-run',
      cwd: '/tmp/work dir',
      repo: 'owner/repo',
      lastFetchMs: 123,
    })
    expect(launched).toBe(true)
    const open = execCalls.find(call => call.file === 'open')
    expect(open).toBeDefined()
    expect(open!.args).toContain('/tmp/flash-binary')
    expect(open!.args).toContain('q; rm -rf /tmp/should-not-run')
    expect(open!.args).toContain('--deep-link-repo')
    expect(open!.args).toContain('--deep-link-last-fetch')
    expect(open!.args).toContain('123')
    expect(open!.args).toContain('--working-directory=/tmp/work dir')
  })

  test('writes and validates a Linux desktop handler without invoking xdg-mime', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const binary = '/tmp/flash-binary'
    await registerProtocolHandler(binary)
    expect(await isProtocolHandlerCurrent(binary)).toBe(true)
    expect(await isProtocolHandlerCurrent('/tmp/other-binary')).toBe(false)

    const desktop = readFileSync(join(moduleIsolationRoot, 'xdg', 'applications', 'claude-code-url-handler.desktop'), 'utf8')
    expect(desktop).toContain('x-scheme-handler/claude-cli')
    expect(desktop).toContain(`Exec="${binary}" --handle-uri %u`)
    expect(execCalls).toHaveLength(0)
  })
})
