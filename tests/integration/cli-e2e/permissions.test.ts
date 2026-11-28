
import { describe, test, expect, afterAll } from 'bun:test'
import { distMainPath } from '../support/dist-fixture.ts'
import { createSandbox, type Sandbox } from '../support/sandbox.ts'
import { createMockAnthropic, MOCK_API_KEY, type MockAnthropic } from '../support/mock-anthropic.ts'
import { spawnPty, type PtySession } from '../support/pty-driver.ts'
import { stripAnsi } from '../support/ansi.ts'

// DISCOVERY FROM PROBE (2026-11-18):
// - Safe read-only commands like `echo` auto-execute without prompt (bash safety classifier)
// - Unsafe/write commands like `touch` show a permission prompt: "Do you want to proceed?"
// - Prompt options: 1. Yes, 2. Yes always..., 3. No
// - Approve: press '1' + Enter → tool executes
// - Reject: press '3' + Enter → tool doesn't execute
//
// 队列确定性：haiku 辅助请求是否发生不确定（实测时有时无），主请求会消费队首响应。
// 用 setRouter 按 body.model 路由：model 含 'haiku' → 辅助文本；其余 → 按序消费主队列。

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

async function startRepl(): Promise<{ session: PtySession; sandbox: Sandbox; mock: MockAnthropic }> {
  const mock = await createMockAnthropic()
  const sandbox = await createSandbox({ globalConfig: approvedKeyConfig() })
  const session = await spawnPty({
    cmd: [process.execPath, await distMainPath()],
    cwd: sandbox.project,
    env: { ...sandbox.env, ANTHROPIC_API_KEY: MOCK_API_KEY, ANTHROPIC_BASE_URL: mock.url },
  })
  toClose.push({ session, sandbox, mock })

  await session.waitFor('/effort', 30_000)

  return { session, sandbox, mock }
}

describe('permission flow in REPL', () => {
  test('safe read-only commands auto-execute without permission prompt', async () => {
    const { session, mock } = await startRepl()
    routeHaikuAux(mock)
    mock.enqueue(
      { type: 'tool_use', id: 'toolu_echo', name: 'Bash', input: { command: 'echo SAFE_AUTO_EXEC', description: 'safe read-only command' } },
      { type: 'text', text: 'SAFE_DONE' },
    )

    session.write('run a safe command\r')

    await session.waitFor('SAFE_AUTO_EXEC', 30_000)
    await session.waitFor('SAFE_DONE', 30_000)

    const plainNoSpaces = stripAnsi(session.output()).replace(/\s+/g, '')
    expect(plainNoSpaces).toContain('SAFE_AUTO_EXEC')
    expect(plainNoSpaces).not.toContain('Doyouwanttoproceed')

    session.write('/exit\r')
    expect(await session.exited()).toBeDefined()
  }, { timeout: 120_000 })

  test('unsafe write commands show the permission prompt', async () => {
    const { session, mock } = await startRepl()
    routeHaikuAux(mock)
    mock.enqueue(
      { type: 'tool_use', id: 'toolu_perm_p', name: 'Bash', input: { command: 'touch permfile.txt', description: 'create a file' } },
    )

    session.write('create a test file\r')

    // 权限提示锚点：'proceed?' 无内部转义，原始缓冲可直接匹配
    await session.waitFor('proceed?', 30_000)

    const plainNoSpaces = stripAnsi(session.output()).replace(/\s+/g, '')
    expect(plainNoSpaces).toContain('Doyouwanttoproceed')
    expect(plainNoSpaces).toContain('1.Yes')
    expect(plainNoSpaces).toContain('3.No')

    // 权限对话框/interrupt 输入态会吞掉 '/exit' 和 SIGINT（repl 测试已覆盖正常退出路径）；
    // 这里只验证行为断言，会话用 kill 收尾
    await session.kill()
  }, { timeout: 120_000 })

  test('approving the prompt executes the tool', async () => {
    const { session, mock, sandbox } = await startRepl()
    routeHaikuAux(mock)
    mock.enqueue(
      { type: 'tool_use', id: 'toolu_perm_a', name: 'Bash', input: { command: 'echo APPROVED_ECHO_3b7d > approved.txt', description: 'create a file' } },
      { type: 'text', text: 'APPROVED_DONE_3b7d' },
    )

    session.write('create the approved file\r')
    await session.waitFor('proceed?', 30_000)

    // 批准：'1' 与回车分两次写入（合并写入的第二个键会被 Ink 重渲染吞掉）
    session.write('1')
    await new Promise(r => setTimeout(r, 300))
    session.write('\r')

    await session.waitFor('APPROVED_DONE_3b7d', 30_000)
    const fileContent = await Bun.file(sandbox.project + '/approved.txt').text().catch(() => '')
    expect(fileContent.trim()).toBe('APPROVED_ECHO_3b7d')

    // /exit 偶发被 UI 状态吞掉导致 exited() 无限挂起（flake）；退出路径已由 repl 测试覆盖
    await session.kill()
  }, { timeout: 120_000 })

  test('rejecting the prompt skips execution and returns control to the user', async () => {
    const { session, mock, sandbox } = await startRepl()
    routeHaikuAux(mock)
    mock.enqueue(
      { type: 'tool_use', id: 'toolu_perm_r', name: 'Bash', input: { command: 'echo REJECTED_ECHO_4c1a > rejected.txt', description: 'create a file' } },
      { type: 'text', text: 'REJECTED_DONE_4c1a' },
    )

    session.write('create the rejected file\r')
    await session.waitFor('proceed?', 30_000)
    const requestsBeforeReject = mock.requests.filter(r => r.path === '/v1/messages').length

    // 拒绝：'3' 与回车分两次写入
    session.write('3')
    await new Promise(r => setTimeout(r, 300))
    session.write('\r')

    // 实测语义（探针证据 2026-11-18）：拒绝后 REPL 显示 "Interrupted · What should
    // Claude do instead?" 并回到输入提示符 —— 不向模型发送 is_error tool_result，
    // 也不自动发起新请求。此处按真实行为断言（与简报的上游假设不同，属快照行为发现）。
    await session.waitFor('instead?', 30_000)
    const fileExists = await Bun.file(sandbox.project + '/rejected.txt').exists()
    expect(fileExists).toBe(false)
    const requestsAfterReject = mock.requests.filter(r => r.path === '/v1/messages').length
    expect(requestsAfterReject).toBe(requestsBeforeReject)

    // 权限对话框/interrupt 输入态会吞掉 '/exit' 和 SIGINT（repl 测试已覆盖正常退出路径）；
    // 这里只验证行为断言，会话用 kill 收尾
    await session.kill()
  }, { timeout: 120_000 })
})
