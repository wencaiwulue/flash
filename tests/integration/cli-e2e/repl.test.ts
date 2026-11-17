
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

async function startRepl(): Promise<{ session: PtySession; sandbox: Sandbox; mock: MockAnthropic }> {
  const mock = await createMockAnthropic()
  const sandbox = await createSandbox()
  const session = await spawnPty({
    cmd: [process.execPath, await distMainPath()],
    cwd: sandbox.project,
    env: { ...sandbox.env, ANTHROPIC_API_KEY: MOCK_API_KEY, ANTHROPIC_BASE_URL: mock.url },
  })
  toClose.push({ session, sandbox, mock })

  // Handle API key dialog - evidence-based: wait for dialog elements first
  try {
    await session.waitFor(/Detected|API key|Yes.*No/, 10000)
    // Dialog confirmed present - select Yes (up arrow once from default No) and confirm with two writes
    session.write('\x1b[A')
    await new Promise(r => setTimeout(r, 300))
    session.write('\r')
    await new Promise(r => setTimeout(r, 500))
  } catch {
    // No dialog appeared, continue
  }

  // Wait for the prompt - deterministic readiness signal
  await session.waitFor(/❯/, 30000)

  return { session, sandbox, mock }
}

describe('REPL interaction', () => {
  test('unknown slash command shows error and process stays alive', { timeout: 90_000 }, async () => {
    const { session } = await startRepl()

    // Send unknown command
    session.write('/definitely-not-a-valid-command-xyz\r')

    // Wait for the real error message (captured via probe)
    await session.waitFor('Unknown skill:', 15000)

    // Verify process is still alive by exiting cleanly with double Ctrl+C
    session.write('\x03')
    await new Promise(r => setTimeout(r, 300))
    session.write('\x03')

    const exitCode = await session.exited()
    expect(exitCode).toBeDefined()
    expect([0, 130, -1]).toContain(exitCode)
  })

  test('/exit command exits the REPL', { timeout: 90_000 }, async () => {
    const { session } = await startRepl()

    // Send /exit
    session.write('/exit\r')

    // Verify it exits (actual behavior captured via probe)
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
