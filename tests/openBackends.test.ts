import { afterEach, describe, expect, test } from 'bun:test'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { createServer, type Server } from 'http'
import { createServer as createNetServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { chromium } from 'playwright'
import treeKill from 'tree-kill'
import {
  assertLoopbackCdpEndpoint,
  callOpenChromeTool,
  closeOpenBrowserClient,
  closeOpenChromeClient,
  createIsolatedBrowserConfig,
  createOpenChromeConfig,
  getOpenBrowserClient,
  getOpenChromeClient,
  listBrowserTools,
  listOpenChromeTools,
  type OpenChromeContext,
} from '../src/external-stubs/claude-for-chrome-mcp.ts'
import {
  bindZavoraSessionContext,
  closeOpenComputerUseClient,
  listOpenComputerUseTools,
} from '../src/external-stubs/computer-use-mcp.ts'
import {
  clearServerCache,
  connectToServer,
  fetchToolsForClient,
} from '../src/services/mcp/client.ts'
import type { ScopedMcpServerConfig } from '../src/services/mcp/types.ts'
import { WebBrowserTool } from '../src/tools/WebBrowserTool/WebBrowserTool.ts'
import { createChromeContext } from '../src/utils/claudeInChrome/mcpServer.ts'
import type { ToolUseContext } from '../src/Tool.ts'

let server: Server | undefined
let baseUrl = ''
let fakeChild: ChildProcess | undefined
let fakeProfile: string | undefined
let chromeMcpConfig: ScopedMcpServerConfig | undefined

const execFileAsync = promisify(execFile)
const fakeChildren = new Set<ChildProcess>()

process.on('exit', () => {
  if (process.platform === 'win32') return
  for (const child of fakeChildren) {
    if (!child.pid) continue
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // The owned process group already exited.
    }
  }
})

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function fakeChromeTreeExited(child: ChildProcess): boolean {
  if (process.platform === 'win32') return childHasExited(child)
  const pid = child.pid
  if (!pid) return true
  try {
    process.kill(-pid, 0)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
}

async function waitForChildClose(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fakeChromeTreeExited(child)) return true
    await Bun.sleep(50)
  }
  return fakeChromeTreeExited(child)
}

async function signalFakeChrome(
  child: ChildProcess,
  signal: NodeJS.Signals,
): Promise<void> {
  if (process.platform === 'win32' && childHasExited(child)) return
  const pid = child.pid
  if (!pid) return

  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Fake CDP Chromium ${signal} timed out`)),
        5_000,
      )
      treeKill(pid, signal, error => {
        clearTimeout(timer)
        if (error && !childHasExited(child)) reject(error)
        else resolve()
      })
    })
    return
  }

  try {
    // The detached child is the leader of its own process group. Signal only
    // that owned group so Chromium descendants cannot outlive the fixture.
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function stopFakeChrome(child: ChildProcess): Promise<void> {
  if (!child.pid || (process.platform === 'win32' && childHasExited(child))) {
    fakeChildren.delete(child)
    return
  }
  await signalFakeChrome(child, 'SIGTERM')
  if (await waitForChildClose(child, 5_000)) {
    fakeChildren.delete(child)
    return
  }

  await signalFakeChrome(child, 'SIGKILL')
  if (!(await waitForChildClose(child, 5_000))) {
    throw new Error('Fake CDP Chromium did not close after SIGKILL')
  }
  fakeChildren.delete(child)
}

afterEach(async () => {
  const config = chromeMcpConfig
  const child = fakeChild
  const profile = fakeProfile
  const fixture = server
  chromeMcpConfig = undefined
  fakeChild = undefined
  fakeProfile = undefined
  server = undefined

  const cleanups: Array<() => Promise<unknown>> = []
  if (config) {
    cleanups.push(async () => {
      await clearServerCache('claude-in-chrome', config)
    })
  }
  cleanups.push(
    async () => closeOpenChromeClient(),
    async () => closeOpenBrowserClient(),
    async () => closeOpenComputerUseClient(),
  )
  if (child) cleanups.push(async () => stopFakeChrome(child))
  if (profile) {
    cleanups.push(async () => {
      if (child) await stopFakeChrome(child)
      await rm(profile, { recursive: true, force: true })
    })
  }
  if (fixture) {
    cleanups.push(
      async () =>
        new Promise<void>((resolve, reject) => {
          fixture.close(error => (error ? reject(error) : resolve()))
        }),
    )
  }

  // Preserve cleanup order, but do not let an early failure skip later steps.
  const errors: unknown[] = []
  for (const cleanup of cleanups) {
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Open backend test cleanup failed')
  }
})

async function startFixture(): Promise<void> {
  server = createServer((request, response) => {
    const second = request.url?.startsWith('/second')
    response.setHeader('content-type', 'text/html')
    response.end(
      `<html><title>${second ? 'Second CDP Page' : 'First CDP Page'}</title><main>${second ? 'Second existing content' : 'First existing content'}</main></html>`,
    )
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  baseUrl = `http://127.0.0.1:${address.port}`
}

