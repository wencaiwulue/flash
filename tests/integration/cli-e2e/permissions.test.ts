
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
// This test file focuses on the reliable, hermetic parts of the behavior. The full
// interactive approve/reject flow is verified through manual probes and documented
// in the comments above.

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

    mock.enqueue(
      { type: 'text', text: 'HAIKU_AUX_OK' },
      { type: 'tool_use', id: 'toolu_echo', name: 'Bash', input: { command: 'echo SAFE_AUTO_EXEC', description: 'safe read-only command' } },
      { type: 'text', text: 'SAFE_DONE' }
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
})
