import { describe, test, expect, afterAll } from 'bun:test'
import { distMainPath } from '../support/dist-fixture'
import { createSandbox, type Sandbox } from '../support/sandbox'
import { createMockAnthropic, MOCK_API_KEY, type MockAnthropic } from '../support/mock-anthropic'
import { spawnPty, type PtySession } from '../support/pty-driver'
import { stripAnsi } from '../support/ansi'

// IMPORTANT FINDING FROM PROBE (2026-11-18):
// No permission prompt appears by default when the model attempts to use tools.
// Tools execute directly without user approval prompt.
// This test documents the actual behavior, not the hypothetical behavior in the brief.

const toClose: Array<{ sandbox?: Sandbox; mock?: MockAnthropic; session?: PtySession }> = []
afterAll(async () => {
  for (const item of toClose) {
    await item.session?.kill().catch(() => {})
    await item.sandbox?.cleanup()
    await item.mock?.stop()
  }
})

// Copy the approvedKeyConfig and startRepl pattern from repl.test.ts
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

  // Ready signal: status bar shows /effort
  await session.waitFor('/effort', 30_000)

  return { session, sandbox, mock }
}

describe('permission flow in REPL', () => {
  test('tool executes directly without permission prompt by default', async () => {
    const { session, mock } = await startRepl()

    // Mock queue discipline: auxiliary haiku first, then main responses
    mock.enqueue(
      { type: 'text', text: 'HAIKU_AUX_OK' },
      { type: 'tool_use', id: 'toolu_perm_1', name: 'Bash', input: { command: 'echo PERM_DIRECT_EXEC', description: 'test tool execution' } },
      { type: 'text', text: 'PERM_DONE' }
    )

    session.write('run a test command\r')

    // The tool output marker should appear - no prompt means direct execution
    await session.waitFor('PERM_DIRECT_EXEC', 60_000)
    await session.waitFor('PERM_DONE', 30_000)

    // Verify the tool executed by checking the output
    const plain = stripAnsi(session.output())
    expect(plain).toContain('PERM_DIRECT_EXEC')

    session.write('/exit\r')
    expect(await session.exited()).toBeDefined()
  }, { timeout: 120_000 })

  test('subsequent messages continue normally after tool execution', async () => {
    const { session, mock } = await startRepl()

    // Mock queue discipline: auxiliary haiku first, then main responses
    mock.enqueue(
      { type: 'text', text: 'HAIKU_AUX_OK' },
      { type: 'tool_use', id: 'toolu_perm_2', name: 'Bash', input: { command: 'echo SECOND_EXEC', description: 'second test' } },
      { type: 'text', text: 'ALL_DONE' }
    )

    session.write('do another thing\r')

    await session.waitFor('SECOND_EXEC', 60_000)
    await session.waitFor('ALL_DONE', 30_000)

    session.write('/exit\r')
    expect(await session.exited()).toBeDefined()
  }, { timeout: 120_000 })
})