async function unusedPort(): Promise<number> {
  const listener = createNetServer()
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('No free port')
  const { port } = address
  await new Promise<void>((resolve, reject) =>
    listener.close(error => (error ? reject(error) : resolve())),
  )
  return port
}

async function startFakeChromeCdp(): Promise<{ endpoint: string }> {
  const port = await unusedPort()
  const endpoint = `http://127.0.0.1:${port}`
  fakeProfile = await mkdtemp(join(tmpdir(), 'open-chrome-cdp-test-'))
  const systemChrome =
    process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : process.platform === 'linux'
        ? '/opt/google/chrome/chrome'
        : undefined
  let executable = process.env.CLAUDE_CHROME_TEST_EXECUTABLE
  if (!executable && systemChrome && existsSync(systemChrome)) {
    executable = systemChrome
  }
  if (!executable) {
    // Playwright MCP defaults to the system Chrome channel. Use that same
    // browser on CI instead of assuming its separately downloaded Chromium
    // revision is present; retain the bundled path as the final fallback.
    for (const command of [
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
    ]) {
      executable = Bun.which(command) ?? undefined
      if (executable) break
    }
  }
  executable ??= chromium.executablePath()
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-address=127.0.0.1',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${fakeProfile}`,
      'about:blank',
    ],
    { stdio: 'ignore', detached: process.platform !== 'win32' },
  )
  fakeChild = child
  fakeChildren.add(child)
  let startupError: unknown
  child.once('error', error => {
    startupError = error
  })

  let lastError: unknown
  // The first headless Chrome launch on a hosted Linux runner can be cold.
  for (let attempt = 0; attempt < 400; attempt++) {
    if (startupError) throw startupError
    if (child.exitCode !== null) {
      throw new Error(`Fake CDP Chromium exited with ${child.exitCode}`)
    }
    try {
      const response = await fetch(`${endpoint}/json/version`)
      if (response.ok) {
        lastError = undefined
        break
      }
      lastError = new Error(`Fake CDP Chromium returned HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(50)
  }
  if (lastError) throw lastError

  return { endpoint }
}

type IsolatedBrowserRoot = {
  pid: number
  profile: string
}

function isolatedBrowserRootKey(root: IsolatedBrowserRoot): string {
  return `${root.pid}:${root.profile}`
}

async function snapshotIsolatedBrowserRoots(): Promise<IsolatedBrowserRoot[]> {
  // Windows retains all functional lifecycle assertions below. POSIX process
  // assertions remain mandatory and any ps/query failure fails the test.
  if (process.platform === 'win32') return []
  const { stdout } = await execFileAsync(
    'ps',
    ['-ax', '-o', 'pid=,command='],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  )
  const roots = new Map<number, IsolatedBrowserRoot>()
  for (const line of stdout.split('\n')) {
    const processMatch = line.match(/^\s*(\d+)\s+(.*)$/)
    if (!processMatch) continue
    const command = processMatch[2]!
    if (/(?:^|\s)--type=/.test(command)) continue
    if (!/(?:^|\s)--remote-debugging-pipe(?:\s|$)/.test(command)) continue
    const profile = command.match(
      /(?:^|\s)--user-data-dir=(\S*playwright_chromiumdev_profile-[^\s]*)/,
    )?.[1]
    if (!profile) continue
    const pid = Number(processMatch[1])
    roots.set(pid, { pid, profile })
  }
  return [...roots.values()]
}

async function findNewIsolatedBrowserRoot(
  before: IsolatedBrowserRoot[],
): Promise<IsolatedBrowserRoot | undefined> {
  if (process.platform === 'win32') return undefined
  const existing = new Set(before.map(isolatedBrowserRootKey))
  const created = (await snapshotIsolatedBrowserRoots()).filter(
    root => !existing.has(isolatedBrowserRootKey(root)),
  )
  expect(created).toHaveLength(1)
  return created[0]
}

async function expectIsolatedBrowserRootExited(
  root: IsolatedBrowserRoot | undefined,
): Promise<void> {
  if (!root) return
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const { stdout } = await execFileAsync(
        'ps',
        ['-p', String(root.pid), '-o', 'command='],
        { encoding: 'utf8', timeout: 5_000 },
      )
      if (!stdout.includes(root.profile)) return
    } catch (error) {
      if ((error as { code?: number }).code === 1) return
      throw error
    }
    await Bun.sleep(50)
  }
  throw new Error(
    `Isolated Chrome root ${root.pid} survived for ${root.profile}`,
  )
}

type FakeChromeState = {
  contextCount: number
  pages: Array<{ url: string; title: string }>
  cookies: Array<{ name: string; value: string }>
}

async function runNodeCdp<T>(endpoint: string, body: string): Promise<T> {
  const script = `
import { chromium } from 'playwright'
try {
  const browser = await chromium.connectOverCDP(${JSON.stringify(endpoint)}, { timeout: 10000 })
  const context = browser.contexts()[0]
  if (!context) throw new Error('No default CDP context')
  const result = await (async () => { ${body} })()
  process.stdout.write(JSON.stringify(result), () => process.exit(0))
} catch (error) {
  console.error(error)
  process.exit(1)
}
`
  const { stdout } = await execFileAsync(
    process.env.CLAUDE_CHROME_NODE_EXECUTABLE ?? 'node',
    ['--input-type=module', '--eval', script],
    { cwd: process.cwd(), timeout: 20_000 },
  )
  return JSON.parse(stdout) as T
}

function inspectFakeChrome(endpoint: string): Promise<FakeChromeState> {
  return runNodeCdp<FakeChromeState>(endpoint, `
    return {
      contextCount: browser.contexts().length,
      pages: await Promise.all(context.pages().map(async page => ({
        url: page.url(),
        title: await page.title(),
      }))),
      cookies: (await context.cookies()).map(cookie => ({
        name: cookie.name,
        value: cookie.value,
      })),
    }
  `)
}

function chromeContext(
  endpoint: string,
  overrides?: Partial<OpenChromeContext>,
): OpenChromeContext {
  return {
    kind: 'chrome-cdp',
    serverName: 'Open Chrome test',
    logger: {
      silly() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    cdpEndpoint: endpoint,
    cdpTimeoutMs: 5_000,
    initialPermissionMode: 'ask',
    onToolCallDisconnected: () => 'test CDP disconnected; tabs preserved',
    trackEvent() {},
    ...overrides,
  }
}

describe('open Chrome configuration and endpoint safety', () => {
  test('keeps isolated and chrome-cdp Playwright configs separate', () => {
    expect(
      createIsolatedBrowserConfig({ allowedOrigins: ['https://example.com'] }),
    ).toEqual({
      browser: { isolated: true, launchOptions: { headless: true } },
      network: { allowedOrigins: ['https://example.com'] },
    })
    const context = chromeContext('http://127.0.0.1:9222', {
      cdpTimeoutMs: 1234,
      allowedOrigins: ['http://127.0.0.1:*'],
      initialPermissionMode: 'follow_a_plan',
    })
    expect(createOpenChromeConfig(context)).toEqual({
      browser: {
        browserName: 'chromium',
        isolated: false,
        cdpEndpoint: 'http://127.0.0.1:9222',
        cdpTimeout: 1234,
      },
      network: { allowedOrigins: ['http://127.0.0.1:*'] },
      timeouts: { idle: 0 },
    })
  })

  test('createChromeContext consumes endpoint, timeout, origins, and permission', () => {
    const context = createChromeContext({
      CLAUDE_CHROME_CDP_ENDPOINT: 'http://127.0.0.1:9333',
      CLAUDE_CHROME_CDP_TIMEOUT_MS: '2345',
      CLAUDE_CHROME_ALLOWED_ORIGINS: 'https://example.com, http://127.0.0.1:*',
      CLAUDE_CHROME_PERMISSION_MODE: 'skip_all_permission_checks',
    })
    expect(context).toMatchObject({
      kind: 'chrome-cdp',
      cdpEndpoint: 'http://127.0.0.1:9333',
      cdpTimeoutMs: 2345,
      allowedOrigins: ['https://example.com', 'http://127.0.0.1:*'],
      initialPermissionMode: 'skip_all_permission_checks',
    })
    expect('socketPath' in context).toBe(false)
    expect('bridgeConfig' in context).toBe(false)
  })

  test('accepts only explicit loopback CDP URLs without credentials', () => {
    expect(assertLoopbackCdpEndpoint('http://127.0.0.1:9222')).toContain('9222')
    expect(assertLoopbackCdpEndpoint('ws://[::1]:9222/devtools/browser/id')).toContain('devtools')
    for (const endpoint of [
      'not a URL',
      'http://localhost:9222',
      'http://0.0.0.0:9222',
      'http://192.168.1.2:9222',
      'https://example.com/cdp',
      'http://user:pass@127.0.0.1:9222',
      'http://127.0.0.1:9222/?access_token=secret',
      'file:///tmp/chrome',
    ]) {
      expect(() => assertLoopbackCdpEndpoint(endpoint)).toThrow()
    }
  })

  test('explicitly rejects private extension pairing configuration', () => {
    const context = chromeContext('http://127.0.0.1:9222') as OpenChromeContext & {
      socketPath?: string
    }
    context.socketPath = '/tmp/private-extension.sock'
    expect(() => createOpenChromeConfig(context)).toThrow(
      'Open CDP does not support private extension pairing',
    )
  })

  test('a missing CDP service fails without isolated fallback and can retry', async () => {
    const port = await unusedPort()
    const context = chromeContext(`http://127.0.0.1:${port}`, {
      cdpTimeoutMs: 200,
    })
    await expect(getOpenChromeClient(context)).rejects.toThrow(
      'no isolated browser fallback was started',
    )

    const { endpoint } = await startFakeChromeCdp()
    const client = await getOpenChromeClient(chromeContext(endpoint))
    expect(client).toBeDefined()
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
  }, 30_000)
})

