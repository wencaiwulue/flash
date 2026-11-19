
import { describe, test, expect, afterAll } from 'bun:test'
import { distMainPath } from '../support/dist-fixture.ts'
import { createSandbox, type Sandbox } from '../support/sandbox.ts'
import { createMockAnthropic, MOCK_API_KEY, type MockAnthropic } from '../support/mock-anthropic.ts'
import { spawnPty, type PtySession } from '../support/pty-driver.ts'

const toClose: Array<{ sandbox?: Sandbox; mock?: MockAnthropic; session?: PtySession }> = []
afterAll(async () => {
  for (const item of toClose) {
    await item.session?.kill().catch(() => {})
    await item.sandbox?.cleanup()
    await item.mock?.stop()
  }
})

// 预置 customApiKeyResponses（normalizeApiKeyForConfig = apiKey.slice(-20)，'mock-key' 全长即截断值，
// 证据：src/utils/authPortable.ts:17、src/utils/config.ts:1107、src/interactiveHelpers.tsx:283）
// 使 "Do you want to use this API key?" 对话框不再出现，REPL 启动完全确定。
function approvedKeyConfig(): Record<string, unknown> {
  return { customApiKeyResponses: { approved: [MOCK_API_KEY] } }
}

async function startRepl(): Promise<{ session: PtySession; sandbox: Sandbox; mock: MockAnthropic }> {
  const mock = await createMockAnthropic()
  const sandbox = await createSandbox({ globalConfig: approvedKeyConfig() })
  const session = await spawnPty({
    cmd: [process.execPath, await distMainPath()],
    cwd: sandbox.project,
    env: { ...sandbox.env, ANTHROPIC_API_KEY: MOCK_API_KEY, ANTHROPIC_BASE_URL: mock.url },
  })
  toClose.push({ session, sandbox, mock })

  // Ready 信号：状态栏 '/effort' 只在活跃 REPL 渲染（对话框/启动屏没有它）。
  await session.waitFor('/effort', 30_000)

  return { session, sandbox, mock }
}

describe('REPL interaction', () => {
  test('submits input, renders scripted reply, exits via /exit', { timeout: 90_000 }, async () => {
    const { session, mock } = await startRepl()

    // 就绪后再入队。注意：用户提示会先触发一次 haiku 辅助请求（如话题命名），
    // 再发主对话请求 —— 队首必须留给辅助调用（实测：hello 后共 3 个 /v1/messages 请求）。
    mock.enqueue({ type: 'text', text: 'HAIKU_AUX_OK' }, { type: 'text', text: 'REPL_REPLY_2e8b' })
    session.write('hello\r')
    await session.waitFor('REPL_REPLY_2e8b', 30_000)
    expect(mock.requests.some(r => r.path === '/v1/messages')).toBe(true)

    session.write('/exit\r')
    const exitCode = await session.exited()
    expect([0, 130, -1]).toContain(exitCode)
  })

  test('unknown slash command shows error and process stays alive', { timeout: 90_000 }, async () => {
    const { session } = await startRepl()

    session.write('/definitely-not-a-valid-command-xyz\r')
    await session.waitFor('Unknown skill:', 15_000)

    // 进程存活：双 Ctrl+C 干净退出
    session.write('\x03')
    await new Promise(r => setTimeout(r, 300))
    session.write('\x03')

    const exitCode = await session.exited()
    expect(exitCode).toBeDefined()
    expect([0, 130, -1]).toContain(exitCode)
  })

  test('/exit command exits the REPL', { timeout: 90_000 }, async () => {
    const { session } = await startRepl()

    session.write('/exit\r')
    const exitCode = await session.exited()
    expect(exitCode).toBeDefined()
    expect([0, 130, -1]).toContain(exitCode)
  })

  test('double Ctrl+C exits REPL', { timeout: 90_000 }, async () => {
    const { session } = await startRepl()

    session.write('\x03')
    await new Promise(r => setTimeout(r, 300))
    session.write('\x03')

    const code = await session.exited()
    expect([0, 130, -1]).toContain(code)
  })
})
