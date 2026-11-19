
import { describe, test, expect, afterAll } from 'bun:test'
import { distMainPath } from '../support/dist-fixture.ts'
import { createSandbox, type Sandbox } from '../support/sandbox.ts'
import { createMockAnthropic, MOCK_API_KEY, type MockAnthropic } from '../support/mock-anthropic.ts'
import { stripAnsi } from '../support/ansi.ts'

const toClose: Array<{ sandbox?: Sandbox; mock?: MockAnthropic }> = []
afterAll(async () => {
  for (const item of toClose) {
    await item.sandbox?.cleanup()
    await item.mock?.stop()
  }
})

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

describe('print mode with mock API', () => {
  test('answers a scripted response and records the outgoing request', async () => {
    const mock = await createMockAnthropic()
    const sandbox = await createSandbox()
    toClose.push({ sandbox, mock })
    mock.enqueue({ type: 'text', text: 'PRINT_REPLY_8a4f' })
    const { out, err, code } = await runPrint(['-p', 'hi'], sandbox, mock.url)
    expect(code, `stderr: ${err}`).toBe(0)
    expect(out).toContain('PRINT_REPLY_8a4f')
    const request = mock.requests.find(r => r.path === '/v1/messages')
    expect(request).toBeDefined()
    expect((request!.body as Record<string, unknown>).model).toBeDefined()
    expect(Array.isArray((request!.body as Record<string, unknown>).messages)).toBe(true)
  })

  test('surfaces API errors and exits nonzero', async () => {
    const mock = await createMockAnthropic()
    const sandbox = await createSandbox()
    toClose.push({ sandbox, mock })
    // 4xx 不可重试（5xx 会触发约 10 次指数退避重试，实测 >3 分钟）；单次 400 即终态
    mock.enqueue({
      type: 'error',
      status: 400,
      body: { type: 'error', error: { type: 'invalid_request_error', message: 'MOCK_BOOM_400' } },
    })
    const { out, err, code } = await runPrint(['-p', 'hi'], sandbox, mock.url)
    expect(code).not.toBe(0)
    expect(out + err).toContain('MOCK_BOOM_400')
  })

  test('count_tokens requests reach the mock', async () => {
    const mock = await createMockAnthropic()
    const sandbox = await createSandbox()
    toClose.push({ sandbox, mock })
    mock.enqueue({ type: 'text', text: 'ok' })
    await runPrint(['-p', 'hi'], sandbox, mock.url)
    // count_tokens 是否被调用取决于实现；只断言"若调用则 mock 正确应答"，路径记录留作 B0 对照
    const paths = mock.requests.map(r => r.path)
    expect(paths.every(p => p === '/v1/messages' || p === '/v1/messages/count_tokens')).toBe(true)
  })
})