describe('open Chrome CDP lifecycle and tools', () => {
  test('uses independent clients and cleanup for isolated and real Chrome', async () => {
    const { endpoint } = await startFakeChromeCdp()
    const context = chromeContext(endpoint)
    const rootsBefore = await snapshotIsolatedBrowserRoots()
    const [isolated, chrome, concurrentChrome] = await Promise.all([
      getOpenBrowserClient(),
      getOpenChromeClient(context),
      getOpenChromeClient(context),
    ])
    expect(chrome).toBe(concurrentChrome)
    expect(chrome).not.toBe(isolated)
    expect((await listBrowserTools()).length).toBeGreaterThan(0)
    const navigated = await WebBrowserTool.call(
      { action: 'browser_navigate', arguments: { url: 'about:blank' } },
      {} as ToolUseContext,
    )
    expect(navigated.data.isError).not.toBe(true)
    const isolatedRoot = await findNewIsolatedBrowserRoot(rootsBefore)

    await Promise.all([closeOpenBrowserClient(), closeOpenBrowserClient()])
    await closeOpenBrowserClient()
    await expectIsolatedBrowserRootExited(isolatedRoot)
    expect(await getOpenChromeClient(context)).toBe(chrome)
    expect((await listOpenChromeTools(context)).length).toBeGreaterThan(0)

    await closeOpenChromeClient()
    const rootsBeforeReopen = await snapshotIsolatedBrowserRoots()
    const nextIsolated = await getOpenBrowserClient()
    expect(nextIsolated).not.toBe(isolated)
    expect((await listBrowserTools()).length).toBeGreaterThan(0)
    const reopened = await WebBrowserTool.call(
      { action: 'browser_navigate', arguments: { url: 'about:blank' } },
      {} as ToolUseContext,
    )
    expect(reopened.data.isError).not.toBe(true)
    const reopenedRoot = await findNewIsolatedBrowserRoot(rootsBeforeReopen)
    if (isolatedRoot && reopenedRoot) {
      expect(isolatedBrowserRootKey(reopenedRoot)).not.toBe(
        isolatedBrowserRootKey(isolatedRoot),
      )
    }
    await nextIsolated.close()
    await closeOpenBrowserClient()
    await expectIsolatedBrowserRootExited(reopenedRoot)
  }, 60_000)

  test('uses the shared CDP client in the production MCP wrapper and consumes skip permission', async () => {
    const { endpoint } = await startFakeChromeCdp()
    chromeMcpConfig = {
      type: 'stdio',
      command: 'not-spawned-for-in-process-chrome',
      args: [],
      scope: 'dynamic',
      env: {
        CLAUDE_CHROME_CDP_ENDPOINT: endpoint,
        CLAUDE_CHROME_CDP_TIMEOUT_MS: '5000',
        CLAUDE_CHROME_PERMISSION_MODE: 'skip_all_permission_checks',
      },
    }
    const connection = await connectToServer(
      'claude-in-chrome',
      chromeMcpConfig,
    )
    expect(connection.type).toBe('connected')
    if (connection.type !== 'connected') throw new Error('Chrome MCP did not connect')
    expect(connection.client).toBe(
      await getOpenChromeClient(chromeContext(endpoint)),
    )
    const tools = await fetchToolsForClient(connection)
    expect(tools.some(tool => tool.name.endsWith('browser_close'))).toBe(false)
    const navigate = tools.find(tool => tool.name.endsWith('browser_navigate'))
    expect(navigate).toBeDefined()
    expect(await navigate!.description()).toContain('Real Chrome over public CDP')
    const permission = await navigate!.checkPermissions({}, {} as ToolUseContext)
    expect(permission.behavior).toBe('allow')
  }, 60_000)

  test('preserves the default context, existing tabs, and cookies across detach/reconnect', async () => {
    await startFixture()
    const { endpoint } = await startFakeChromeCdp()
    const fakePid = fakeChild?.pid
    expect(fakePid).toBeDefined()
    const expectFakeChromeAlive = () => {
      expect(fakeChild?.pid).toBe(fakePid)
      expect(process.kill(fakePid!, 0)).toBe(true)
    }
    expectFakeChromeAlive()
    await runNodeCdp(endpoint, `
      for (const page of context.pages()) await page.close()
      const first = await context.newPage()
      await first.goto(${JSON.stringify(`${baseUrl}/first`)})
      const second = await context.newPage()
      await second.goto(${JSON.stringify(`${baseUrl}/second`)})
      await context.addCookies([
        { name: 'open_cdp_test', value: 'persisted', url: ${JSON.stringify(baseUrl)} },
      ])
      return true
    `)

    const events: Array<{ name: string; metadata?: Record<string, unknown> }> = []
    const context = chromeContext(endpoint, {
      allowedOrigins: [baseUrl],
      initialPermissionMode: 'follow_a_plan',
      trackEvent: (name, metadata) => events.push({ name, metadata }),
    })
    const tools = await listOpenChromeTools(context)
    expect(tools.some(tool => tool.name === 'browser_close')).toBe(false)
    expect(tools.every(tool => tool.description?.includes('Real Chrome over public CDP'))).toBe(true)
    expect(events).toContainEqual({
      name: 'open_chrome_connection',
      metadata: {
        backend: 'chrome-cdp',
        status: 'connecting',
        permission_mode: 'follow_a_plan',
        origins_restricted: true,
      },
    })

    const initialState = await inspectFakeChrome(endpoint)
    expect(initialState.pages).toHaveLength(2)
    const listed = await callOpenChromeTool(context, 'browser_tabs', { action: 'list' })
    expect(listed.isError).not.toBe(true)
    expect(JSON.stringify(listed.content)).toContain('First CDP Page')
    expect(JSON.stringify(listed.content)).toContain('Second CDP Page')
    const attachedState = await inspectFakeChrome(endpoint)
    expect(attachedState.pages.map(page => page.url)).toEqual(
      initialState.pages.map(page => page.url),
    )
    expect(attachedState.contextCount).toBe(1)
    expect(attachedState.cookies).toContainEqual({
      name: 'open_cdp_test',
      value: 'persisted',
    })

    const selected = await callOpenChromeTool(context, 'browser_tabs', {
      action: 'select',
      index: 0,
    })
    expect(selected.isError).not.toBe(true)
    const snapshot = await callOpenChromeTool(context, 'browser_snapshot', {})
    expect(JSON.stringify(snapshot.content)).toMatch(
      /First existing content|Second existing content/,
    )

    const created = await callOpenChromeTool(context, 'browser_tabs', {
      action: 'new',
      url: `${baseUrl}/second`,
    })
    expect(created.isError).not.toBe(true)
    expect((await inspectFakeChrome(endpoint)).pages).toHaveLength(3)

    const navigated = await callOpenChromeTool(context, 'browser_navigate', {
      url: `${baseUrl}/first`,
    })
    expect(navigated.isError).not.toBe(true)
    expect(JSON.stringify(navigated.content)).toContain('First CDP Page')
    const screenshot = await callOpenChromeTool(context, 'browser_take_screenshot', {})
    expect(screenshot.isError).not.toBe(true)
    expect(JSON.stringify(screenshot.content)).toContain('image')
    await callOpenChromeTool(context, 'browser_evaluate', {
      function: "() => console.log('open-cdp-console-test')",
    })
    const consoleMessages = await callOpenChromeTool(
      context,
      'browser_console_messages',
      {},
    )
    expect(consoleMessages.isError).not.toBe(true)
    expect(JSON.stringify(consoleMessages.content)).toContain(
      'open-cdp-console-test',
    )

    const closed = await callOpenChromeTool(context, 'browser_tabs', {
      action: 'close',
    })
    expect(closed.isError).not.toBe(true)
    expect((await inspectFakeChrome(endpoint)).pages).toHaveLength(2)

    const badTab = await callOpenChromeTool(context, 'browser_tabs', {
      action: 'select',
      index: 99,
    })
    expect(badTab.isError).toBe(true)
    expect(JSON.stringify(badTab.content)).toContain('Tab 99 not found')
    const closeBrowser = await callOpenChromeTool(context, 'browser_close', {})
    expect(closeBrowser.isError).toBe(true)
    expect((await inspectFakeChrome(endpoint)).pages).toHaveLength(2)
    expectFakeChromeAlive()

    await closeOpenChromeClient()
    const detachedState = await inspectFakeChrome(endpoint)
    expect(detachedState.contextCount).toBe(1)
    expect(detachedState.pages).toHaveLength(2)
    expect(detachedState.cookies).toContainEqual({
      name: 'open_cdp_test',
      value: 'persisted',
    })
    expectFakeChromeAlive()

    const reconnected = await callOpenChromeTool(context, 'browser_tabs', { action: 'list' })
    expect(reconnected.isError).not.toBe(true)
    expect(JSON.stringify(reconnected.content)).toContain('First CDP Page')
    expect(JSON.stringify(reconnected.content)).toContain('Second CDP Page')
    expect((await inspectFakeChrome(endpoint)).pages).toHaveLength(2)
    expectFakeChromeAlive()

    const denied = await callOpenChromeTool(context, 'browser_navigate', {
      url: `http://localhost:${new URL(baseUrl).port}/first`,
    })
    expect(denied.isError).toBe(true)
  }, 60_000)
})

