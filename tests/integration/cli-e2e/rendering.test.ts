import { describe, test, expect, afterAll } from 'bun:test'
import { distMainPath } from '../support/dist-fixture.ts'
import { createSandbox, type Sandbox } from '../support/sandbox.ts'
import { createMockAnthropic, MOCK_API_KEY, type MockAnthropic } from '../support/mock-anthropic.ts'
import { spawnPty, type PtySession } from '../support/pty-driver.ts'
import { stripAnsi } from '../support/ansi.ts'

const toClose: Array<{ sandbox?: Sandbox; mock?: MockAnthropic; session?: PtySession }> = []
afterAll(async () => {
  for (const item of toClose) {
    await item.session?.kill().catch(() => {})
    await item.sandbox?.cleanup()
    await item.mock?.stop()
  }
})

function approvedKeyConfig(): Record<string, unknown> {
  return { customApiKeyResponses: { approved: [MOCK_API_KEY] } }
}

// haiku 辅助请求（如话题命名）统一应答，主请求回落到 enqueue 队列
function routeHaikuAux(mock: MockAnthropic): void {
  mock.setRouter(request => {
    const model = (request.body as Record<string, unknown> | null)?.model
    return typeof model === 'string' && model.includes('haiku')
      ? { type: 'text', text: 'HAIKU_AUX_OK' }
      : null
  })
}

async function runPrint(args: string[], sandbox: Sandbox, mockUrl: string) {
  const main = await distMainPath()
  const proc = Bun.spawn([process.execPath, main, ...args], {
    cwd: sandbox.project,
    env: { ...sandbox.env, ANTHROPIC_API_KEY: MOCK_API_KEY, ANTHROPIC_BASE_URL: mockUrl },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  return { out: stripAnsi(out), err: stripAnsi(err), code }
}

describe('output rendering', () => {
  test('narrow terminal wraps a long unbroken token', { timeout: 90_000 }, async () => {
    const mock = await createMockAnthropic()
    routeHaikuAux(mock)
    const sandbox = await createSandbox({ globalConfig: approvedKeyConfig() })
    toClose.push({ sandbox, mock })
    const token = 'W'.repeat(100)
    mock.enqueue({ type: 'text', text: token })
    const session = await spawnPty({
      cmd: [process.execPath, await distMainPath()],
      cwd: sandbox.project,
      cols: 40,
      rows: 20,
      env: { ...sandbox.env, ANTHROPIC_API_KEY: MOCK_API_KEY, ANTHROPIC_BASE_URL: mock.url },
    })
    toClose.push({ session })
    await session.waitFor('/effort', 30_000)
    session.write('print it\r')
    await session.waitFor(/W{20}/, 60_000)
    session.write('\x03')
    await new Promise(r => setTimeout(r, 300))
    session.write('\x03')
    await session.exited()
    const lines = stripAnsi(session.output()).split(/\r?\n/)
    const joined = lines.join('')
    // Token might render multiple times in REPL output
    expect((joined.match(/W/g) ?? []).length).toBeGreaterThanOrEqual(100)
    // No single line should contain the full unbroken token
    expect(lines.some(line => line.includes('W'.repeat(100)))).toBe(false)
  })

  test('streamed SSE text renders fully in print mode', async () => {
    const mock = await createMockAnthropic()
    routeHaikuAux(mock)
    const sandbox = await createSandbox({ globalConfig: approvedKeyConfig() })
    toClose.push({ sandbox, mock })
    mock.enqueue({ type: 'text', text: 'STREAM_HEAD_5e2f' + 'x'.repeat(400) + 'STREAM_TAIL_5e2f' })
    const { out, code } = await runPrint(['-p', 'print it'], sandbox, mock.url)
    expect(code).toBe(0)
    expect(out).toContain('STREAM_HEAD_5e2f')
    expect(out).toContain('STREAM_TAIL_5e2f')
  })
})