describe('open Computer Use and Browser backends', () => {
  test('enumerates real Zavora tool schemas and blocks denied actions', async () => {
    const tools = await listOpenComputerUseTools()
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.some(tool => tool.name === 'screenshot')).toBe(true)
    expect(tools[0]?.inputSchema).toBeDefined()

    const dispatch = bindZavoraSessionContext({
      getAllowedApps: () => [],
      getGrantFlags: () => ({
        clipboardRead: false,
        clipboardWrite: false,
        systemKeyCombos: false,
      }),
      checkCuLock: async () => ({ holder: 'self', isSelf: true }),
      formatLockHeldMessage: () => 'locked',
      onPermissionRequest: async () => ({
        granted: [],
        denied: [{ bundleId: 'test', reason: 'user_denied' }],
        flags: {
          clipboardRead: false,
          clipboardWrite: false,
          systemKeyCombos: false,
        },
      }),
    } as never)
    const result = await dispatch('click', { coordinate: [1, 1], target_app: 'test' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('permission denied')
  }, 30_000)

  test('navigates a real isolated browser to a local page', async () => {
    await startFixture()
    const rootsBefore = await snapshotIsolatedBrowserRoots()
    const tools = await listBrowserTools()
    expect(tools.some(tool => tool.name === 'browser_navigate')).toBe(true)
    const result = await WebBrowserTool.call(
      { action: 'browser_navigate', arguments: { url: baseUrl } },
      {} as ToolUseContext,
    )
    expect(JSON.stringify(result.data.content)).toContain('First CDP Page')
    const isolatedRoot = await findNewIsolatedBrowserRoot(rootsBefore)
    const snapshot = await WebBrowserTool.call(
      { action: 'browser_snapshot', arguments: {} },
      {} as ToolUseContext,
    )
    expect(JSON.stringify(snapshot.data.content)).toContain('First existing content')
    const failure = await WebBrowserTool.call(
      { action: 'browser_tabs', arguments: { action: 'select', index: 99 } },
      {} as ToolUseContext,
    )
    expect(failure.data.isError).toBe(true)
    const closed = await WebBrowserTool.call(
      { action: 'browser_close', arguments: {} },
      {} as ToolUseContext,
    )
    expect(closed.data.isError).not.toBe(true)
    await expectIsolatedBrowserRootExited(isolatedRoot)
  }, 60_000)
})

// Opt-in only: this attaches to an already-running, user-approved dedicated
// Google Chrome instance. It never launches Chrome and only detaches MCP.
const liveChromeTest =
  process.env.CLAUDE_CHROME_RUN_LIVE_TEST === '1' &&
  process.env.CLAUDE_CHROME_LIVE_CDP_ENDPOINT
    ? test
    : test.skip

liveChromeTest('live dedicated real Chrome retains existing tabs (opt-in)', async () => {
  const endpoint = process.env.CLAUDE_CHROME_LIVE_CDP_ENDPOINT!
  const version = await (await fetch(new URL('/json/version', endpoint))).json() as {
    Browser?: string
  }
  expect(version.Browser).toMatch(/Chrome\//)
  const context = chromeContext(endpoint)
  const before = await callOpenChromeTool(context, 'browser_tabs', { action: 'list' })
  expect(before.isError).not.toBe(true)
  const snapshot = await callOpenChromeTool(context, 'browser_snapshot', {})
  expect(snapshot.isError).not.toBe(true)
  await closeOpenChromeClient()
  const after = await callOpenChromeTool(context, 'browser_tabs', { action: 'list' })
  expect(after.isError).not.toBe(true)
  expect(JSON.stringify(after.content)).toBe(JSON.stringify(before.content))
}, 30_000)
